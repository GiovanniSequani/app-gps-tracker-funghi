-- The authenticated download endpoint evaluates both its object-info and
-- object-body operations. Permit exactly those two operations while keeping
-- signed URL creation and bucket listing unavailable to clients.

begin;

drop policy if exists user_gpx_objects_select_own on storage.objects;
create policy user_gpx_objects_select_own
    on storage.objects for select to authenticated
    using (
        bucket_id = 'user-gpx'
        and storage.allow_any_operation(array[
            'object.get_authenticated_info',
            'object.get_authenticated'
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

commit;
