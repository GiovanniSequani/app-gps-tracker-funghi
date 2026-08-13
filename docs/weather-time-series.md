# Weather time-series operations

The daily downloader and complete-day publication gates are unchanged. After a
day reaches the existing aggregation/regridding gate, step 06 updates:

```text
backend/data/final/meteo/icon_ruc_time_series_YYYY.nc
backend/data/final/meteo/recovery_icon_ruc_time_series_YYYY.nc
```

The update is written to a temporary NetCDF one day at a time, validated, then
atomically promoted. Duplicate dates use the new complete daily input. The
recovery file is refreshed only from the validated active series. Legacy
`historic/meteo_recent_003deg_*.nc` files are used only for the first bootstrap;
no new snapshots are created.

## Index weather selection

For an index date the backend constructs exactly 19 calendar days ending on
that date. Each date uses:

1. the validated HRS day when all required variables and cells are valid;
2. otherwise the ICON-D2-RUC day;
3. otherwise nodata for that calendar date.

HRS gusts are verified as metres per second and converted to kilometres per
hour. `gust_mean` is not fabricated because the score only consumes
`gust_max`. The public 20-day weather dataset uses the same HRS/ICON composition.

## Importing HRS

Put the manually prepared NetCDF under `backend/data/` and run commands from
the repository root.

Validation only:

```powershell
python -m backend.scripts.meteo.validate_hrs --name backend/data/HRS_YYYYMMDD_YYYYMMDD.nc
```

Preview a complete run:

```powershell
python -m backend.scripts.meteo.run_hrs_reanalysis --name backend/data/HRS_YYYYMMDD_YYYYMMDD.nc --dry-run
```

Merge HRS without changing indices or Supabase:

```powershell
python -m backend.scripts.meteo.run_hrs_reanalysis --name backend/data/HRS_YYYYMMDD_YYYYMMDD.nc --merge-only
```

Merge and rebuild affected local indices without publication:

```powershell
python -m backend.scripts.meteo.run_hrs_reanalysis --name backend/data/HRS_YYYYMMDD_YYYYMMDD.nc --no-publish
```

Complete merge, chronological rebuild and publication:

```powershell
python -m backend.scripts.meteo.run_hrs_reanalysis --name backend/data/HRS_YYYYMMDD_YYYYMMDD.nc
```

The complete mode reads the exact `tiles/tile_sets.json` object and republishes
only affected dates currently retained there. New tile versions are uploaded
under a fresh `_vN` prefix. The manifest switches only after all new tiles are
uploaded, then the known old prefixes are removed. No recursive listing is used
for discovery. If the latest retained date changed, `index-data` and public
weather are also rebuilt from the corrected composition.

The script is deliberately rerunnable with the same HRS file. This supports
recovery after a failed index, tile or manifest publication.
