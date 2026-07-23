# Repository guidance

- `mobile/` is the Expo application for both Android and iOS.
- `backend/` owns meteo ingestion, index computation, tiles, retention, and publication.
- Run Expo, npm, and EAS commands from `mobile/`.
- Run backend Python modules and tests from the repository root.
- Never commit `.env`, scientific datasets, generated tiles, logs, or native signing material.
- Preserve the map camera invariants documented in `docs/map-camera-rules.md`.
- Keep changes scoped to one component unless the task explicitly crosses the mobile/backend contract.
