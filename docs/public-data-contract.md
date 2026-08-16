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

The immutable version is `YYYY-MM-DD-<12 hex>`, where the suffix identifies the
content. The logical index date remains the separate `index_date` field. This
allows an HRS reanalysis to replace weather for the same date atomically. Only
the current version is readable through RLS. Publication stages all rows,
validates them in a database transaction, changes the pointer, and deletes the
previous version in the same transaction. At most two versions exist during
upload and one after publish. Clients must always follow the pointer and must
not derive or guess a version from the date.

### Source and sampling

Source: the 20-day HRS/ICON composition built from the canonical yearly series
in `backend/data/final/meteo/`.

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
normalized to `0`. It is the downslope direction with `0° = North`, `90° =
East`, `180° = South`, `270° = West`, increasing clockwise.

TPI category labels:

- `0`: `nodata`
- `1`: `sottoelevato` (`TPI < -10 m`)
- `2`: `in_media` (`-10 m <= TPI <= 10 m`)
- `3`: `sopraelevato` (`TPI > 10 m`)

On the real 350,000-cell source the classes were respectively 30.88%, 41.42%,
and 27.70% of valid cells, so the proposed ±10 m thresholds were retained.
Every chunk has a SHA-256 checksum and byte length in the manifest.

## Exact point index and porcini diagnostics

The dedicated public Storage bucket is `index-data`. It is separate from
`tiles` and `terrain`; clients never discover it through Storage listing:

```text
/storage/v1/object/public/index-data/current.json
/storage/v1/object/public/index-data/<version>/manifest.json
/storage/v1/object/public/index-data/<version>/chunks/rRR_cCC.bin.zlib
```

`current.json` contains `version`, `index_date`, `manifest_path`, and
`dataset_sha256`. A version is `<index-date>-<source-hash-prefix>`, so a
recalculation of the same date gets immutable URLs. Publication uploads and
verifies all chunks and the manifest before changing `current.json`. After the
pointer switch, cleanup uses only paths explicitly present in the old manifest.
At most one complete version remains after cleanup.

The grid is EPSG:4326, `500 × 700`, step `0.003°`, with ascending latitude and
longitude. Calculate `row`, `col`, chunk coordinates, and the cell offset with
the same formulas used by terrain:

```text
row = clamp(floor((latitude  - origin_lat) / step_deg + 0.5), 0, rows - 1)
col = clamp(floor((longitude - origin_lon) / step_deg + 0.5), 0, cols - 1)
chunk_row = floor(row / chunk_size.rows)
chunk_col = floor(col / chunk_size.cols)
local_row = row - chunk.row_offset
local_col = col - chunk.col_offset
cell_offset = (local_row * chunk.cols + local_col) * 30
```

Download the manifest entry for the deterministic chunk, verify its SHA-256,
decompress the complete payload with zlib, and then read this little-endian,
row-major, 30-byte cell:

| Offset | Field | Type | Decode |
|---:|---|---|---|
| 0 | `porcini_score` | float32 | exact final score 0–100 |
| 4 | `finferli_score` | float32 | exact final score 0–100 |
| 8 | `porcini_base_score` | uint16 | `value × 0.01`; nodata 65535 |
| 10 | `habitat` | uint8 | `value / 254`; nodata 255 |
| 11 | `potential` | uint8 | `value / 254`; nodata 255 |
| 12 | `trigger` | uint8 | `value / 254`; nodata 255 |
| 13 | `incubation` | uint8 | `value / 254`; nodata 255 |
| 14 | `moisture` | uint8 | `value / 254`; nodata 255 |
| 15 | `stress` | uint8 | `value / 254`; nodata 255 |
| 16 | `temp_score` | uint8 | `value / 254`; nodata 255 |
| 17 | `humidity_score` | uint8 | `value / 254`; nodata 255 |
| 18 | `post_rain_score` | uint8 | `value / 254`; nodata 255 |
| 19 | `drying_total` | uint8 | `value / 254`; nodata 255 |
| 20 | `drying_exposure_static` | uint8 | `value / 254`; nodata 255 |
| 21 | `retention_static` | uint8 | `value / 254`; nodata 255 |
| 22 | `rain_need_factor` | uint8 | `0.70 + value × 0.005`; nodata 255 |
| 23 | `temporal_phase` | uint8 | categorical temporal evidence; no nodata |
| 24 | `low_humidity_days` | uint8 | days with `rh_min < 42%`; nodata 255 |
| 25 | `temperature_band` | uint8 | categorical label below; nodata 0 |
| 26 | `presence_carryover` | uint16 | score points `value × 0.01`; nodata 65535 |
| 28 | `rain_recovery_seed` | uint16 | score points `value × 0.01`; nodata 65535 |

`porcini_score` and `finferli_score` preserve the original NetCDF float32 bits;
they are not inferred from tile colours and are not quantized. The explanatory
fields are compact diagnostics:

- `habitat`, `trigger`, `incubation`, `moisture`, and `stress` are the real
  components used by scoring version 0.2.0. Higher values are favourable.
- `potential` and the weather diagnostics use the lag that maximises
  `trigger × incubation × moisture`.
- `incubation` remains public because it is a real score component: it
  contributes 22% of the porcini dynamic mix and combines temperature
  suitability (42%), humidity suitability (30%), post-trigger rain (18%), and
  absence of drying stress (10%). It describes environmental suitability
  during incubation; it is not a clock and must not be converted into an
  early/late label.
- `drying_total` and `drying_exposure_static` are limiting when high;
  `retention_static` is favourable when high.
- `rain_need_factor > 1` means exposure/slope/topography require more rain;
  values below 1 reduce the required rain.
- `presence_carryover` and `rain_recovery_seed` are upward-only. The formula is
  `final = clip(base + max(presence_carryover, rain_recovery_seed), 0, 100)`;
  recovery never lowers a score.

`temporal_phase` is derived in the backend from the complete porcini potential
profile over the configured lags 7–16 days. It is not inferred by clients from
one selected lag:

- `0`: `non_determinabile`;
- `1`: `troppo_precoce`;
- `2`: `fase_favorevole`;
- `3`: `troppo_tardi`.

A peak is considered resolved only if it exceeds every competing lag by at
least `1/254`, matching one public unit-diagnostic quantization step. A unique
resolved peak at an interior lag, at least one resolution unit above both
neighbours, is `fase_favorevole`. A resolved peak at the longest lag, preceded
by a non-decreasing profile over the previous two lags, is `troppo_precoce`;
the mirrored condition at the shortest lag is `troppo_tardi`. Flat profiles, ties,
differences below resolution, incomplete data, or any shape that does not
support one of those conclusions are explicitly `non_determinabile`.
`best_lag_days` is intentionally not published because it is no longer needed
by the frontend and could invite a second, inconsistent phase heuristic.

The manifest stores the porcini thresholds and formula metadata once, rather
than duplicating text per cell. It includes temperature, humidity, rain, gust,
elevation and forest thresholds plus the exact weights for temperature,
humidity, drying, moisture, incubation, stress, potential, base score and
recovery. Frontends should combine this metadata with the compact cell values
to choose favourable/limiting labels. They must not infer an explanation from
the final score alone.

Temperature band labels use the real porcini mean-temperature trapezoid:

- `0`: `nodata`
- `1`: `molto_fredda`, below 5 °C
- `2`: `fredda`, 5–10 °C
- `3`: `ottimale`, 10–18 °C
- `4`: `calda`, above 18 through 24 °C
- `5`: `molto_calda`, above 24 °C

The manifest is the authoritative contract and repeats field offsets, scales,
nodata values, labels, thresholds, scoring notes, source checksums, chunk byte
lengths, raw byte lengths, and compressed-payload checksums.

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

Build/validate point index data locally:

```powershell
python -m backend.scripts.publication.publish_index_point --index-date YYYY-MM-DD --dry-run
```

Publish the exact point scores and porcini diagnostics:

```powershell
python -m backend.scripts.publication.publish_index_point --index-date YYYY-MM-DD
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
