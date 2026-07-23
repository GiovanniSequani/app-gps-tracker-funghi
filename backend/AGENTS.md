# Backend guidance

- Run modules as `python -m backend...` from the repository root.
- Use paths derived from `backend.config.paths` or `__file__`; do not depend on the caller's working directory.
- Preserve rolling meteo recovery, publication gates, tile retention, and existing map tile contracts.
- Keep generated data under `backend/data`, outputs under `backend/outputs`, and logs under `backend/logs`.
- Add focused tests for changes to shared pipeline, scoring, publication, or retention behavior.
- Backend secrets belong in `backend/.env` and must never be exposed to the mobile application.
