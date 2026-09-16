-- Supabase Storage JS remove([path]) uses the batch-delete route, whose
-- operation name is storage.object.delete_many. Keep SELECT unavailable to
-- bucket listing and signed-URL routes while allowing this exact owner-only
-- deletion flow. The separate DELETE policy remains mandatory.

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
            'storage.object.delete_many'
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
