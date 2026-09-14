-- Close GPX security audit findings #2/#3 without touching the Storage schema.
-- Pending reservations conservatively consume one full per-object allowance;
-- finalize then replaces the declaration with Storage's actual byte count.

begin;

alter table public.gpx_upload_admission_events
    add column if not exists track_id uuid;

create unique index if not exists gpx_upload_admission_events_track_idx
    on public.gpx_upload_admission_events(track_id)
    where track_id is not null;

-- Old pending reservations predate track_id on the ledger. Reserving a fresh
-- full allowance is intentionally conservative and makes them finalizable;
-- the earlier declaration-only ledger entry expires normally after 24 hours.
insert into public.gpx_upload_admission_events(
    user_id, track_id, compressed_size_bytes, created_at
)
select track.user_id, track.id, cfg.max_compressed_bytes, now()
  from public.user_gpx_tracks track
  cross join public.gpx_archive_config cfg
 where cfg.singleton_id = 1
   and track.status in ('pending_upload', 'cleanup_pending')
   and not exists (
       select 1
         from public.gpx_upload_admission_events event
        where event.track_id = track.id
   );

create or replace function public.enforce_gpx_reservation_budgets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.gpx_archive_config%rowtype;
    user_bytes bigint;
    tenant_bytes bigint;
    recent_user_count integer;
    recent_tenant_bytes bigint;
    pending_count integer;
begin
    perform pg_advisory_xact_lock(hashtext('gpx_tenant_budget'));
    perform pg_advisory_xact_lock(hashtext(new.user_id::text));
    select * into strict cfg
      from public.gpx_archive_config
     where singleton_id = 1;

    select coalesce(sum(
               case when status in ('pending_upload', 'cleanup_pending')
                    then cfg.max_compressed_bytes
                    else compressed_size_bytes end
           ), 0),
           count(*) filter (where status in ('pending_upload', 'cleanup_pending'))
      into user_bytes, pending_count
      from public.user_gpx_tracks
     where user_id = new.user_id
       and validation_status <> 'rejected';

    select coalesce(sum(
               case when status in ('pending_upload', 'cleanup_pending')
                    then cfg.max_compressed_bytes
                    else compressed_size_bytes end
           ), 0)
      into tenant_bytes
      from public.user_gpx_tracks
     where validation_status <> 'rejected';

    select count(*) into recent_user_count
      from public.gpx_upload_admission_events
     where user_id = new.user_id
       and created_at >= now() - interval '24 hours';

    select coalesce(sum(compressed_size_bytes), 0)
      into recent_tenant_bytes
      from public.gpx_upload_admission_events
     where created_at >= now() - interval '24 hours';

    if pending_count >= cfg.max_pending_uploads_per_user then
        raise exception 'pending GPX upload quota exceeded';
    end if;
    if recent_user_count >= cfg.max_uploads_per_user_24h then
        raise exception 'daily GPX upload quota exceeded';
    end if;
    if user_bytes + cfg.max_compressed_bytes > cfg.max_user_total_compressed_bytes then
        raise exception 'user GPX byte quota exceeded';
    end if;
    if tenant_bytes + cfg.max_compressed_bytes > cfg.max_tenant_total_compressed_bytes then
        raise exception 'tenant GPX byte budget exceeded';
    end if;
    if recent_tenant_bytes + cfg.max_compressed_bytes > cfg.max_tenant_upload_bytes_24h then
        raise exception 'tenant daily GPX ingress budget exceeded';
    end if;

    insert into public.gpx_upload_admission_events(
        user_id, track_id, compressed_size_bytes
    ) values (
        new.user_id, new.id, cfg.max_compressed_bytes
    );
    new.validation_status := 'pending';
    return new;
end;
$$;

create or replace function public.finalize_my_gpx_track(p_track_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.gpx_archive_config%rowtype;
    track public.user_gpx_tracks%rowtype;
    object_owner_id text;
    object_metadata jsonb;
    actual_size bigint;
    actual_mime text;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    perform public.require_current_contributor_access();
    perform pg_advisory_xact_lock(hashtext('gpx_tenant_budget'));
    perform pg_advisory_xact_lock(hashtext(caller_id::text));

    select * into strict cfg
      from public.gpx_archive_config
     where singleton_id = 1;
    select * into track
      from public.user_gpx_tracks
     where id = p_track_id
       and user_id = caller_id
     for update;
    if not found then
        raise exception 'GPX track reservation not found';
    end if;
    if track.status = 'ready' then
        return to_jsonb(track);
    end if;
    if track.status <> 'pending_upload' then
        raise exception 'GPX track reservation is not uploadable';
    end if;

    select owner_id, metadata
      into object_owner_id, object_metadata
      from storage.objects
     where bucket_id = 'user-gpx'
       and name = track.storage_path;
    if not found then
        raise exception 'GPX Storage object not found';
    end if;

    begin
        actual_size := (object_metadata ->> 'size')::bigint;
    exception when others then
        raise exception 'GPX Storage size metadata is invalid';
    end;
    actual_mime := lower(coalesce(object_metadata ->> 'mimetype', ''));
    if object_owner_id is distinct from caller_id::text then
        raise exception 'GPX Storage owner mismatch';
    end if;
    if actual_size is null or actual_size <= 0
       or actual_size > cfg.max_compressed_bytes then
        raise exception 'actual GPX Storage size is outside configured limits';
    end if;
    if actual_mime not in ('application/gzip', 'application/x-gzip') then
        raise exception 'GPX Storage MIME type is invalid';
    end if;

    update public.gpx_upload_admission_events
       set compressed_size_bytes = actual_size
     where track_id = track.id;
    if not found then
        raise exception 'GPX reservation budget event is missing';
    end if;

    update public.user_gpx_tracks
       set status = 'ready',
           ready_at = now(),
           compressed_size_bytes = actual_size
     where id = track.id
     returning * into track;
    return to_jsonb(track);
end;
$$;

revoke all on function public.enforce_gpx_reservation_budgets()
    from public, anon, authenticated;
grant execute on function public.enforce_gpx_reservation_budgets()
    to service_role;
revoke all on function public.finalize_my_gpx_track(uuid)
    from public, anon;
grant execute on function public.finalize_my_gpx_track(uuid)
    to authenticated, service_role;

commit;
