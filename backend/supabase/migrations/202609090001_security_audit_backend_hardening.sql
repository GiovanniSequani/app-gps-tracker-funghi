-- SEC-AUD-005/009/013/016/017 backend hardening.
-- Incremental and safe to apply with existing rows. It does not enable feature
-- switches and does not delete existing account or GPX data.

begin;

alter table public.gpx_archive_config
    add column if not exists max_user_total_compressed_bytes bigint not null default 262144000,
    add column if not exists max_tenant_total_compressed_bytes bigint not null default 5368709120,
    add column if not exists max_pending_uploads_per_user integer not null default 3,
    add column if not exists max_uploads_per_user_24h integer not null default 20,
    add column if not exists max_tenant_upload_bytes_24h bigint not null default 1073741824,
    add column if not exists validation_batch_limit integer not null default 20;

do $$
begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.gpx_archive_config'::regclass and conname = 'gpx_archive_abuse_budgets_valid') then
        alter table public.gpx_archive_config add constraint gpx_archive_abuse_budgets_valid check (
            max_user_total_compressed_bytes between max_compressed_bytes and 536870912000
            and max_tenant_total_compressed_bytes >= max_user_total_compressed_bytes
            and max_pending_uploads_per_user between 1 and 20
            and max_uploads_per_user_24h between 1 and 1000
            and max_tenant_upload_bytes_24h >= max_compressed_bytes
            and validation_batch_limit between 1 and 100
        );
    end if;
end
$$;

alter table public.user_gpx_tracks
    add column if not exists validation_status text not null default 'legacy_unverified',
    add column if not exists validated_at timestamptz,
    add column if not exists validation_attempt_count integer not null default 0,
    add column if not exists validation_claim_token uuid,
    add column if not exists validation_claimed_at timestamptz,
    add column if not exists validation_error_code text;

alter table public.user_gpx_tracks alter column validation_status set default 'pending';
update public.user_gpx_tracks
   set validation_status = 'pending'
 where status <> 'ready' and validation_status = 'legacy_unverified';

do $$
begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.user_gpx_tracks'::regclass and conname = 'user_gpx_tracks_validation_state') then
        alter table public.user_gpx_tracks add constraint user_gpx_tracks_validation_state check (
            validation_status in ('pending', 'validating', 'validated', 'rejected', 'legacy_unverified')
            and ((validation_status = 'validating' and validation_claim_token is not null and validation_claimed_at is not null)
                 or (validation_status <> 'validating' and validation_claim_token is null and validation_claimed_at is null))
            and ((validation_status = 'validated' and validated_at is not null)
                 or validation_status <> 'validated')
        );
    end if;
end
$$;

create index if not exists user_gpx_tracks_validation_dispatch_idx
    on public.user_gpx_tracks(validation_status, validation_claimed_at, ready_at);

create table if not exists public.gpx_upload_admission_events (
    id bigint generated always as identity primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    compressed_size_bytes bigint not null check (compressed_size_bytes > 0),
    created_at timestamptz not null default now()
);
create index if not exists gpx_upload_admission_events_recent_idx
    on public.gpx_upload_admission_events(created_at, user_id);
alter table public.gpx_upload_admission_events enable row level security;
revoke all on public.gpx_upload_admission_events from public, anon, authenticated;
grant all on public.gpx_upload_admission_events to service_role;

create or replace function public.enforce_gpx_reservation_budgets()
returns trigger language plpgsql security definer set search_path = '' as $$
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
    select * into strict cfg from public.gpx_archive_config where singleton_id = 1;
    select coalesce(sum(compressed_size_bytes), 0), count(*) filter (where status in ('pending_upload', 'cleanup_pending'))
      into user_bytes, pending_count from public.user_gpx_tracks
     where user_id = new.user_id and validation_status <> 'rejected';
    select coalesce(sum(compressed_size_bytes), 0) into tenant_bytes
      from public.user_gpx_tracks where validation_status <> 'rejected';
    select count(*) into recent_user_count from public.gpx_upload_admission_events
     where user_id = new.user_id and created_at >= now() - interval '24 hours';
    select coalesce(sum(compressed_size_bytes), 0) into recent_tenant_bytes
      from public.gpx_upload_admission_events where created_at >= now() - interval '24 hours';
    if pending_count >= cfg.max_pending_uploads_per_user then raise exception 'pending GPX upload quota exceeded'; end if;
    if recent_user_count >= cfg.max_uploads_per_user_24h then raise exception 'daily GPX upload quota exceeded'; end if;
    if user_bytes + new.compressed_size_bytes > cfg.max_user_total_compressed_bytes then raise exception 'user GPX byte quota exceeded'; end if;
    if tenant_bytes + new.compressed_size_bytes > cfg.max_tenant_total_compressed_bytes then raise exception 'tenant GPX byte budget exceeded'; end if;
    if recent_tenant_bytes + new.compressed_size_bytes > cfg.max_tenant_upload_bytes_24h then raise exception 'tenant daily GPX ingress budget exceeded'; end if;
    insert into public.gpx_upload_admission_events(user_id, compressed_size_bytes)
    values (new.user_id, new.compressed_size_bytes);
    new.validation_status := 'pending';
    return new;
end;
$$;

drop trigger if exists enforce_gpx_reservation_budgets on public.user_gpx_tracks;
create trigger enforce_gpx_reservation_budgets before insert on public.user_gpx_tracks
for each row execute function public.enforce_gpx_reservation_budgets();
revoke all on function public.enforce_gpx_reservation_budgets() from public, anon, authenticated;
grant execute on function public.enforce_gpx_reservation_budgets() to service_role;

create or replace function public.preview_gpx_admission()
returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
        'eligible', (select count(*) from public.user_gpx_tracks where status = 'ready' and validation_status in ('pending', 'legacy_unverified')),
        'batch_limit', validation_batch_limit
    ) from public.gpx_archive_config where singleton_id = 1
$$;

create or replace function public.claim_gpx_admission(p_owner_token uuid, p_limit integer default null)
returns table(id uuid, storage_path text, expected_sha256 text, expected_compressed_size_bytes bigint,
              max_compressed_bytes bigint, max_uncompressed_bytes bigint, claim_token uuid)
language plpgsql security definer set search_path = '' as $$
declare cfg public.gpx_archive_config%rowtype; max_claims integer;
begin
    select * into strict cfg from public.gpx_archive_config where singleton_id = 1;
    delete from public.gpx_upload_admission_events where created_at < now() - interval '30 days';
    max_claims := least(coalesce(p_limit, cfg.validation_batch_limit), cfg.validation_batch_limit);
    if max_claims < 1 then raise exception 'invalid validation claim limit'; end if;
    update public.user_gpx_tracks set validation_status = case when validated_at is null then 'legacy_unverified' else 'validated' end,
        validation_claim_token = null, validation_claimed_at = null, validation_error_code = 'claim_timeout'
     where validation_status = 'validating' and validation_claimed_at < now() - interval '30 minutes';
    return query
    with candidates as (
        select track.id from public.user_gpx_tracks track
         where track.status = 'ready' and track.validation_status in ('pending', 'legacy_unverified')
           and track.validation_attempt_count < 5
         order by track.ready_at nulls first, track.created_at
         for update skip locked limit max_claims
    ), claimed as (
        update public.user_gpx_tracks track set validation_status = 'validating',
            validation_claim_token = p_owner_token, validation_claimed_at = now(),
            validation_attempt_count = validation_attempt_count + 1
          from candidates where track.id = candidates.id
        returning track.*
    )
    select claimed.id, claimed.storage_path, claimed.content_sha256,
           claimed.compressed_size_bytes, cfg.max_compressed_bytes,
           cfg.max_uncompressed_bytes, p_owner_token from claimed;
end;
$$;

create or replace function public.complete_gpx_admission(
    p_track_id uuid, p_claim_token uuid, p_compressed_size_bytes bigint,
    p_uncompressed_size_bytes bigint, p_content_sha256 text, p_point_count integer,
    p_started_at timestamptz, p_ended_at timestamptz, p_distance_m double precision, p_bbox jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
    if p_content_sha256 !~ '^[0-9a-f]{64}$' or p_point_count <= 0
       or p_compressed_size_bytes <= 0 or p_uncompressed_size_bytes <= 0
       or not public.is_valid_gpx_bbox(p_bbox) then raise exception 'invalid server GPX measurements'; end if;
    update public.user_gpx_tracks set validation_status = 'validated', validated_at = now(),
        validation_claim_token = null, validation_claimed_at = null, validation_error_code = null,
        compressed_size_bytes = p_compressed_size_bytes, uncompressed_size_bytes = p_uncompressed_size_bytes,
        content_sha256 = p_content_sha256, point_count = p_point_count, started_at = p_started_at,
        ended_at = p_ended_at, distance_m = p_distance_m, bbox = p_bbox
     where id = p_track_id and validation_status = 'validating' and validation_claim_token = p_claim_token
       and compressed_size_bytes = p_compressed_size_bytes
       and content_sha256 = p_content_sha256
       and exists (
           select 1 from storage.objects object
            where object.bucket_id = 'user-gpx'
              and object.name = public.user_gpx_tracks.storage_path
              and (object.metadata ->> 'size')::bigint = p_compressed_size_bytes
       );
    if not found then raise exception 'GPX validation claim is no longer valid'; end if;
end;
$$;

create or replace function public.reject_gpx_admission(p_track_id uuid, p_claim_token uuid, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    update public.user_gpx_tracks set validation_status = 'rejected', validation_claim_token = null,
        validation_claimed_at = null, validation_error_code = left(coalesce(p_error_code, 'invalid_gpx'), 80)
     where id = p_track_id and validation_status = 'validating' and validation_claim_token = p_claim_token;
    if not found then raise exception 'GPX validation claim is no longer valid'; end if;
end;
$$;

create or replace function public.retry_gpx_admission(p_track_id uuid, p_claim_token uuid, p_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
    update public.user_gpx_tracks set validation_status = 'pending', validation_claim_token = null,
        validation_claimed_at = null, validation_error_code = left(coalesce(p_error_code, 'validation_error'), 80)
     where id = p_track_id and validation_status = 'validating' and validation_claim_token = p_claim_token;
    if not found then raise exception 'GPX validation claim is no longer valid'; end if;
end;
$$;

revoke all on function public.preview_gpx_admission() from public, anon, authenticated;
revoke all on function public.claim_gpx_admission(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_gpx_admission(uuid, uuid, bigint, bigint, text, integer, timestamptz, timestamptz, double precision, jsonb) from public, anon, authenticated;
revoke all on function public.reject_gpx_admission(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.retry_gpx_admission(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.preview_gpx_admission() to service_role;
grant execute on function public.claim_gpx_admission(uuid, integer) to service_role;
grant execute on function public.complete_gpx_admission(uuid, uuid, bigint, bigint, text, integer, timestamptz, timestamptz, double precision, jsonb) to service_role;
grant execute on function public.reject_gpx_admission(uuid, uuid, text) to service_role;
grant execute on function public.retry_gpx_admission(uuid, uuid, text) to service_role;

create or replace function public.trusted_current_contributor_gpx_tracks()
returns setof public.user_gpx_tracks language sql stable security definer set search_path = '' as $$
    select track.* from public.user_gpx_tracks track
    join public.user_profiles profile on profile.user_id = track.user_id
    join public.account_lifecycle_config cfg on cfg.singleton_id = 1
    where cfg.lifecycle_enabled and track.status = 'ready' and track.validation_status = 'validated'
      and profile.account_state = 'active'
      and profile.terms_version = cfg.current_terms_version
      and profile.privacy_version = cfg.current_privacy_version
      and profile.privacy_acknowledged_at is not null
$$;

create or replace function public.trusted_current_contributor_gpx_markers()
returns setof public.user_gpx_mushroom_markers language sql stable security definer set search_path = '' as $$
    select marker.* from public.user_gpx_mushroom_markers marker
    join public.user_gpx_tracks track on track.id = marker.track_id and track.user_id = marker.user_id
    join public.user_profiles profile on profile.user_id = marker.user_id
    join public.account_lifecycle_config cfg on cfg.singleton_id = 1
    where cfg.lifecycle_enabled and track.status = 'ready' and track.validation_status = 'validated'
      and profile.account_state = 'active'
      and profile.terms_version = cfg.current_terms_version
      and profile.privacy_version = cfg.current_privacy_version
      and profile.privacy_acknowledged_at is not null
$$;

-- The UUID helper remains internal. Clients use get_my_account_access_state or
-- this owner-only boolean wrapper, never an arbitrary user identifier.
revoke all on function public.has_current_contributor_access(uuid) from authenticated;
grant execute on function public.has_current_contributor_access(uuid) to service_role;
create or replace function public.has_my_current_contributor_access()
returns boolean language sql stable security definer set search_path = '' as $$
    select auth.uid() is not null and public.has_current_contributor_access(auth.uid())
$$;
revoke all on function public.has_my_current_contributor_access() from public, anon;
grant execute on function public.has_my_current_contributor_access() to authenticated, service_role;

alter table public.account_lifecycle_config
    add column if not exists max_export_input_bytes bigint not null default 524288000,
    add column if not exists max_tenant_export_input_bytes_24h bigint not null default 1073741824,
    add column if not exists expired_export_cleanup_limit integer not null default 20,
    add column if not exists expired_export_cleanup_bytes bigint not null default 1073741824;
alter table public.account_export_jobs add column if not exists input_size_bytes bigint not null default 0;

create or replace function public.request_my_data_export()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    caller_id uuid := auth.uid(); cfg public.account_lifecycle_config%rowtype;
    existing public.account_export_jobs%rowtype; new_id uuid := gen_random_uuid();
    requested_bytes bigint; tenant_recent_bytes bigint;
begin
    if caller_id is null then raise exception 'authentication required'; end if;
    perform pg_advisory_xact_lock(hashtext('tenant_export_budget'));
    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if not cfg.account_rights_enabled then raise exception 'account rights are not enabled'; end if;
    if exists (select 1 from public.user_profiles where user_id = caller_id and account_state = 'deletion_pending') then raise exception 'export must be requested before deletion is confirmed'; end if;
    select * into existing from public.account_export_jobs where user_id = caller_id
     and status in ('pending','building','retry','ready') and (status <> 'ready' or expires_at > now())
     order by requested_at desc limit 1;
    if found then return to_jsonb(existing); end if;
    if exists (select 1 from public.account_export_jobs where user_id = caller_id and requested_at > now() - make_interval(hours => cfg.export_rate_limit_hours)) then raise exception 'data export rate limit exceeded'; end if;
    select coalesce(sum(compressed_size_bytes),0) into requested_bytes from public.user_gpx_tracks
     where user_id = caller_id and status = 'ready' and validation_status = 'validated';
    if requested_bytes > cfg.max_export_input_bytes then raise exception 'account export input budget exceeded'; end if;
    select coalesce(sum(input_size_bytes),0) into tenant_recent_bytes from public.account_export_jobs
     where requested_at >= now() - interval '24 hours';
    if tenant_recent_bytes + requested_bytes > cfg.max_tenant_export_input_bytes_24h then raise exception 'tenant daily export budget exceeded'; end if;
    insert into public.account_export_jobs(id,user_id,storage_path,input_size_bytes)
    values (new_id,caller_id,caller_id::text || '/' || new_id::text || '.zip',requested_bytes)
    returning * into existing;
    return to_jsonb(existing);
end;
$$;

-- Unknown addresses keep the same response but create no row and consume no
-- shared quota. Only a real target is rate-limited and receives a token.
create or replace function public.request_external_account_deletion(p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    cfg public.account_lifecycle_config%rowtype; normalized_email text := lower(trim(coalesce(p_email,'')));
    hashed_email text; rate_key bytea; target_user uuid; raw_token text; request_id uuid;
begin
    select * into strict cfg from public.account_lifecycle_config where singleton_id = 1;
    if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or not cfg.account_rights_enabled then return jsonb_build_object('accepted',true); end if;
    select id into target_user from auth.users where lower(email) = normalized_email;
    if target_user is null then return jsonb_build_object('accepted',true); end if;
    select email_rate_hmac_key into strict rate_key from public.account_rights_secrets where singleton_id = 1;
    hashed_email := encode(extensions.hmac(convert_to(normalized_email,'UTF8'),rate_key,'sha256'),'hex');
    perform pg_advisory_xact_lock(hashtext('external_deletion_global_rate'));
    perform pg_advisory_xact_lock(hashtext(hashed_email));
    if (select count(*) from public.account_external_deletion_requests where user_id is not null and created_at >= now()-interval '1 hour') >= cfg.external_global_hourly_limit
       or (select count(*) from public.account_external_deletion_requests where email_hash=hashed_email and created_at >= now()-interval '1 hour') >= cfg.external_request_hourly_limit then return jsonb_build_object('accepted',true); end if;
    raw_token := encode(extensions.gen_random_bytes(32),'hex'); request_id := gen_random_uuid();
    insert into public.account_external_deletion_requests(id,user_id,email_hash,token_digest,source,expires_at)
    values(request_id,target_user,hashed_email,encode(extensions.digest(raw_token,'sha256'),'hex'),'external',now()+make_interval(mins=>cfg.deletion_token_ttl_minutes));
    perform public.enqueue_account_email(target_user,'external_deletion_verify',target_user::text||':external-deletion:'||request_id::text,
        jsonb_build_object('verification_token',raw_token,'request_id',request_id));
    return jsonb_build_object('accepted',true);
end;
$$;

drop function if exists public.claim_expired_account_export(uuid);
create function public.claim_expired_account_export(p_owner_token uuid, p_max_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job public.account_export_jobs%rowtype;
begin
    select * into job from public.account_export_jobs where status='expired'
      and coalesce(size_bytes,0) <= greatest(p_max_size_bytes,0)
     order by expires_at for update skip locked limit 1;
    if not found then return jsonb_build_object('claimed',false); end if;
    update public.account_export_jobs set status='cleaning',claim_token=p_owner_token,claimed_at=now(),updated_at=now()
     where id=job.id returning * into job;
    return jsonb_build_object('claimed',true,'id',job.id,'storage_path',job.storage_path,
        'size_bytes',coalesce(job.size_bytes,0),'claim_token',p_owner_token);
end;
$$;

revoke all on function public.request_my_data_export() from public, anon;
grant execute on function public.request_my_data_export() to authenticated;
revoke all on function public.request_external_account_deletion(text) from public;
grant execute on function public.request_external_account_deletion(text) to anon, authenticated, service_role;
revoke all on function public.claim_expired_account_export(uuid, bigint) from public, anon, authenticated;
grant execute on function public.claim_expired_account_export(uuid, bigint) to service_role;

commit;
