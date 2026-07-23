# FunghiTracker

This repository contains the mobile application and the data-processing backend:

- `mobile/`: Expo application shared by Android and iOS.
- `backend/`: meteo ingestion, index computation, tile generation, and publication.
- `docs/`: project invariants and maintenance notes.

The website remains in the separate `web-funghi-index` repository, which is also the source for GitHub Pages.

## Mobile

Run mobile commands from `mobile/`:

```powershell
cd mobile
npm ci
npm start
eas build --platform android --profile preview
```

The mobile environment belongs in `mobile/.env`; start from `mobile/.env.example`. Only `EXPO_PUBLIC_*` values may be used by the client.
The root `.easignore` limits the Git archive to `mobile/`, while `mobile/.easignore` keeps the app-level exclusions colocated with the EAS configuration.

## Backend

Run Python modules and tests from the repository root:

```powershell
python -m pytest backend/tests
backend\scripts\run_daily_fungus_pipeline.bat
```

Backend credentials belong in `backend/.env`; start from `backend/.env.example`. Never expose the Supabase service-role key to the mobile application.
