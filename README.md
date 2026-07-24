# FunghiTracker

FunghiTracker is a mobile application that maps daily environmental suitability
for porcini and chanterelle mushrooms. Its backend combines weather forecasts,
terrain and forest data to calculate the index, generate map tiles and publish
them to the app.

This repository contains:

- `mobile/`: the Expo application for Android and iOS;
- `backend/`: weather ingestion, index calculation, tile generation and
  publication;
- `docs/`: technical rules and maintenance notes.

The public website is maintained separately in
[`web-funghi-index`](https://github.com/GiovanniSequani/web-funghi-index), which
is also the source of the GitHub Pages deployment.

## How to use

### Requirements

- Node.js and npm;
- an [Expo](https://expo.dev/) account and EAS CLI;
- Python 3.12;
- [OSGeo4W](https://trac.osgeo.org/osgeo4w/) with GDAL and its Python bindings;
- Python packages: `numpy`, `pandas`, `requests`, `xarray`, `scipy`, `netCDF4`
  and `python-dotenv`.

Run all backend commands from the repository root. The current Windows weather
launcher uses the local OSGeo4W paths in
`backend/scripts/meteo/run_auto_meteo_ruc.bat`; update those two paths if
OSGeo4W is installed elsewhere.

### Build the Android app

```powershell
cd mobile
npm ci
Copy-Item .env.example .env
```

Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in
`mobile/.env`, then build the tester APK:

```powershell
eas login
eas build --platform android --profile preview
```

### Prepare the backend

Large geospatial datasets are not stored in Git. Before the first run, provide:

| File | Purpose |
| --- | --- |
| `backend/data/raw/dem/dsm_30m.tif` | Digital elevation model |
| `backend/data/intermediate/forest/dlt_2023_mosaic.tif` | Categorical forest raster: broadleaf, conifer and non-forest |
| `backend/data/final/meteo/meteo_recent_003deg.nc` | Initial rolling weather history, ideally 19 complete local days |

The weather history is the bootstrap file. The index requires at least 8
complete days and uses up to the latest 19; after bootstrap, the pipeline keeps
this dataset updated automatically.

Build the static terrain dataset once, using the Python interpreter configured
by OSGeo4W:

```powershell
python -m backend.scripts.terrain.01_prepare_dem
python -m backend.scripts.terrain.02_prepare_forest
python -m backend.scripts.terrain.03_build_static_terrain_nc
```

This creates
`backend/data/final/static/terrain_static_003deg.nc`.

To calculate the index from the available static and weather data:

```powershell
python -m backend.scripts.index.run_index_pipeline
```

To run the complete daily workflow, including weather updates, index
calculation and tile publication:

```powershell
Copy-Item backend/.env.example backend/.env
backend\scripts\run_daily_fungus_pipeline.bat
```

For publication, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in
`backend/.env`. To run the daily workflow without creating or uploading map
tiles, add `--skip-tiles`.

## How the backend works

1. **Weather ingestion** downloads hourly DWD ICON-D2-RUC data for air
   temperature, humidity, precipitation, wind gusts and ground temperature.
   Soil moisture (`smi9`) is supplied by the three-hourly ICON-D2 model.
2. **Weather processing** regrids the fields to the project grid, retains the
   most recent valid forecast for each hour and aggregates complete days in the
   `Europe/Rome` timezone.
3. **Static processing** derives elevation, slope, aspect, topographic position
   and forest composition from the DEM and forest raster.
4. **Index calculation** combines the recent weather window with the static
   habitat variables. Species-specific rules produce separate porcini and
   chanterelle scores; previous conditions also influence subsequent days
   through temporal carry-over and recovery components.
5. **Publication** converts each daily index into PNG map tiles, uploads them to
   Supabase Storage and updates `tile_sets.json`, the manifest read by the
   clients.

## Data products

The main index output is:

```text
backend/outputs/index_nc/funghi_index_YYYY-MM-DD.nc
```

It is a NetCDF dataset in EPSG:4326 covering longitude `10.4-12.5` and latitude
`45.6-47.1`. The grid contains `700 x 500` cells at `0.003 degrees`
(approximately 230-330 metres across the covered area). For each species, it
stores the final score and its main components, including habitat, rainfall
trigger, incubation, moisture, stress, temporal carry-over and recovery.

The backend also maintains:

- a 48-hour rolling hourly weather buffer;
- a 20-day rolling daily weather dataset and complete-day historical snapshots;
- raw weather runs, retained locally for 30 days;
- daily index NetCDF files and processing logs;
- local and remote PNG tiles for zoom levels 3-13;
- a 30-day rolling set of published tiles in Supabase Storage.

The score describes environmental suitability. It is not a guarantee that
mushrooms are present at a specific location.
