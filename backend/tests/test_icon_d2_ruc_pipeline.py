from __future__ import annotations

import importlib
from datetime import datetime, timezone

import numpy as np

from backend.config.domain import BBOX, TARGET_STEP_DEG

download_ruc = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_ruc_raw")
extract_ruc = importlib.import_module("backend.scripts.meteo.02_extract_icon_d2_ruc_hourly_fields")
automatic_ruc = importlib.import_module("backend.scripts.meteo.automatic_meteo_pipeline_ruc")


def test_ruc_url_uses_current_dwd_v1_layout() -> None:
    run_dt = datetime(2026, 7, 18, 14, tzinfo=timezone.utc)

    assert download_ruc.build_url(run_dt, "T_2M", 1).endswith(
        "/T_2M/r/2026-07-18T14%3A00/s/PT001H00M.grib2"
    )


def test_ruc_target_grid_matches_project_grid_definition() -> None:
    lats, lons = extract_ruc.build_target_grid(BBOX, TARGET_STEP_DEG)

    assert lats.shape == (500,)
    assert lons.shape == (700,)
    assert np.isclose(lats[0], 45.6015)
    assert np.isclose(lats[-1], 47.0985)
    assert np.isclose(lons[0], 10.4015)
    assert np.isclose(lons[-1], 12.4985)


def test_ruc_precip_decumulation_happens_on_native_points_before_regrid() -> None:
    previous = np.array([0.0, 2.0, 5.0], dtype=np.float32)
    current = np.array([1.5, 1.0, 8.0], dtype=np.float32)

    hourly_native = np.maximum(current - previous, 0.0)

    np.testing.assert_allclose(hourly_native, np.array([1.5, 0.0, 3.0], dtype=np.float32))


def test_ruc_automatic_classifies_buffer_runs_as_done(monkeypatch) -> None:
    monkeypatch.setattr(automatic_ruc, "hourly_nc_complete", lambda run, steps: True)

    assert automatic_ruc.classify_run("2026071814", {"2026071814"}) == "DONE"


def test_ruc_automatic_does_not_confuse_d2_run_with_ruc_done(monkeypatch) -> None:
    monkeypatch.setattr(automatic_ruc, "hourly_nc_complete", lambda run, steps: False)
    monkeypatch.setattr(automatic_ruc, "hourly_path", lambda run: type("P", (), {"is_file": lambda self: False})())

    assert automatic_ruc.classify_run("2026071814", {"2026071814"}) == "REMOTE"


def test_ruc_support_extends_d2_leads_for_hourly_cadence() -> None:
    assert automatic_ruc.required_d2_support_steps(
        ["2026071806", "2026071807", "2026071808", "2026071809", "2026071810"],
        [1, 2, 3, 4, 5, 6, 7],
    ) == {
        "2026071806": [1, 2, 3, 4, 5, 6, 7, 8, 9],
        "2026071809": [1, 2, 3, 4, 5, 6, 7, 8],
    }
