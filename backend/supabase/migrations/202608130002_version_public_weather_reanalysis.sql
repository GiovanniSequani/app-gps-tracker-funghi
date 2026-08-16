-- Allow an HRS reanalysis to atomically replace public weather for the same
-- index date. Versions are immutable content identifiers (date + hash), while
-- index_date remains the logical date exposed to clients.
-- Repeatable and scoped only to the public weather tables/functions.

alter table public.public_weather_datasets
    drop constraint if exists public_weather_datasets_index_date_key;

create index if not exists public_weather_datasets_index_date_idx
    on public.public_weather_datasets(index_date);

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
    existing_current_date date;
    existing_hash text;
begin
    perform pg_advisory_xact_lock(hashtext('funghitracker_public_weather'));

    select state.current_version, datasets.index_date
      into existing_current, existing_current_date
      from public.public_weather_state state
      join public.public_weather_datasets datasets
        on datasets.version = state.current_version
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
    if existing_current_date is not null and existing_current_date > p_index_date then
        raise exception
            'weather index date % is older than current index date %',
            p_index_date, existing_current_date;
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

revoke all on function public.prepare_public_weather_version(
    text, date, date[], date[], integer, integer, jsonb, double precision,
    double precision, double precision, smallint, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.prepare_public_weather_version(
    text, date, date[], date[], integer, integer, jsonb, double precision,
    double precision, double precision, smallint, text, jsonb, text
) to service_role;

notify pgrst, 'reload schema';
