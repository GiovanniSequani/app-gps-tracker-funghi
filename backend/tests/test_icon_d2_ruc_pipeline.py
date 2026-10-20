from __future__ import annotations

import importlib
from datetime import datetime, timezone

import numpy as np
import pytest
import requests
from unittest.mock import MagicMock

from backend.src.meteo import http

from backend.config.domain import BBOX, TARGET_STEP_DEG

download_ruc = importlib.import_module("backend.scripts.meteo.01_download_icon_d2_ruc_raw")
extract_ruc = importlib.import_module("backend.scripts.meteo.02_extract_icon_d2_ruc_hourly_fields")
automatic_ruc = importlib.import_module("backend.scripts.meteo.automatic_meteo_pipeline_ruc")


def test_ruc_url_uses_current_dwd_v1_layout() -> None:
    run_dt = datetime(2026, 7, 18, 14, tzinfo=timezone.utc)

    assert download_ruc.build_url(run_dt, "T_2M", 1).endswith(
        "/T_2M/r/2026-07-18T14%3A00/s/PT001H00M.grib2"
    )


def probe_response(status, payload=b"GRIB", retry_after=""):
    response = MagicMock()
    response.__enter__.return_value = response
    response.status_code = status
    response.headers = {"Retry-After": retry_after}
    response.iter_content.return_value = iter([payload])
    return response


@pytest.mark.parametrize("module", [download_ruc, automatic_ruc.download_d2])
@pytest.mark.parametrize("status", [200, 206, 404, 410])
def test_availability_uses_small_get_and_closes_stream(monkeypatch, module, status):
    response = probe_response(status)
    get = MagicMock(return_value=response)
    monkeypatch.setattr(http.requests, "get", get)
    monkeypatch.setattr(http.requests, "head", MagicMock(side_effect=AssertionError("HEAD must not be used")))
    assert module.url_exists("https://example.invalid/file", timeout=10) == (status in (200, 206))
    assert get.call_args.kwargs["headers"] == {"Range": "bytes=0-15", "Connection": "close"}
    assert get.call_args.kwargs["stream"] is True
    response.__exit__.assert_called_once()


@pytest.mark.parametrize("failure", [requests.ReadTimeout(), 429, 503])
def test_availability_retries_transient_failure(monkeypatch, failure):
    first = failure if isinstance(failure, Exception) else probe_response(failure, retry_after="2")
    get = MagicMock(side_effect=[first, probe_response(206)])
    monkeypatch.setattr(http.requests, "get", get)
    sleep = MagicMock()
    monkeypatch.setattr(http.time, "sleep", sleep)
    assert download_ruc.url_exists("https://example.invalid/file") is True
    assert get.call_count == 2
    sleep.assert_called_once()


@pytest.mark.parametrize("status,expected_calls", [(503, 3), (403, 1)])
def test_unknown_availability_never_becomes_missing(monkeypatch, status, expected_calls):
    get = MagicMock(side_effect=lambda *args, **kwargs: probe_response(status))
    monkeypatch.setattr(http.requests, "get", get)
    monkeypatch.setattr(http.time, "sleep", lambda _: None)
    with pytest.raises(RuntimeError):
        automatic_ruc.download_d2.url_exists("https://example.invalid/file")
    assert get.call_count == expected_calls


def test_ruc_filter_propagates_probe_failure(monkeypatch):
    monkeypatch.setattr(automatic_ruc, "ruc_run_available", MagicMock(side_effect=RuntimeError("network")))
    with pytest.raises(RuntimeError, match="network"):
        automatic_ruc.filter_ruc_available_runs(["2026101920"], [1, 2, 3, 4, 5, 6, 7])


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
