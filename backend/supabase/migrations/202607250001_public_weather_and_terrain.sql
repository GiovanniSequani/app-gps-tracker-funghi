-- FunghiTracker public weather v1 + dedicated terrain bucket.
-- Repeatable: safe to run again after the first successful application.
-- This migration never reads, updates or deletes the tiles bucket.

create table if not exists public.public_weather_datasets (
    version text primary key,
    index_date date not null unique,
    status text not null check (status in ('staging', 'current')),
    dates date[] not null,
    day_count smallint not null check (day_count = 20 and cardinality(dates) = day_count),
    available_day_count smallint not null check (available_day_count between 0 and day_count),
    missing_dates date[] not null default '{}',
    rows integer not null check (rows > 0),
    cols integer not null check (cols > 0),
    expected_cells integer not null check (expected_cells = rows * cols),
    bbox jsonb not null,
    origin_lat double precision not null,
    origin_lon double precision not null,
    step_deg double precision not null check (step_deg > 0),
    source_stride smallint not null check (source_stride > 0),
    sampling_method text not null,
    variables jsonb not null,
    content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    published_at timestamptz
);

alter table public.public_weather_datasets
    add column if not exists available_day_count smallint;
alter table public.public_weather_datasets
    add column if not exists missing_dates date[] not null default '{}';

create table if not exists public.public_weather_cells (
    version text not null references public.public_weather_datasets(version) on delete cascade,
    row_idx smallint not null check (row_idx >= 0),
    col_idx smallint not null check (col_idx >= 0),
    t2m_min smallint[] not null check (cardinality(t2m_min) = 20),
    t2m_max smallint[] not null check (cardinality(t2m_max) = 20),
    precip_sum smallint[] not null check (cardinality(precip_sum) = 20),
    rh_mean smallint[] not null check (cardinality(rh_mean) = 20),
    gust_max smallint[] not null check (cardinality(gust_max) = 20),
    primary key (version, row_idx, col_idx)
);

create table if not exists public.public_weather_state (
    singleton_id smallint primary key default 1 check (singleton_id = 1),
    current_version text not null references public.public_weather_datasets(version),
    updated_at timestamptz not null default now()
);

create index if not exists public_weather_cells_version_idx
    on public.public_weather_cells(version);

alter table public.public_weather_datasets enable row level security;
alter table public.public_weather_cells enable row level security;
alter table public.public_weather_state enable row level security;

drop policy if exists public_weather_state_read_current on public.public_weather_state;
create policy public_weather_state_read_current
    on public.public_weather_state
    for select
    to anon, authenticated
    using (singleton_id = 1);

drop policy if exists public_weather_datasets_read_current on public.public_weather_datasets;
create policy public_weather_datasets_read_current
    on public.public_weather_datasets
    for select
    to anon, authenticated
    using (
        exists (
            select 1
            from public.public_weather_state state
            where state.singleton_id = 1
              and state.current_version = public_weather_datasets.version
        )
    );

drop policy if exists public_weather_cells_read_current on public.public_weather_cells;
create policy public_weather_cells_read_current
    on public.public_weather_cells
    for select
    to anon, authenticated
    using (
        exists (
            select 1
            from public.public_weather_state state
            where state.singleton_id = 1
              and state.current_version = public_weather_cells.version
        )
    );

revoke all on public.public_weather_datasets from anon, authenticated;
revoke all on public.public_weather_cells from anon, authenticated;
revoke all on public.public_weather_state from anon, authenticated;
grant select on public.public_weather_datasets to anon, authenticated;
grant select on public.public_weather_cells to anon, authenticated;
grant select on public.public_weather_state to anon, authenticated;
grant all on public.public_weather_datasets to service_role;
grant all on public.public_weather_cells to service_role;
grant all on public.public_weather_state to service_role;

create or replace function public.prepare_public_weather_version(
    p_version text,
    p_index_date date,
    p_dates date[],
    p_missing_dates date[],
    p_rows integer,
    p_cols integer,
    p_bbox jsonb,
    p_origin_lat double precision,
    p_origin_lon double precision,
    p_step_deg double precision,
    p_source_stride smallint,
    p_sampling_method text,
    p_variables jsonb,
    p_content_sha256 text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    existing_current text;
    existing_hash text;
begin
    perform pg_advisory_xact_lock(hashtext('funghitracker_public_weather'));

    select state.current_version
      into existing_current
      from public.public_weather_state state
     where state.singleton_id = 1;

    if existing_current = p_version then
        select content_sha256
          into existing_hash
          from public.public_weather_datasets
         where version = p_version;
        if existing_hash = p_content_sha256 then
            return;
        end if;
        raise exception 'current weather version % has different content', p_version;
    end if;
    if existing_current is not null and existing_current > p_version then
        raise exception
            'weather version % is older than current version %',
            p_version, existing_current;
    end if;

    if cardinality(p_dates) <> 20 then
        raise exception 'weather version must contain exactly 20 dates';
    end if;
    if p_missing_dates is null then
        p_missing_dates := '{}';
    end if;
    if exists (
        select 1
          from unnest(p_missing_dates) missing_date
         where not (missing_date = any(p_dates))
    ) then
        raise exception 'missing weather dates must belong to the 20-day dates array';
    end if;
    if p_dates[20] <> p_index_date then
        raise exception 'last weather date must equal index date';
    end if;
    if exists (
        select 1
          from generate_subscripts(p_dates, 1) idx
         where idx > 1 and p_dates[idx] <> p_dates[idx - 1] + 1
    ) then
        raise exception 'weather dates must be consecutive';
    end if;

    delete from public.public_weather_datasets
     where version = p_version
       and status = 'staging';

    insert into public.public_weather_datasets (
        version, index_date, status, dates, day_count,
        available_day_count, missing_dates, rows, cols,
        expected_cells, bbox, origin_lat, origin_lon, step_deg,
        source_stride, sampling_method, variables, content_sha256
    )
    values (
        p_version, p_index_date, 'staging', p_dates, cardinality(p_dates),
        cardinality(p_dates) - cardinality(p_missing_dates), p_missing_dates,
        p_rows, p_cols, p_rows * p_cols, p_bbox, p_origin_lat, p_origin_lon,
        p_step_deg, p_source_stride, p_sampling_method, p_variables,
        p_content_sha256
    );
end;
$$;

create or replace function public.publish_public_weather_version(p_version text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    dataset_row public.public_weather_datasets%rowtype;
    actual_cells bigint;
    invalid_cells bigint;
    relation_bytes bigint;
begin
    perform pg_advisory_xact_lock(hashtext('funghitracker_public_weather'));

    select *
      into dataset_row
      from public.public_weather_datasets
     where version = p_version
     for update;
    if not found then
        raise exception 'weather version % does not exist', p_version;
    end if;

    select
        count(*),
        count(*) filter (
            where row_idx >= dataset_row.rows
               or col_idx >= dataset_row.cols
               or cardinality(t2m_min) <> dataset_row.day_count
               or cardinality(t2m_max) <> dataset_row.day_count
               or cardinality(precip_sum) <> dataset_row.day_count
               or cardinality(rh_mean) <> dataset_row.day_count
               or cardinality(gust_max) <> dataset_row.day_count
        )
      into actual_cells, invalid_cells
      from public.public_weather_cells
     where version = p_version;

    if actual_cells <> dataset_row.expected_cells or invalid_cells <> 0 then
        raise exception
            'weather version % incomplete: cells=% expected=% invalid=%',
            p_version, actual_cells, dataset_row.expected_cells, invalid_cells;
    end if;

    update public.public_weather_datasets
       set status = 'staging'
     where status = 'current'
       and version <> p_version;

    update public.public_weather_datasets
       set status = 'current',
           published_at = coalesce(published_at, now())
     where version = p_version;

    insert into public.public_weather_state(singleton_id, current_version, updated_at)
    values (1, p_version, now())
    on conflict (singleton_id)
    do update set current_version = excluded.current_version,
                  updated_at = excluded.updated_at;

    delete from public.public_weather_datasets
     where version <> p_version;

    relation_bytes :=
        pg_total_relation_size('public.public_weather_datasets'::regclass)
        + pg_total_relation_size('public.public_weather_cells'::regclass)
        + pg_total_relation_size('public.public_weather_state'::regclass);

    return jsonb_build_object(
        'version', p_version,
        'cells', actual_cells,
        'relation_bytes', relation_bytes
    );
end;
$$;

create or replace function public.public_weather_storage_stats()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'datasets', (select count(*) from public.public_weather_datasets),
        'cells', (select count(*) from public.public_weather_cells),
        'current_version', (
            select current_version
              from public.public_weather_state
             where singleton_id = 1
        ),
        'relation_bytes',
            pg_total_relation_size('public.public_weather_datasets'::regclass)
            + pg_total_relation_size('public.public_weather_cells'::regclass)
            + pg_total_relation_size('public.public_weather_state'::regclass)
    );
$$;

revoke all on function public.prepare_public_weather_version(
    text, date, date[], date[], integer, integer, jsonb, double precision,
    double precision, double precision, smallint, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.publish_public_weather_version(text)
    from public, anon, authenticated;
revoke all on function public.public_weather_storage_stats()
    from public, anon, authenticated;
grant execute on function public.prepare_public_weather_version(
    text, date, date[], date[], integer, integer, jsonb, double precision,
    double precision, double precision, smallint, text, jsonb, text
) to service_role;
grant execute on function public.publish_public_weather_version(text)
    to service_role;
grant execute on function public.public_weather_storage_stats()
    to service_role;

insert into storage.buckets (
    id, name, public, file_size_limit, allowed_mime_types
)
values (
    'terrain',
    'terrain',
    true,
    5242880,
    array['application/octet-stream', 'application/json']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists terrain_public_read on storage.objects;
create policy terrain_public_read
    on storage.objects
    for select
    to anon, authenticated
    using (bucket_id = 'terrain');

comment on table public.public_weather_datasets is
    'Versioned metadata for the public 20-day FunghiTracker weather grid.';
comment on table public.public_weather_cells is
    'One regular-grid cell per version; each variable is a 20-element smallint array.';
comment on table public.public_weather_state is
    'Singleton atomic pointer to the current complete public weather version.';
