-- Increase only the forecast reservation budget: 256 MiB -> 512 MiB.
-- Keep the 64 MiB per-version cap, retention, locking and permissions unchanged.
begin;

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
  if requested_bytes > 67108864 or reserved_bytes + requested_bytes > 536870912 then
   raise exception 'forecast storage reservation budget exceeded';
  end if;
  insert into public.forecast_versions(version,issued_at,valid_until,manifest,sha256)
  values(p_version,p_issued_at,p_valid_until,p_manifest,p_sha256);
 end if;
 return 'staged';
end; $$;

revoke all on function public.stage_forecast(text,timestamptz,timestamptz,jsonb,text)
 from public,anon,authenticated;
grant execute on function public.stage_forecast(text,timestamptz,timestamptz,jsonb,text)
 to service_role;

commit;
