-- Add an explicit mushroom species to private GPX annotations.
-- Existing generic markers cannot be classified safely: the migration stops
-- if any are present with no species instead of inventing a value.

begin;

alter table public.user_gpx_mushroom_markers
    add column if not exists species text;

do $$
begin
    if exists (
        select 1
          from public.user_gpx_mushroom_markers
         where species is null
    ) then
        raise exception
            'generic GPX mushroom markers exist; classify or delete them before applying this migration';
    end if;

    alter table public.user_gpx_mushroom_markers
        alter column species set not null;

    if not exists (
        select 1
          from pg_catalog.pg_constraint
         where conrelid = 'public.user_gpx_mushroom_markers'::regclass
           and conname = 'user_gpx_mushroom_markers_species'
    ) then
        alter table public.user_gpx_mushroom_markers
            add constraint user_gpx_mushroom_markers_species
            check (species in ('porcini', 'finferli'));
    end if;
end;
$$;

alter table public.user_gpx_mushroom_markers
    drop constraint if exists user_gpx_mushroom_markers_track_point_unique;

create unique index if not exists user_gpx_mushroom_markers_track_point_species_unique
    on public.user_gpx_mushroom_markers(track_id, track_point_index, species);

drop function if exists public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, integer
);

create or replace function public.save_my_gpx_mushroom_marker(
    p_track_id uuid,
    p_track_point_index integer,
    p_latitude double precision,
    p_longitude double precision,
    p_species text,
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
    normalized_species text := lower(trim(p_species));
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    if p_species is null
       or normalized_species not in ('porcini', 'finferli') then
        raise exception 'marker species must be porcini or finferli';
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
        track_id, user_id, track_point_index, latitude, longitude, species, count
    ) values (
        track.id, caller_id, p_track_point_index, p_latitude, p_longitude,
        normalized_species, p_count
    )
    on conflict (track_id, track_point_index, species)
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

drop function if exists public.delete_my_gpx_mushroom_marker(uuid, integer);

create or replace function public.delete_my_gpx_mushroom_marker(
    p_track_id uuid,
    p_track_point_index integer,
    p_species text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    normalized_species text := lower(trim(p_species));
begin
    if caller_id is null then
        raise exception 'authentication required';
    end if;
    if p_species is null
       or normalized_species not in ('porcini', 'finferli') then
        raise exception 'marker species must be porcini or finferli';
    end if;

    delete from public.user_gpx_mushroom_markers
     where track_id = p_track_id
       and track_point_index = p_track_point_index
       and species = normalized_species
       and user_id = caller_id;
end;
$$;

revoke all on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, text, integer
) from public, anon;
grant execute on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, text, integer
) to authenticated;
revoke all on function public.delete_my_gpx_mushroom_marker(uuid, integer, text)
    from public, anon;
grant execute on function public.delete_my_gpx_mushroom_marker(uuid, integer, text)
    to authenticated;

comment on column public.user_gpx_mushroom_markers.species is
    'Required stable code: porcini or finferli.';
comment on function public.save_my_gpx_mushroom_marker(
    uuid, integer, double precision, double precision, text, integer
) is 'Creates or replaces one owner scoped marker count per raw GPX point and species.';

notify pgrst, 'reload schema';

commit;
