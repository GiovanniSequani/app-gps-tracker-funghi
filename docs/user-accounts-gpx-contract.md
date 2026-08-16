# User accounts and private GPX archive contract

This contract is backend-owned. Mobile and web use the Supabase anon key plus
the signed-in user's JWT. The service-role key is permitted only in trusted
backend/admin jobs and must never be embedded in either client.

## Resources

| Resource | Access |
|---|---|
| Supabase Auth | Email/password; passwords remain only in `auth.users` |
| `public.gpx_archive_config` | Readable by anon/authenticated; writable only by service role |
| `public.user_profiles` | Authenticated user can read their row and update only `username` |
| `public.user_gpx_tracks` | Authenticated user can read only their rows; writes use RPCs |
| `public.user_gpx_mushroom_markers` | Authenticated user can read only markers on their tracks; writes use RPCs |
| Storage bucket `user-gpx` | Private; authenticated access only to owned, reserved paths |

Initial limits are 50 tracks, 10 MiB per compressed object and 50 MiB declared
uncompressed size. Clients must read the singleton config row and must not
hardcode these values.

```text
gpx_archive_config?singleton_id=eq.1
```

Changing plan does not change the client contract. A service-role backend can
call `configure_gpx_archive(max_tracks, max_compressed_bytes,
max_uncompressed_bytes)`; it updates both database configuration and the
bucket file-size limit.

## Registration and profile

Read the current legal-document versions from `gpx_archive_config`, show the
matching terms/privacy/research-consent text, then create the Auth user with
these signup metadata keys:

```json
{
  "username": "mario_rossi",
  "terms_accepted": true,
  "privacy_accepted": true,
  "raw_gpx_research_consent": true
}
```

For supabase-js these values belong in `signUp({ options: { data: ... } })`.
The database normalizes the username to lowercase and accepts only
`^[a-z0-9_]{3,24}$`. A trigger rejects signup if any acceptance is missing and
copies the current server-side document versions into `user_profiles`.
Username uniqueness is case-insensitive.

After authentication:

```text
GET/SELECT user_profiles where user_id = auth.uid()
PATCH/UPDATE user_profiles set username = <new username>
```

Column grants prevent clients from updating consent timestamps or user IDs.
Changing Auth `user_metadata` later does not change the application profile.

Research consent is mandatory at registration. It can subsequently be
withdrawn or granted again through:

```text
rpc('set_my_raw_gpx_research_consent', { p_granted: false | true })
```

Future research jobs must select only users whose profile currently has
`raw_gpx_research_consent = true`. Raw objects remain user-linked at rest for
access control; any research export must remove user ID, filename and Storage
path before model use.

The current consent explicitly covers raw GPX tracks. Mushroom markers are
separate user annotations: include them in research only after the legal text
and its version explicitly cover that use. The schema keeps raw data and edits
separate so this distinction remains enforceable.

## GPX object and metadata

Every object has one canonical, non-user-chosen path:

```text
<auth.uid()>/<track_id>.gpx.gz
```

The bucket is private. There are no permanent public URLs. Download with the
authenticated Storage API; if a signed URL is needed, keep it short-lived.
The preferred archive listing is `user_gpx_tracks`, not a global Storage
listing. Storage RLS still allows listing only objects inside the caller's own
folder and having matching metadata.

`content_sha256` is the lowercase SHA-256 of the exact compressed bytes that
will be uploaded. `compressed_size_bytes` is the exact byte length of those
same bytes. Optional bbox is:

```json
{"west": 10.1, "south": 45.2, "east": 10.4, "north": 45.5}
```

The raw `.gpx.gz` object and `storage_path` remain immutable after upload.
Simple edits are stored as reversible metadata and never rewrite or duplicate
the GPX object.

### Display name

`display_name` is the only user-visible track name. It is metadata and is
independent from both `original_filename` and the immutable Storage path. The
same database validator is used during reservation and later rename:

- surrounding spaces are removed;
- the resulting name must contain 1-120 characters;
- control characters, `/` and `\` are rejected;
- letters (including accented letters), numbers, spaces and ordinary
  punctuation are otherwise preserved.

Display names are not required to be unique. Clients must display and edit
`display_name`; they must never derive the visible name from `storage_path`.

## Upload sequence

Uploads are deliberately split into reservation, Storage upload and
finalization. Do not reorder these operations.

1. Compress the GPX as gzip and calculate compressed byte length and SHA-256.
2. Reserve quota and metadata:

```text
rpc('reserve_my_gpx_track', {
  p_display_name,
  p_original_filename,
  p_compressed_size_bytes,
  p_content_sha256,
  p_uncompressed_size_bytes, // optional
  p_started_at,              // optional ISO timestamptz
  p_ended_at,                // optional ISO timestamptz
  p_point_count,             // optional
  p_distance_m,              // optional
  p_bbox                     // optional
})
```

`p_display_name` is the name chosen by the user before upload. The RPC stores
its normalized value immediately and returns `id`, `display_name`, canonical
`storage_path`, `status`, configured maximum and remaining slots. Quota counting
is transactionally serialized per user and counts both pending and ready
records, so concurrent requests cannot exceed the database-configured limit.

3. Upload with the returned path:

```text
bucket:       user-gpx
path:         returned storage_path
content-type: application/gzip
upsert:       false
```

Storage RLS accepts the insert only for the authenticated owner and canonical
path of a pending reservation. The bucket enforces MIME and size limits;
finalization verifies the stored MIME and exact byte size. There is no UPDATE
policy, so an existing raw track cannot be overwritten.

4. Finalize:

```text
rpc('finalize_my_gpx_track', { p_track_id: id })
```

Finalization verifies the Storage row, owner, MIME and size and changes status
from `pending_upload` to `ready`. It is idempotent. If upload fails before an
object exists, release the reservation with
`delete_my_gpx_track_metadata({p_track_id: id})`.

## Listing and download

List only ready rows owned by the current user:

```text
user_gpx_tracks
  .select('*')
  .eq('status', 'ready')
  .order('created_at', { ascending: false })
```

RLS automatically adds the effective `user_id = auth.uid()` boundary. Download
the exact `storage_path` through the authenticated `user-gpx` Storage client.
Unauthenticated users receive no profile, metadata or object access.

## Rename

Rename a pending or ready track owned by the current authenticated user:

```text
rpc('rename_my_gpx_track', {
  p_track_id: track.id,
  p_new_name: 'Nome scelto'
})
```

The RPC applies the same normalization and validation used by
`reserve_my_gpx_track`, updates only `user_gpx_tracks.display_name`, and returns
the updated metadata row. It rejects IDs belonging to another user. It never
changes `storage_path`, `original_filename`, the Storage object or quota usage.

## Trim and mushroom markers

Editing requires a ready track with a non-null `point_count`. Point indices are
zero-based and refer to all GPX `trkpt` elements flattened in document order
across every `trkseg`. A client should retain the original segment boundaries
when rendering the selected interval.

Trim is inclusive and stored on `user_gpx_tracks` as
`trim_start_point_index` and `trim_end_point_index`. Both null means the full
raw track. Set or replace the trim with:

```text
rpc('set_my_gpx_track_trim', {
  p_track_id: track.id,
  p_trim_start_point_index: 15, // null means the raw first point
  p_trim_end_point_index: 420   // null means the raw last point
})
```

At least two points must remain. Passing both indices as null resets the trim;
requesting the complete raw bounds is normalized to the same null/null state.
The RPC returns the updated track row and never changes the Storage object.

A mushroom marker is anchored to one raw track-point index and stores
`latitude`, `longitude`, `species`, `count`, `created_at` and `updated_at`.
`species` is the stable lowercase code `porcini` or `finferli`; clients may
translate it only for presentation. `count` is the number of mushrooms of that
species recorded at that point, from 1 through 10000. Create or replace a
marker with:

```text
rpc('save_my_gpx_mushroom_marker', {
  p_track_id: track.id,
  p_track_point_index: 120,
  p_latitude: 46.36642,
  p_longitude: 11.50647,
  p_species: 'porcini',
  p_count: 3
})
```

There is at most one marker per track-point index and species. Therefore the
same point may contain both a porcini marker and a finferli marker, each with
its own count. Saving the same combination again updates its position and
count. Delete one species without affecting the other with:

```text
rpc('delete_my_gpx_mushroom_marker', {
  p_track_id: track.id,
  p_track_point_index: 120,
  p_species: 'porcini'
})
```

List markers through `user_gpx_mushroom_markers`, filtering by `track_id` and
ordering by `track_point_index`. RLS limits results to the owner. Authenticated
clients have SELECT only; all mutations use the owner-scoped RPCs. Clients must
snap marker coordinates to the selected GPX point because Postgres cannot
inspect the compressed object. Markers outside the current trim remain stored
but should be hidden; they reappear if the trim is expanded or reset.

## Delete sequence

1. Delete the owned Storage object through the Storage API.
2. Call:

```text
rpc('delete_my_gpx_track_metadata', { p_track_id: id })
```

The metadata RPC refuses deletion while the Storage object still exists. This
prevents a client from freeing quota while leaving an accessible object. Both
steps are safe to retry. Auth users that still own Storage objects must have
their GPX archive removed before an administrator deletes the Auth account.

## Backend research access

Trusted jobs use `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS. They may read
all metadata and download raw GPX objects, but must filter current research
consent and produce anonymized derived data. Never log JWTs, service keys,
emails, usernames, object paths or raw GPX content.

The SQL layer validates the canonical `.gpx.gz` suffix, reservation, exact
compressed size, MIME, hashes' shape, time ordering, numeric ranges and bbox.
Storage/Postgres cannot inspect gzip magic or parse GPX XML during a direct
client upload. The backend validator performs those checks before trusted use:

```powershell
python -m backend.scripts.supabase.validate_gpx_file path\to\track.gpx.gz
```

A future research/ingestion worker must call the same validator, use the limits
read from `gpx_archive_config`, and quarantine invalid objects before training.

## Applying and validating

Run the complete migration in Supabase SQL Editor:

```text
backend/supabase/migrations/202608060001_user_accounts_and_gpx_archive.sql
```

For a project where the account/GPX schema is already installed, also apply
the incremental display-name migration:

```text
backend/supabase/migrations/202608130001_gpx_display_name_and_rename.sql
```

Then apply the incremental editing migration:

```text
backend/supabase/migrations/202608160001_gpx_track_edits.sql
```

Finally apply the marker-species migration:

```text
backend/supabase/migrations/202608160002_gpx_marker_species.sql
```

Expected SQL Editor result is `Success. No rows returned`. Then, from the
repository root, run the read-only service-role audit:

```powershell
python -m backend.scripts.supabase.validate_user_gpx_setup
```

No new environment variables are required. The audit uses `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from `backend/.env`.
