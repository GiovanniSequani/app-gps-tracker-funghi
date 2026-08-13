# FunghiTracker modelling context

## Purpose

This document is a handoff for a future Codex chat dedicated to modelling and
fine-tuning the FunghiTracker index. The long-term objective is to start from
raw GPX tracks whose users currently authorize research use and determine
whether those data can support improvements to the existing rule-based scoring
algorithm.

This is context, not a modelling specification. It deliberately makes no
decision about GPX parsing or preprocessing, dataset construction,
observational targets, Bayesian or other model families, evaluation metrics,
or integration of a future result into production scoring.

## Current project state

FunghiTracker currently has a Python backend that ingests weather data, builds
terrain and weather features, computes daily suitability scores, generates map
tiles, and publishes client-facing datasets to Supabase. It produces separate
scores for:

- `porcini`;
- `finferli` (chanterelles).

The operational index is defined on an EPSG:4326 regular grid with 500 latitude
rows and 700 longitude columns. Cell centres are spaced by `0.003 degrees`
(roughly 230-330 metres across the project area), with ascending latitude and
longitude. The current domain is approximately longitude `10.4-12.5` and
latitude `45.6-47.1`.

The existing algorithm is rule-based and combines daily weather, static
terrain/habitat features, species-specific thresholds and weights, and temporal
carry-over/recovery. The repository implementation is authoritative; public
diagnostics are only a compact representation of parts of that calculation.

## Backend map

Read repository-level `AGENTS.md`, `backend/AGENTS.md`, and `README.md` before
working. Run backend Python modules and tests from the repository root.

| Area | Authoritative location |
|---|---|
| Species configuration, thresholds and weights | `backend/config/index_config.py` |
| Feature construction | `backend/src/index/features.py` |
| Scoring, lag candidates, carry-over and recovery | `backend/src/index/scoring.py` |
| Feature-build command | `backend/scripts/index/01_build_index_features.py` |
| Index computation command | `backend/scripts/index/02_compute_funghi_index.py` |
| Combined index pipeline | `backend/scripts/index/run_index_pipeline.py` |
| Daily meteo/index/tile/publication orchestration | `backend/scripts/run_daily_fungus_pipeline.py` |
| Intermediate feature NetCDFs | `backend/data/intermediate/index/index_features_YYYY-MM-DD.nc` |
| Final index NetCDFs | `backend/outputs/index_nc/funghi_index_YYYY-MM-DD.nc` |
| Local generated tiles | `backend/outputs/tiles_local/` |
| Tile generation/upload and retention | `backend/scripts/tiles/01_build_tiles_gdal.py` |
| Supabase publication builders | `backend/src/publication/` |
| Supabase publication entry points | `backend/scripts/publication/` |
| Supabase REST/Storage publishers | `backend/src/publication/supabase.py` |

Tiles are published to the Supabase Storage bucket `tiles`; `tile_sets.json` is
the client discovery manifest. Exact point scores and compact porcini
diagnostics are separately published in the `index-data` bucket through an
atomic `current.json` pointer and immutable version manifests/chunks. Public
weather and terrain use their own contracts and publication paths. Do not infer
numeric scores by sampling tile colours.

## Contracts to read

Before designing any modelling workflow, read both documents completely:

- `docs/user-accounts-gpx-contract.md`: accounts, consent, GPX metadata,
  private Storage paths, quotas, access control and trusted validation;
- `docs/public-data-contract.md`: weather, terrain, exact point-index data,
  grid lookup, binary layouts, score diagnostics and atomic publication.

These contracts describe current production interfaces. A modelling
experiment must not silently change them.

## Current cloud GPX storage

User tracks are stored as gzip-compressed `.gpx.gz` objects in the private
Supabase Storage bucket `user-gpx`. The canonical object path is:

```text
<user_id>/<track_id>.gpx.gz
```

The main Supabase resources are:

- `public.user_profiles`: application profile and current raw-GPX research
  consent state/version;
- `public.user_gpx_tracks`: per-track metadata and canonical Storage path;
- `public.gpx_archive_config`: database-controlled quotas, size limits and
  legal/consent document versions;
- private Storage bucket `user-gpx`: raw compressed GPX objects.

The initial configuration allows 50 tracks per user, 10 MiB per compressed
object and 50 MiB declared uncompressed size. These values are configurable in
the database and must be read from `gpx_archive_config`, not assumed by future
jobs.

Track metadata can include display/original filename, compressed and declared
uncompressed sizes, SHA-256, timestamps, point count, distance and bounding
box. Upload is reservation-based and becomes `ready` only after Storage
validation/finalization. Storage/Postgres do not parse the GPX body. The
trusted local validator is available through:

```powershell
python -m backend.scripts.supabase.validate_gpx_file path\to\track.gpx.gz
```

Treat the GPX contract as the authority for the exact schema and lifecycle.

## Privacy and security constraints

- Use raw tracks only when the corresponding user's current
  `raw_gpx_research_consent` is `true`.
- Consent can be withdrawn; a future extraction or training run must evaluate
  the current consent state rather than relying only on consent at signup.
- Raw objects remain user-linked at rest for access control, but modelling
  datasets and outputs must not contain user IDs, usernames, email addresses,
  filenames, Storage paths or other nominative outputs.
- Never log raw GPX content, JWTs, credentials or identifying object paths.
- Cross-user access is reserved for trusted backend/admin jobs. The Supabase
  service-role key may be used only in backend scripts or other trusted server
  execution and must never be exposed to mobile, web or public artifacts.
- Validate objects and respect the current database-configured limits before
  trusted use; invalid objects must not flow silently into modelling work.

## Explicitly undecided modelling work

The following topics have not been designed or approved and belong to the
future modelling chat:

- how GPX XML is parsed and which raw fields are retained;
- cleaning, filtering, resampling, segmentation or other GPX preprocessing;
- how tracks or points are transformed into a modelling dataset;
- spatial or temporal joins with weather, terrain, index or other data;
- the observational target and what constitutes positive, negative, absent or
  uncertain evidence;
- sampling strategy, bias handling, leakage prevention and train/validation
  splits;
- Bayesian models or any alternative statistical or machine-learning model;
- priors, features, labels, calibration and uncertainty representation;
- evaluation metrics and acceptance criteria;
- how, whether or where a fitted result would modify the existing scoring
  formula;
- production retraining, versioning, rollout, rollback and monitoring.

Do not treat the mere presence of a GPX point or track as an observation of a
mushroom, a non-observation, or a ground-truth score unless the future
modelling design establishes and justifies that interpretation.

