-- Keep the arbitrary-UUID lifecycle helper private while allowing RLS to
-- evaluate the authenticated caller through the existing owner-only wrapper.
--
-- 202609090001 revoked authenticated EXECUTE on
-- has_current_contributor_access(uuid) to remove a cross-user status oracle.
-- The policies created by 202608310001 still invoked that function directly,
-- so PostgreSQL raised permission denied before it could evaluate ownership.

do $$
declare
    helper_owner oid;
    wrapper_owner oid;
    helper_security_definer boolean;
    wrapper_security_definer boolean;
begin
    select proowner, prosecdef
      into helper_owner, helper_security_definer
      from pg_catalog.pg_proc
     where oid = 'public.has_current_contributor_access(uuid)'::regprocedure;

    select proowner, prosecdef
      into wrapper_owner, wrapper_security_definer
      from pg_catalog.pg_proc
     where oid = 'public.has_my_current_contributor_access()'::regprocedure;

    if not helper_security_definer or not wrapper_security_definer then
        raise exception 'contributor access functions must remain SECURITY DEFINER';
    end if;
    if helper_owner is distinct from wrapper_owner then
        raise exception 'contributor access helper and wrapper must have the same owner';
    end if;
end;
$$;
revoke all on function public.has_current_contributor_access(uuid)
    from public, anon, authenticated;
grant execute on function public.has_current_contributor_access(uuid)
    to service_role;

revoke all on function public.has_my_current_contributor_access()
    from public, anon;
grant execute on function public.has_my_current_contributor_access()
    to authenticated, service_role;

drop policy if exists user_profiles_update_username on public.user_profiles;
create policy user_profiles_update_username
    on public.user_profiles for update to authenticated
    using (
        (select auth.uid()) = user_id
        and (select public.has_my_current_contributor_access())
    )
    with check (
        (select auth.uid()) = user_id
        and (select public.has_my_current_contributor_access())
    );

drop policy if exists user_gpx_tracks_read_own on public.user_gpx_tracks;
create policy user_gpx_tracks_read_own
    on public.user_gpx_tracks for select to authenticated
    using (
        (select auth.uid()) = user_id
        and (select public.has_my_current_contributor_access())
    );

drop policy if exists user_gpx_mushroom_markers_read_own
    on public.user_gpx_mushroom_markers;
create policy user_gpx_mushroom_markers_read_own
    on public.user_gpx_mushroom_markers for select to authenticated
    using (
        (select auth.uid()) = user_id
        and (select public.has_my_current_contributor_access())
    );

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects for select to authenticated
    using (
        bucket_id = 'user-gpx'
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

drop policy if exists user_gpx_objects_delete_own on storage.objects;
create policy user_gpx_objects_delete_own
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'user-gpx'
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

do $$
begin
    if pg_catalog.has_function_privilege(
        'authenticated',
        'public.has_current_contributor_access(uuid)',
        'EXECUTE'
    ) then
        raise exception 'authenticated must not execute arbitrary-UUID contributor helper';
    end if;

    if not pg_catalog.has_function_privilege(
        'authenticated',
        'public.has_my_current_contributor_access()',
        'EXECUTE'
    ) then
        raise exception 'authenticated must execute owner-only contributor wrapper';
    end if;

    if exists (
        select 1
          from pg_catalog.pg_policies
         where schemaname in ('public', 'storage')
           and policyname in (
               'user_profiles_update_username',
               'user_gpx_tracks_read_own',
               'user_gpx_mushroom_markers_read_own',
               'user_gpx_objects_select_own',
               'user_gpx_objects_delete_own'
           )
           and concat_ws(' ', qual, with_check)
               like '%has_current_contributor_access%'
    ) then
        raise exception 'RLS policy still invokes arbitrary-UUID contributor helper';
    end if;
end;
$$;
