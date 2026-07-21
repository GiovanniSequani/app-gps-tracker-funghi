from __future__ import annotations

import importlib

import numpy as np
import xarray as xr

hourly_buffer = importlib.import_module("backend.scripts.meteo.03_update_hourly_buffer")
deduplicate_latest_run_wins = hourly_buffer.deduplicate_latest_run_wins


def test_deduplicate_latest_run_wins_preserves_previous_finite_values() -> None:
    ds = xr.Dataset(
        data_vars={
            "t2m": (
                ("valid_time", "lat", "lon"),
                np.array([[[10.0]], [[12.0]]], dtype=np.float32),
            ),
            "smi9": (
                ("valid_time", "lat", "lon"),
                np.array([[[0.7]], [[np.nan]]], dtype=np.float32),
            ),
        },
        coords={
            "valid_time": np.array(["2026-07-18T15:00:00", "2026-07-18T15:00:00"], dtype="datetime64[s]"),
            "run_time": (
                "valid_time",
                np.array(["2026-07-18T12:00:00", "2026-07-18T14:00:00"], dtype="datetime64[s]"),
            ),
            "lat": np.array([46.0], dtype=np.float32),
            "lon": np.array([11.0], dtype=np.float32),
        },
    )

    out = deduplicate_latest_run_wins(ds)

    assert out.sizes["valid_time"] == 1
    assert out["run_time"].values[0] == np.datetime64("2026-07-18T14:00:00")
    assert float(out["t2m"].values[0, 0, 0]) == 12.0
    np.testing.assert_allclose(out["smi9"].values[0, 0, 0], np.float32(0.7))
