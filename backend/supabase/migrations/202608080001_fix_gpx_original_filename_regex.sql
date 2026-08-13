-- Fix the original filename validation in reserve_my_gpx_track.
-- The initial migration used a regular expression with doubled backslashes,
-- which made PostgreSQL look for a literal backslash before the extension.

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

