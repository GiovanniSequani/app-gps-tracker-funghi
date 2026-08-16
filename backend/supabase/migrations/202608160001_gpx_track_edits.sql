-- Reversible GPX editing metadata.
-- Raw .gpx.gz objects and canonical Storage paths remain immutable.
-- Repeatable and scoped to the private user GPX archive.

alter table public.user_gpx_tracks
    add column if not exists trim_start_point_index integer;
alter table public.user_gpx_tracks
    add column if not exists trim_end_point_index integer;

do $$
begin
    if not exists (
        select 1
          from pg_catalog.pg_constraint
         where conrelid = 'public.user_gpx_tracks'::regclass
           and conname = 'user_gpx_tracks_trim_range'
    ) then
        alter table public.user_gpx_tracks
            add constraint user_gpx_tracks_trim_range
            check (
                (trim_start_point_index is null and trim_end_point_index is null)
                or
                (
                    point_count is not null
                    and trim_start_point_index is not null
                    and trim_end_point_index is not null
                    and trim_start_point_index >= 0
                    and trim_end_point_index > trim_start_point_index
                    and trim_end_point_index < point_count
                )
            );
    end if;
end;
$$;

create unique index if not exists user_gpx_tracks_id_user_unique
    on public.user_gpx_tracks(id, user_id);

create table if not exists public.user_gpx_mushroom_markers (
    id uuid primary key default gen_random_uuid(),
    track_id uuid not null,
    user_id uuid not null,
    track_point_index integer not null check (track_point_index >= 0),
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    count integer not null check (count between 1 and 10000),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_gpx_mushroom_markers_track_owner_fk
        foreign key (track_id, user_id)
        references public.user_gpx_tracks(id, user_id)
        on delete cascade,
    constraint user_gpx_mushroom_markers_track_point_unique
        unique (track_id, track_point_index)
);

create index if not exists user_gpx_mushroom_markers_user_track_idx
    on public.user_gpx_mushroom_markers(user_id, track_id, track_point_index);

drop trigger if exists set_user_gpx_mushroom_markers_updated_at
    on public.user_gpx_mushroom_markers;
create trigger set_user_gpx_mushroom_markers_updated_at
before update on public.user_gpx_mushroom_markers
for each row execute function public.set_user_profile_updated_at();

create or replace function public.set_my_gpx_track_trim(
    p_track_id uuid,
    p_trim_start_point_index integer default null,
    p_trim_end_point_index integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    track public.user_gpx_tracks%rowtype;
    normalized_start integer;
    normalized_end integer;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;

    select * into track
      from public.user_gpx_tracks
     where id = p_track_id
       and user_id = caller_id
       and status = 'ready'
     for update;
    if not found then
        raise exception 'ready GPX track not found';
    end if;
    if track.point_count is null or track.point_count < 2 then
        raise exception 'track point_count is required for editing';
    end if;

    if p_trim_start_point_index is null and p_trim_end_point_index is null then
        update public.user_gpx_tracks
           set trim_start_point_index = null,
               trim_end_point_index = null
         where id = track.id
         returning * into track;
        return to_jsonb(track);
    end if;

    normalized_start := coalesce(p_trim_start_point_index, 0);
    normalized_end := coalesce(p_trim_end_point_index, track.point_count - 1);
    if normalized_start < 0
       or normalized_end >= track.point_count
       or normalized_end <= normalized_start then
        raise exception 'trim must retain at least two points inside the raw track';
    end if;

    update public.user_gpx_tracks
       set trim_start_point_index = case
               when normalized_start = 0 and normalized_end = point_count - 1 then null
               else normalized_start
           end,
           trim_end_point_index = case
               when normalized_start = 0 and normalized_end = point_count - 1 then null
               else normalized_end
           end
     where id = track.id
     returning * into track;
    return to_jsonb(track);
end;
$$;

create or replace function public.save_my_gpx_mushroom_marker(
    p_track_id uuid,
    p_track_point_index integer,
    p_latitude double precision,
    p_longitude double precision,
    p_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    track public.user_gpx_tracks%rowtype;
    marker public.user_gpx_mushroom_markers%rowtype;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;

    select * into track
      from public.user_gpx_tracks
     where id = p_track_id
       and user_id = caller_id
       and status = 'ready';
    if not found then
        raise exception 'ready GPX track not found';
    end if;
    if track.point_count is null then
        raise exception 'track point_count is required for editing';
    end if;
    if p_track_point_index is null
       or p_track_point_index < 0
       or p_track_point_index >= track.point_count then
        raise exception 'marker point index is outside the raw track';
    end if;
    if p_latitude is null or p_latitude not between -90 and 90
       or p_longitude is null or p_longitude not between -180 and 180 then
        raise exception 'marker coordinates are invalid';
    end if;
    if p_count is null or p_count not between 1 and 10000 then
        raise exception 'marker count must be between 1 and 10000';
    end if;

    insert into public.user_gpx_mushroom_markers (
        track_id, user_id, track_point_index, latitude, longitude, count
    ) values (
        track.id, caller_id, p_track_point_index, p_latitude, p_longitude, p_count
    )
    on conflict (track_id, track_point_index)
    do update set
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        count = excluded.count
    where public.user_gpx_mushroom_markers.user_id = caller_id
    returning * into marker;

    if not found then
        raise exception 'GPX mushroom marker owner mismatch';
    end if;
    return to_jsonb(marker);
end;
$$;

create or replace function public.delete_my_gpx_mushroom_marker(
    p_track_id uuid,
    p_track_point_index integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    delete from public.user_gpx_mushroom_markers
     where track_id = p_track_id
       and track_point_index = p_track_point_index
       and user_id = caller_id;
end;
$$;

alter table public.user_gpx_mushroom_markers enable row level security;

drop policy if exists user_gpx_mushroom_markers_read_own
    on public.user_gpx_mushroom_markers;
create policy user_gpx_mushroom_markers_read_own
    on public.user_gpx_mushroom_markers
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

revoke all on public.user_gpx_mushroom_markers from public, anon, authenticated;
grant select on public.user_gpx_mushroom_markers to authenticated;
grant all on public.user_gpx_mushroom_markers to service_role;

revoke all on function public.set_my_gpx_track_trim(uuid, integer, integer)
    from public, anon;
grant execute on function public.set_my_gpx_track_trim(uuid, integer, integer)
    to authenticated;
revoke all on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, integer
) from public, anon;
grant execute on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, integer
) to authenticated;
revoke all on function public.delete_my_gpx_mushroom_marker(uuid, integer)
    from public, anon;
grant execute on function public.delete_my_gpx_mushroom_marker(uuid, integer)
    to authenticated;

create or replace function public.user_gpx_setup_audit()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'config', (select to_jsonb(cfg) from public.gpx_archive_config cfg where singleton_id = 1),
        'bucket', (
            select jsonb_build_object(
                'id', id,
                'public', public,
                'file_size_limit', file_size_limit,
                'allowed_mime_types', allowed_mime_types
            ) from storage.buckets where id = 'user-gpx'
        ),
        'rls', jsonb_build_object(
            'user_profiles', (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_profiles'::regclass),
            'user_gpx_tracks', (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_gpx_tracks'::regclass),
            'user_gpx_mushroom_markers', (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_gpx_mushroom_markers'::regclass)
        ),
        'policies', (
            select coalesce(jsonb_agg(policyname order by policyname), '[]'::jsonb)
              from pg_catalog.pg_policies
             where (schemaname = 'public' and tablename in (
                        'gpx_archive_config', 'user_profiles', 'user_gpx_tracks',
                        'user_gpx_mushroom_markers'
                    ))
                or (schemaname = 'storage' and tablename = 'objects' and policyname like 'user_gpx_%')
        ),
        'profiles', (select count(*) from public.user_profiles),
        'tracks', (select count(*) from public.user_gpx_tracks),
        'markers', (select count(*) from public.user_gpx_mushroom_markers)
    );
$$;

revoke all on function public.user_gpx_setup_audit()
    from public, anon, authenticated;
grant execute on function public.user_gpx_setup_audit() to service_role;

comment on column public.user_gpx_tracks.trim_start_point_index is
    'Inclusive first visible raw trkpt index; null together with trim_end_point_index means untrimmed.';
comment on column public.user_gpx_tracks.trim_end_point_index is
    'Inclusive last visible raw trkpt index; null together with trim_start_point_index means untrimmed.';
comment on table public.user_gpx_mushroom_markers is
    'Private reversible mushroom annotations anchored to immutable raw GPX track-point indices.';
comment on function public.set_my_gpx_track_trim(uuid, integer, integer) is
    'Sets or clears an authenticated owner scoped inclusive trim without rewriting the raw GPX object.';
comment on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, integer
) is 'Creates or replaces one authenticated owner scoped marker count at a raw GPX track point.';

notify pgrst, 'reload schema';
