-- FunghiTracker user profiles and private cloud GPX archive v1.
-- Repeatable: safe to run again after a successful first application.
-- Passwords remain exclusively in Supabase Auth (auth.users).

create table if not exists public.gpx_archive_config (
    singleton_id smallint primary key default 1 check (singleton_id = 1),
    max_tracks_per_user integer not null check (max_tracks_per_user between 1 and 10000),
    max_compressed_bytes bigint not null check (max_compressed_bytes between 1024 and 536870912000),
    max_uncompressed_bytes bigint not null check (max_uncompressed_bytes >= max_compressed_bytes),
    terms_version text not null check (length(terms_version) between 1 and 64),
    privacy_version text not null check (length(privacy_version) between 1 and 64),
    research_consent_version text not null check (length(research_consent_version) between 1 and 64),
    updated_at timestamptz not null default now()
);

insert into public.gpx_archive_config (
    singleton_id,
    max_tracks_per_user,
    max_compressed_bytes,
    max_uncompressed_bytes,
    terms_version,
    privacy_version,
    research_consent_version
)
values (1, 50, 10485760, 52428800, '2026-08-06', '2026-08-06', '2026-08-06')
on conflict (singleton_id) do nothing;

create table if not exists public.user_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    username text not null,
    terms_accepted_at timestamptz not null,
    terms_version text not null,
    privacy_accepted_at timestamptz not null,
    privacy_version text not null,
    raw_gpx_research_consent boolean not null,
    raw_gpx_research_consent_at timestamptz not null,
    raw_gpx_research_consent_version text not null,
    raw_gpx_research_consent_withdrawn_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_profiles_username_format
        check (username ~ '^[a-z0-9_]{3,24}$'),
    constraint user_profiles_research_consent_state
        check (
            (raw_gpx_research_consent and raw_gpx_research_consent_withdrawn_at is null)
            or
            (not raw_gpx_research_consent and raw_gpx_research_consent_withdrawn_at is not null)
        )
);

create unique index if not exists user_profiles_username_unique
    on public.user_profiles (lower(username));

create table if not exists public.user_gpx_tracks (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.user_profiles(user_id) on delete cascade,
    storage_path text not null unique,
    status text not null default 'pending_upload'
        check (status in ('pending_upload', 'ready')),
    display_name text not null check (length(display_name) between 1 and 120),
    original_filename text not null check (length(original_filename) between 1 and 255),
    compressed_size_bytes bigint not null check (compressed_size_bytes > 0),
    uncompressed_size_bytes bigint check (uncompressed_size_bytes is null or uncompressed_size_bytes > 0),
    content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
    started_at timestamptz,
    ended_at timestamptz,
    point_count integer check (point_count is null or point_count > 0),
    distance_m double precision check (distance_m is null or distance_m >= 0),
    bbox jsonb,
    ready_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint user_gpx_tracks_time_order
        check (started_at is null or ended_at is null or ended_at >= started_at),
    constraint user_gpx_tracks_storage_path
        check (storage_path = user_id::text || '/' || id::text || '.gpx.gz'),
    constraint user_gpx_tracks_ready_state
        check (
            (status = 'pending_upload' and ready_at is null)
            or
            (status = 'ready' and ready_at is not null)
        )
);

create index if not exists user_gpx_tracks_user_created_idx
    on public.user_gpx_tracks (user_id, created_at desc);
create index if not exists user_gpx_tracks_user_status_idx
    on public.user_gpx_tracks (user_id, status);

create or replace function public.is_valid_gpx_bbox(p_bbox jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
    west double precision;
    south double precision;
    east double precision;
    north double precision;
begin
    if p_bbox is null then
        return true;
    end if;
    if jsonb_typeof(p_bbox) <> 'object'
       or jsonb_typeof(p_bbox -> 'west') <> 'number'
       or jsonb_typeof(p_bbox -> 'south') <> 'number'
       or jsonb_typeof(p_bbox -> 'east') <> 'number'
       or jsonb_typeof(p_bbox -> 'north') <> 'number' then
        return false;
    end if;
    west := (p_bbox ->> 'west')::double precision;
    south := (p_bbox ->> 'south')::double precision;
    east := (p_bbox ->> 'east')::double precision;
    north := (p_bbox ->> 'north')::double precision;
    return west between -180 and 180
       and east between -180 and 180
       and south between -90 and 90
       and north between -90 and 90
       and west <= east
       and south <= north;
exception when others then
    return false;
end;
$$;

create or replace function public.set_user_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create or replace function public.normalize_user_profile_username()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.username := lower(trim(new.username));
    return new;
end;
$$;

drop trigger if exists normalize_user_profiles_username on public.user_profiles;
create trigger normalize_user_profiles_username
before insert or update of username on public.user_profiles
for each row execute function public.normalize_user_profile_username();

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
before update on public.user_profiles
for each row execute function public.set_user_profile_updated_at();

drop trigger if exists set_user_gpx_tracks_updated_at on public.user_gpx_tracks;
create trigger set_user_gpx_tracks_updated_at
before update on public.user_gpx_tracks
for each row execute function public.set_user_profile_updated_at();

create or replace function public.handle_funghitracker_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.gpx_archive_config%rowtype;
    normalized_username text;
    accepted_at timestamptz := now();
begin
    select * into strict cfg
      from public.gpx_archive_config
     where singleton_id = 1;

    normalized_username := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
    if normalized_username !~ '^[a-z0-9_]{3,24}$' then
        raise exception 'username must match ^[a-z0-9_]{3,24}$';
    end if;
    if coalesce(new.raw_user_meta_data ->> 'terms_accepted', 'false') <> 'true' then
        raise exception 'terms acceptance is required';
    end if;
    if coalesce(new.raw_user_meta_data ->> 'privacy_accepted', 'false') <> 'true' then
        raise exception 'privacy acceptance is required';
    end if;
    if coalesce(new.raw_user_meta_data ->> 'raw_gpx_research_consent', 'false') <> 'true' then
        raise exception 'raw GPX research consent is required';
    end if;

    insert into public.user_profiles (
        user_id,
        username,
        terms_accepted_at,
        terms_version,
        privacy_accepted_at,
        privacy_version,
        raw_gpx_research_consent,
        raw_gpx_research_consent_at,
        raw_gpx_research_consent_version
    ) values (
        new.id,
        normalized_username,
        accepted_at,
        cfg.terms_version,
        accepted_at,
        cfg.privacy_version,
        true,
        accepted_at,
        cfg.research_consent_version
    );
    return new;
end;
$$;

drop trigger if exists on_funghitracker_auth_user_created on auth.users;
create trigger on_funghitracker_auth_user_created
after insert on auth.users
for each row execute function public.handle_funghitracker_new_user();

create or replace function public.reserve_my_gpx_track(
    p_display_name text,
    p_original_filename text,
    p_compressed_size_bytes bigint,
    p_content_sha256 text,
    p_uncompressed_size_bytes bigint default null,
    p_started_at timestamptz default null,
    p_ended_at timestamptz default null,
    p_point_count integer default null,
    p_distance_m double precision default null,
    p_bbox jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    cfg public.gpx_archive_config%rowtype;
    track_id uuid := gen_random_uuid();
    track_count integer;
    object_path text;
    normalized_filename text := trim(coalesce(p_original_filename, ''));
    normalized_name text := trim(coalesce(p_display_name, ''));
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    if not exists (select 1 from public.user_profiles where user_id = caller_id) then
        raise exception 'application profile is missing';
    end if;

    perform pg_advisory_xact_lock(hashtext(caller_id::text));
    select * into strict cfg
      from public.gpx_archive_config
     where singleton_id = 1;
    select count(*) into track_count
      from public.user_gpx_tracks
     where user_id = caller_id;
    if track_count >= cfg.max_tracks_per_user then
        raise exception 'GPX track quota exceeded (% tracks)', cfg.max_tracks_per_user;
    end if;

    if length(normalized_name) not between 1 and 120 then
        raise exception 'display name must contain 1 to 120 characters';
    end if;
    if length(normalized_filename) not between 1 and 255
       or lower(normalized_filename) !~ '\.gpx(\.gz)?$' then
        raise exception 'original filename must end in .gpx or .gpx.gz';
    end if;
    if p_compressed_size_bytes is null
       or p_compressed_size_bytes <= 0
       or p_compressed_size_bytes > cfg.max_compressed_bytes then
        raise exception 'compressed GPX size is outside configured limits';
    end if;
    if p_uncompressed_size_bytes is not null
       and (p_uncompressed_size_bytes <= 0
            or p_uncompressed_size_bytes > cfg.max_uncompressed_bytes) then
        raise exception 'uncompressed GPX size is outside configured limits';
    end if;
    if p_content_sha256 is null or lower(p_content_sha256) !~ '^[0-9a-f]{64}$' then
        raise exception 'content_sha256 must contain 64 hexadecimal characters';
    end if;
    if p_started_at is not null and p_ended_at is not null and p_ended_at < p_started_at then
        raise exception 'ended_at cannot precede started_at';
    end if;
    if p_point_count is not null and p_point_count <= 0 then
        raise exception 'point_count must be positive';
    end if;
    if p_distance_m is not null and p_distance_m < 0 then
        raise exception 'distance_m cannot be negative';
    end if;
    if not public.is_valid_gpx_bbox(p_bbox) then
        raise exception 'invalid GPX bbox';
    end if;

    object_path := caller_id::text || '/' || track_id::text || '.gpx.gz';
    insert into public.user_gpx_tracks (
        id, user_id, storage_path, display_name, original_filename,
        compressed_size_bytes, uncompressed_size_bytes, content_sha256,
        started_at, ended_at, point_count, distance_m, bbox
    ) values (
        track_id, caller_id, object_path, normalized_name, normalized_filename,
        p_compressed_size_bytes, p_uncompressed_size_bytes, lower(p_content_sha256),
        p_started_at, p_ended_at, p_point_count, p_distance_m, p_bbox
    );

    return jsonb_build_object(
        'id', track_id,
        'storage_path', object_path,
        'status', 'pending_upload',
        'max_tracks_per_user', cfg.max_tracks_per_user,
        'remaining_slots', cfg.max_tracks_per_user - track_count - 1
    );
end;
$$;

create or replace function public.can_upload_user_gpx_object(
    p_name text,
    p_owner_id text,
    p_metadata jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null or p_owner_id is distinct from caller_id::text then
        return false;
    end if;

    return exists (
        select 1
          from public.user_gpx_tracks track
         where track.user_id = caller_id
           and track.storage_path = p_name
           and track.status = 'pending_upload'
           and p_name = caller_id::text || '/' || track.id::text || '.gpx.gz'
    );
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
    track public.user_gpx_tracks%rowtype;
    object_owner_id text;
    object_metadata jsonb;
    actual_size bigint;
    actual_mime text;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    select * into track
      from public.user_gpx_tracks
     where id = p_track_id and user_id = caller_id
     for update;
    if not found then
        raise exception 'GPX track reservation not found';
    end if;
    if track.status = 'ready' then
        return to_jsonb(track);
    end if;

    select owner_id, metadata
      into object_owner_id, object_metadata
      from storage.objects
     where bucket_id = 'user-gpx'
       and name = track.storage_path;
    if not found then
        raise exception 'GPX Storage object not found';
    end if;
    actual_size := (object_metadata ->> 'size')::bigint;
    actual_mime := lower(coalesce(object_metadata ->> 'mimetype', ''));
    if object_owner_id is distinct from caller_id::text then
        raise exception 'GPX Storage owner mismatch';
    end if;
    if actual_size <> track.compressed_size_bytes then
        raise exception 'GPX Storage size does not match reservation';
    end if;
    if actual_mime not in ('application/gzip', 'application/x-gzip') then
        raise exception 'GPX Storage MIME type is invalid';
    end if;

    update public.user_gpx_tracks
       set status = 'ready', ready_at = now()
     where id = track.id
     returning * into track;
    return to_jsonb(track);
end;
$$;

create or replace function public.delete_my_gpx_track_metadata(p_track_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    object_path text;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    select storage_path into object_path
      from public.user_gpx_tracks
     where id = p_track_id and user_id = caller_id
     for update;
    if not found then
        return;
    end if;
    if exists (
        select 1 from storage.objects
         where bucket_id = 'user-gpx' and name = object_path
    ) then
        raise exception 'delete the GPX Storage object before its metadata';
    end if;
    delete from public.user_gpx_tracks
     where id = p_track_id and user_id = caller_id;
end;
$$;

create or replace function public.set_my_raw_gpx_research_consent(p_granted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    consent_version text;
    profile public.user_profiles%rowtype;
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    select research_consent_version into strict consent_version
      from public.gpx_archive_config where singleton_id = 1;
    update public.user_profiles
       set raw_gpx_research_consent = p_granted,
           raw_gpx_research_consent_at = case when p_granted then now() else raw_gpx_research_consent_at end,
           raw_gpx_research_consent_version = case when p_granted then consent_version else raw_gpx_research_consent_version end,
           raw_gpx_research_consent_withdrawn_at = case when p_granted then null else now() end
     where user_id = caller_id
     returning * into profile;
    if not found then
        raise exception 'application profile is missing';
    end if;
    return to_jsonb(profile);
end;
$$;

create or replace function public.configure_gpx_archive(
    p_max_tracks_per_user integer,
    p_max_compressed_bytes bigint,
    p_max_uncompressed_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg public.gpx_archive_config%rowtype;
begin
    if p_max_tracks_per_user not between 1 and 10000 then
        raise exception 'max_tracks_per_user is outside supported limits';
    end if;
    if p_max_compressed_bytes not between 1024 and 536870912000 then
        raise exception 'max_compressed_bytes is outside supported limits';
    end if;
    if p_max_uncompressed_bytes < p_max_compressed_bytes then
        raise exception 'max_uncompressed_bytes cannot be smaller than compressed limit';
    end if;
    update public.gpx_archive_config
       set max_tracks_per_user = p_max_tracks_per_user,
           max_compressed_bytes = p_max_compressed_bytes,
           max_uncompressed_bytes = p_max_uncompressed_bytes,
           updated_at = now()
     where singleton_id = 1
     returning * into cfg;
    update storage.buckets
       set public = false,
           file_size_limit = p_max_compressed_bytes,
           allowed_mime_types = array['application/gzip', 'application/x-gzip']
     where id = 'user-gpx';
    return to_jsonb(cfg);
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select
    'user-gpx',
    'user-gpx',
    false,
    cfg.max_compressed_bytes,
    array['application/gzip', 'application/x-gzip']
from public.gpx_archive_config cfg
where cfg.singleton_id = 1
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.gpx_archive_config enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_gpx_tracks enable row level security;

drop policy if exists gpx_archive_config_read on public.gpx_archive_config;
create policy gpx_archive_config_read
    on public.gpx_archive_config
    for select
    to anon, authenticated
    using (singleton_id = 1);

drop policy if exists user_profiles_read_own on public.user_profiles;
create policy user_profiles_read_own
    on public.user_profiles
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists user_profiles_update_username on public.user_profiles;
create policy user_profiles_update_username
    on public.user_profiles
    for update
    to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

drop policy if exists user_gpx_tracks_read_own on public.user_gpx_tracks;
create policy user_gpx_tracks_read_own
    on public.user_gpx_tracks
    for select
    to authenticated
    using ((select auth.uid()) = user_id);

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'user-gpx'
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and exists (
            select 1 from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

drop policy if exists user_gpx_objects_insert_reserved on storage.objects;
create policy user_gpx_objects_insert_reserved
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'user-gpx'
        and storage.extension(name) = 'gz'
        and public.can_upload_user_gpx_object(name, owner_id, metadata)
    );

drop policy if exists user_gpx_objects_delete_own on storage.objects;
create policy user_gpx_objects_delete_own
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'user-gpx'
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and exists (
            select 1 from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

revoke all on public.gpx_archive_config from anon, authenticated;
revoke all on public.user_profiles from anon, authenticated;
revoke all on public.user_gpx_tracks from anon, authenticated;
grant select on public.gpx_archive_config to anon, authenticated;
grant select on public.user_profiles to authenticated;
grant update (username) on public.user_profiles to authenticated;
grant select on public.user_gpx_tracks to authenticated;
grant all on public.gpx_archive_config to service_role;
grant all on public.user_profiles to service_role;
grant all on public.user_gpx_tracks to service_role;

revoke all on function public.is_valid_gpx_bbox(jsonb) from public, anon, authenticated;
revoke all on function public.set_user_profile_updated_at() from public, anon, authenticated;
revoke all on function public.normalize_user_profile_username() from public, anon, authenticated;
revoke all on function public.handle_funghitracker_new_user() from public, anon, authenticated;
revoke all on function public.reserve_my_gpx_track(
    text, text, bigint, text, bigint, timestamptz, timestamptz,
    integer, double precision, jsonb
) from public, anon;
revoke all on function public.can_upload_user_gpx_object(text, text, jsonb) from public, anon;
revoke all on function public.finalize_my_gpx_track(uuid) from public, anon;
revoke all on function public.delete_my_gpx_track_metadata(uuid) from public, anon;
revoke all on function public.set_my_raw_gpx_research_consent(boolean) from public, anon;
revoke all on function public.configure_gpx_archive(integer, bigint, bigint)
    from public, anon, authenticated;

grant execute on function public.reserve_my_gpx_track(
    text, text, bigint, text, bigint, timestamptz, timestamptz,
    integer, double precision, jsonb
) to authenticated;
grant execute on function public.can_upload_user_gpx_object(text, text, jsonb)
    to authenticated;
grant execute on function public.finalize_my_gpx_track(uuid) to authenticated;
grant execute on function public.delete_my_gpx_track_metadata(uuid) to authenticated;
grant execute on function public.set_my_raw_gpx_research_consent(boolean) to authenticated;
grant execute on function public.configure_gpx_archive(integer, bigint, bigint)
    to service_role;

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
            'user_gpx_tracks', (select relrowsecurity from pg_catalog.pg_class where oid = 'public.user_gpx_tracks'::regclass)
        ),
        'policies', (
            select coalesce(jsonb_agg(policyname order by policyname), '[]'::jsonb)
              from pg_catalog.pg_policies
             where (schemaname = 'public' and tablename in ('gpx_archive_config', 'user_profiles', 'user_gpx_tracks'))
                or (schemaname = 'storage' and tablename = 'objects' and policyname like 'user_gpx_%')
        ),
        'profiles', (select count(*) from public.user_profiles),
        'tracks', (select count(*) from public.user_gpx_tracks)
    );
$$;

revoke all on function public.user_gpx_setup_audit() from public, anon, authenticated;
grant execute on function public.user_gpx_setup_audit() to service_role;

comment on table public.gpx_archive_config is
    'Singleton database-side quota and legal-document versions for the private GPX archive.';
comment on table public.user_profiles is
    'Application profile linked to Supabase Auth; passwords are never stored here.';
comment on table public.user_gpx_tracks is
    'Private GPX metadata and canonical Storage path; quota counts pending and ready rows.';
comment on function public.reserve_my_gpx_track(
    text, text, bigint, text, bigint, timestamptz, timestamptz,
    integer, double precision, jsonb
) is 'Atomically reserves one user quota slot and returns the only permitted Storage path.';
