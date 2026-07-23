import numpy as np
import xarray as xr

from backend.scripts import run_daily_fungus_pipeline as pipeline
from backend.scripts.run_daily_fungus_pipeline import publication_gate


def test_publication_gate_accepts_day_21_run() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026062921"})

    assert ready is True
    assert "2026062921 processed" in reason


def test_publication_gate_waits_after_day_18_run_only() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918"})

    assert ready is False
    assert "waiting for 2026062921" in reason


def test_publication_gate_accepts_18_run_after_later_day_run() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026063000"})

    assert ready is True
    assert "fallback" in reason


def test_publication_gate_does_not_treat_later_same_day_run_as_fallback() -> None:
    ready, reason = publication_gate("2026-06-29", {"2026062918", "2026062922"})

    assert ready is False
    assert "waiting for 2026062921" in reason


def test_publishable_dates_include_rolling_day_without_snapshot(tmp_path, monkeypatch) -> None:
    rolling_path = tmp_path / "meteo_recent_003deg.nc"
    ds = xr.Dataset(coords={"time": np.array(["2026-07-20", "2026-07-21"], dtype="datetime64[D]")})
    ds.to_netcdf(rolling_path)

    monkeypatch.setattr(pipeline, "ROLLING_METEO_NC", rolling_path)
    monkeypatch.setattr(pipeline, "FINAL_METEO_HISTORIC_DIR", tmp_path / "historic")
    monkeypatch.setattr(pipeline, "is_fully_published", lambda date: date == "2026-07-20")

    publishable = pipeline.publishable_unpublished_dates_until(
        "2026-07-20",
        "2026-07-22",
        {"2026072120"},
        "icon-d2-ruc",
        1,
    )

    assert publishable == ["2026-07-21"]
