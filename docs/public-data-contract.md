# FunghiTracker public weather and terrain contract

Contract version: `1`.

The anonymous client uses only the Supabase project URL and anonymous key. The
service-role key remains in `backend/.env` and is used only by backend
publication scripts.

## Public weather

Supabase Postgres tables:

- `public_weather_state`: singleton pointer (`singleton_id=1`) to the current
  complete version.
- `public_weather_datasets`: dates, regular-grid geometry, encoding and
  checksum for one version.
- `public_weather_cells`: one row per grid cell and version, with five
  20-element `smallint[]` arrays.

The version is the index date in `YYYY-MM-DD` form. Only the current version is
readable through RLS. Publication stages all rows, validates them in a database
transaction, changes the pointer, and deletes the previous version in the same
transaction. At most two versions exist during upload and one after publish.

### Source and sampling

Source: `backend/data/final/meteo/meteo_recent_003deg.nc`.

The builder always creates the 20 consecutive calendar slots ending on the
index date. Missing source days and non-finite source values are encoded as
nodata in the corresponding array positions; future days are never selected.
It rejects unexpected dimensions, units, grid orientation and quantization
overflow.

The source grid has ascending latitude and longitude, source-cell centres at
approximately `(south + 0.0015, west + 0.0015)`, and nominal step `0.003°`.
The public grid selects source indices `0, 6, 12, ...` on both axes. This is
direct representative-cell sampling:

- no interpolation;
- no spatial averaging;
- precipitation is never spatially summed.

The resulting grid is `84 × 117` (`9,828` cells) with nominal step `0.018°`.
The exact first sampled latitude and longitude are stored as `origin_lat` and
`origin_lon`.

Verified source units on 2026-07-25:

| Field | Source/public unit | Database encoding |
|---|---|---|
| `t2m_min` | `degC` | value × 10, `smallint` |
| `t2m_max` | `degC` | value × 10, `smallint` |
| `precip_sum` | `mm` | value × 10, `smallint` |
| `rh_mean` | `%` | value × 10, `smallint` |
| `gust_max` | `km h-1` | value × 10, `smallint` |

The reserved nodata value is `-32768`; clients decode it as `NaN`. A valid
encoded value decodes as `encoded * 0.1`. Metadata includes
`available_day_count` and `missing_dates`. The observed real ranges fit safely
in `smallint` at tenths precision.

### Client lookup

Fetch the pointer:

```http
GET /rest/v1/public_weather_state?select=current_version&singleton_id=eq.1
apikey: <anon-key>
Authorization: Bearer <anon-key>
```

Fetch current metadata (RLS exposes only the pointed version):

```http
GET /rest/v1/public_weather_datasets?select=*
```

For a coordinate inside `bbox`, calculate the nearest representative cell:

```text
row = clamp(floor((latitude  - origin_lat) / step_deg + 0.5), 0, rows - 1)
col = clamp(floor((longitude - origin_lon) / step_deg + 0.5), 0, cols - 1)
```

Reject coordinates outside `bbox`. Then request:

```http
GET /rest/v1/public_weather_cells?select=t2m_min,t2m_max,precip_sum,rh_mean,gust_max&row_idx=eq.<row>&col_idx=eq.<col>
```

Array position `i` corresponds to `public_weather_datasets.dates[i]`.

## Static terrain

The dedicated public Storage bucket is `terrain`; it is unrelated to the
`tiles` bucket. Discovery never lists Storage. Clients read:

```text
/storage/v1/object/public/terrain/current.json
/storage/v1/object/public/terrain/<version>/manifest.json
/storage/v1/object/public/terrain/<version>/chunks/rRR_cCC.bin
```

`current.json` points to the immutable version manifest. Chunks and version
manifests use a one-year immutable cache; only `current.json` has a short
revalidation cache. A new version is uploaded completely before the pointer is
changed. Cleanup reads the old manifest and deletes only its explicit paths
from the `terrain` bucket; it never lists Storage and never accesses `tiles`.

### Grid and chunk lookup

The terrain grid remains EPSG:4326, `500 × 700`, step `0.003°`, with ascending
latitude and longitude. For a coordinate inside the manifest `bbox`:

```text
row = clamp(floor((latitude  - origin_lat) / step_deg + 0.5), 0, rows - 1)
col = clamp(floor((longitude - origin_lon) / step_deg + 0.5), 0, cols - 1)

chunk_row = floor(row / 50)
chunk_col = floor(col / 50)
local_row = row % 50
local_col = col % 50
```

Use the manifest chunk entry because edge chunks may be smaller than `50 × 50`.
The byte offset is:

```text
cell_offset = (local_row * chunk.cols + local_col) * 6
```

Each row-major cell is six little-endian bytes:

| Offset | Field | Type | Scale | Unit | Nodata |
|---:|---|---|---:|---|---:|
| 0 | elevation | `int16` | 1 | m | -32768 |
| 2 | forest percentage | `uint8` | 1 | % | 255 |
| 3 | aspect | `uint16` | 1 | degree | 65535 |
| 5 | TPI category | `uint8` | 1 | category | 0 |

Forest percentage is `clip(pct_broadleaf + pct_conifer, 0, 100)`, rounded to
the nearest integer. Aspect is rounded to integer degrees and `360` is
normalized to `0`.

TPI category labels:

- `0`: `nodata`
- `1`: `sottoelevato` (`TPI < -10 m`)
- `2`: `in_media` (`-10 m <= TPI <= 10 m`)
- `3`: `sopraelevato` (`TPI > 10 m`)

On the real 350,000-cell source the classes were respectively 30.88%, 41.42%,
and 27.70% of valid cells, so the proposed ±10 m thresholds were retained.
Every chunk has a SHA-256 checksum and byte length in the manifest.

## Backend commands

Build/validate weather locally:

```powershell
python -m backend.scripts.publication.publish_weather --index-date YYYY-MM-DD --dry-run
```

Publish weather after applying the SQL migration:

```powershell
python -m backend.scripts.publication.publish_weather --index-date YYYY-MM-DD
```

Build/validate terrain locally:

```powershell
python -m backend.scripts.publication.publish_terrain --version v1 --dry-run
```

Publish terrain once:

```powershell
python -m backend.scripts.publication.publish_terrain --version v1
```

The daily pipeline publishes weather only after successful index and tile work
for that date (or directly after the index when `--skip-tiles` is used). A
weather failure is logged and returned as a non-zero pipeline result only after
tile cleanup, so it cannot suppress existing tile publication or retention.
Use `--skip-weather-publication` while deploying the migration or for an
explicit backend-only skip.

Before writing Postgres, the publisher reads exactly
`tiles/tile_sets.json`—never a recursive listing. It publishes only when the
requested date equals the newest index date in that manifest. Older backfills
are successful no-ops for weather, while a requested date newer than the
manifest is rejected. The database preparation RPC independently rejects a
version older than the current weather pointer, protecting concurrent runs.

Apply `backend/supabase/migrations/202607250001_public_weather_and_terrain.sql`
in the Supabase SQL Editor as a project owner. The backend REST key cannot run
arbitrary migration SQL, so merely running the Python publishers does not apply
the migration.
