-- Restore authenticated owner deletion after the signed-URL hardening.
-- Storage remove evaluates SELECT and DELETE policies under object.delete;
-- the previous SELECT allow-list only admitted authenticated download stages,
-- so remove returned success without deleting the storage.objects row.

begin;

do $$
begin
    if to_regprocedure('storage.allow_any_operation(text[])') is null then
        raise exception 'storage.allow_any_operation(text[]) is required';
    end if;
end;
$$;

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects for select to authenticated
    using (
        bucket_id = 'user-gpx'
        and storage.allow_any_operation(array[
            'object.get_authenticated_info',
            'object.get_authenticated',
            'object.delete'
        ])
        and owner_id = (select auth.uid()::text)
        and (storage.foldername(name))[1] = (select auth.uid()::text)
        and (select public.has_my_current_contributor_access())
        and exists (
            select 1
              from public.user_gpx_tracks track
             where track.user_id = (select auth.uid())
               and track.storage_path = name
        )
    );

-- Keep the existing DELETE policy authoritative as well. Fail migration if a
-- partially applied schema would otherwise leave deletion without its owner,
-- lifecycle or metadata checks.
do $$
declare
    delete_policy text;
begin
    select coalesce(qual, '')
      into delete_policy
      from pg_catalog.pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and policyname = 'user_gpx_objects_delete_own'
       and cmd = 'DELETE';

    if delete_policy is null
       or delete_policy not like '%user-gpx%'
       or delete_policy not like '%auth.uid%'
       or delete_policy not like '%has_my_current_contributor_access%'
       or delete_policy not like '%user_gpx_tracks%' then
        raise exception 'owner-only GPX Storage DELETE policy is missing or incomplete';
    end if;

    if not pg_catalog.has_function_privilege(
        'authenticated',
        'public.delete_my_gpx_track_metadata(uuid)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'anon',
        'public.delete_my_gpx_track_metadata(uuid)',
        'EXECUTE'
    ) then
        raise exception 'GPX metadata delete RPC grants are inconsistent';
    end if;
end;
$$;

commit;
