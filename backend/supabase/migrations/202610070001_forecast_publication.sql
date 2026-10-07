-- Forecast only. Apply after the first local-run review; never touches official buckets.
begin;
create table if not exists public.forecast_versions (
 version text primary key check (version ~ '^[0-9]{8}T[0-9]{6}Z$'),
 issued_at timestamptz not null unique,
 valid_until timestamptz not null check (valid_until > issued_at),
 manifest jsonb not null,
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 published boolean not null default false
);
create table if not exists public.forecast_pointer (
 singleton boolean primary key default true check (singleton),
 version text references public.forecast_versions(version) on delete set null
);
insert into public.forecast_pointer(singleton) values(true) on conflict do nothing;
alter table public.forecast_versions enable row level security;
alter table public.forecast_pointer enable row level security;
revoke all on public.forecast_versions, public.forecast_pointer from public, anon, authenticated;
grant all on public.forecast_versions, public.forecast_pointer to service_role;

create or replace function public.current_forecast() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('schema_version',1,'version',v.version,'issued_at',v.issued_at,
 'valid_until',v.valid_until,'manifest_bucket','forecast-data',
 'manifest_path',v.version || '/manifest.json','manifest_sha256',v.sha256)
 from public.forecast_pointer p join public.forecast_versions v on v.version=p.version
 where v.published and v.valid_until > now();
$$;
revoke all on function public.current_forecast() from public;
grant execute on function public.current_forecast() to anon, authenticated, service_role;

create or replace function public.stage_forecast(p_version text,p_issued_at timestamptz,
 p_valid_until timestamptz,p_manifest jsonb,p_sha256 text) returns text
language plpgsql security definer set search_path = '' as $$
declare existing public.forecast_versions; latest timestamptz; requested_bytes bigint; reserved_bytes bigint;
begin
 perform 1 from public.forecast_pointer where singleton for update;
 if p_valid_until <= now() or p_issued_at > now() + interval '5 minutes' then
  raise exception 'expired or future forecast issuance';
 end if;
 if p_manifest->>'version' is distinct from p_version or (p_manifest->>'issued_at')::timestamptz is distinct from p_issued_at
 or (p_manifest->>'valid_until')::timestamptz is distinct from p_valid_until then
  raise exception 'forecast manifest mismatch';
 end if;
 select v.issued_at into latest from public.forecast_versions v join public.forecast_pointer p on p.version=v.version;
 if latest > p_issued_at then return 'stale'; end if;
 select * into existing from public.forecast_versions where version=p_version;
 if found then
  if existing.sha256 <> p_sha256 then raise exception 'immutable forecast version'; end if;
  if existing.published then return 'unchanged'; end if;
 else
  select coalesce(sum((o->>'bytes')::bigint),0) into requested_bytes
   from jsonb_array_elements((p_manifest->'chunks') || (p_manifest->'tiles')) o;
  select coalesce(sum((o->>'bytes')::bigint),0) into reserved_bytes
   from public.forecast_versions v, lateral jsonb_array_elements((v.manifest->'chunks') || (v.manifest->'tiles')) o;
  if requested_bytes > 67108864 or reserved_bytes + requested_bytes > 268435456 then
   raise exception 'forecast storage reservation budget exceeded';
  end if;
  insert into public.forecast_versions(version,issued_at,valid_until,manifest,sha256)
  values(p_version,p_issued_at,p_valid_until,p_manifest,p_sha256);
 end if;
 return 'staged';
end; $$;

create or replace function public.activate_forecast(p_version text,p_sha256 text) returns text
language plpgsql security definer set search_path = '' as $$
declare candidate public.forecast_versions; latest timestamptz; current_manifest jsonb;
begin
 perform 1 from public.forecast_pointer where singleton for update;
 select * into strict candidate from public.forecast_versions where version=p_version;
 if candidate.sha256 <> p_sha256 or candidate.valid_until <= now() then raise exception 'invalid forecast'; end if;
 select v.issued_at into latest from public.forecast_versions v join public.forecast_pointer p on p.version=v.version;
 if latest > candidate.issued_at then return 'stale'; end if;
 select v.manifest into current_manifest from public.forecast_versions v join public.forecast_pointer p on p.version=v.version;
 if current_manifest is not null and (
  candidate.manifest #>> '{models,icon2i,run}' < current_manifest #>> '{models,icon2i,run}' or
  candidate.manifest #>> '{models,iconeu,run}' < current_manifest #>> '{models,iconeu,run}' or
  candidate.manifest->>'official_index_date' < current_manifest->>'official_index_date'
 ) then return 'stale'; end if;
 update public.forecast_versions set published=true where version=p_version;
 update public.forecast_pointer set version=p_version where singleton;
 return 'published';
end; $$;

create or replace function public.expired_forecasts() returns setof public.forecast_versions
language sql stable security definer set search_path = '' as $$
 select * from public.forecast_versions where valid_until <= now() - interval '7 days';
$$;
create or replace function public.forget_forecast(p_version text) returns void
language sql security definer set search_path = '' as $$
 delete from public.forecast_versions where version=p_version and valid_until <= now() - interval '7 days';
$$;
revoke all on function public.stage_forecast(text,timestamptz,timestamptz,jsonb,text),
 public.activate_forecast(text,text),public.expired_forecasts(),public.forget_forecast(text) from public,anon,authenticated;
grant execute on function public.stage_forecast(text,timestamptz,timestamptz,jsonb,text),
 public.activate_forecast(text,text),public.expired_forecasts(),public.forget_forecast(text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('forecast-data','forecast-data',true,5242880,array['application/json','application/octet-stream']),
 ('forecast-tiles','forecast-tiles',true,5242880,array['image/png'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
-- No anon/authenticated write policies. Public GET is intentionally not an account gate.
commit;
