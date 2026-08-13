-- Allow a reserved GPX object to be inserted before Storage has persisted its
-- derived metadata. Bucket restrictions enforce the upload size and MIME type;
-- finalize_my_gpx_track verifies the stored size and MIME before setting ready.

create or replace function public.can_upload_user_gpx_object(
    p_name text,
    p_owner_id text,
    p_metadata jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
begin
    if caller_id is null or p_owner_id is distinct from caller_id::text then
        return false;
    end if;

    return exists (
        select 1
          from public.user_gpx_tracks track
         where track.user_id = caller_id
           and track.storage_path = p_name
           and track.status = 'pending_upload'
           and p_name = caller_id::text || '/' || track.id::text || '.gpx.gz'
    );
end;
$$;

