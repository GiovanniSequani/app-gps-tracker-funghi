# Dependency security and historical Google key

## Reproducible backend environment

The backend targets CPython 3.12 and is defined by `backend/pyproject.toml` plus
the transitive, hash-bearing `backend/uv.lock`. Do not use `pip freeze` from a
shared workstation: it includes unrelated scientific environments.

```powershell
uv sync --project backend --frozen
uv run --project backend python -m pytest backend/tests -q
```

GDAL is the one native prerequisite not installed from PyPI. Terrain scripts
must run from an OSGeo4W/GDAL environment compatible with Python 3.12; record
`gdalinfo --version` in operational evidence. It is not silently substituted
with an unrelated PyPI wheel.

## Dependency gate and SBOM

The gate audits the locked backend environment, `mobile/package-lock.json` and
the separate web lockfile, then writes CycloneDX JSON under the ignored
`backend/outputs/security/` directory:

```powershell
uv run --project backend python -m backend.scripts.security.dependency_gate
```

Use `--web-dir` if the web checkout is not the default sibling. A new advisory
fails the gate. An exception requires its exact GHSA, rationale, owner and an
unexpired review date in `security/dependency-exceptions.json`.

Baseline 2026-09-10: backend 0, web 0; `requests`, `pytest` and mobile direct
`fflate` were updated to their minimal fixed versions (`fflate` 0.8.3).
Residual mobile advisories are transitive Expo/Metro/build tooling or the React
Navigation decode branch and expire on 2026-10-10. Expo 54→57 is deliberately
deferred until compatibility and device testing.

## Historical Google API key

```powershell
uv run --project backend python -m backend.scripts.security.audit_historical_google_key
```

The command never prints key material. It proves only history presence and
absence from `HEAD`; revocation/restriction requires Google Cloud Console.
Open **APIs & Services → Credentials** for every project historically used.
The current map uses MapLibre and no current source references a Google key, so
delete/revoke the old key. If another verified use requires it, rotate it and
restrict it to the exact Android package plus production SHA-1 and only the
required API; configure quota alerts. Record only key ID/name, state,
restrictions and date, never the value.

No Git history rewrite is part of this remediation.
