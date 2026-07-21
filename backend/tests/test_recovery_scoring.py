from __future__ import annotations

import numpy as np
import xarray as xr

from backend.src.index.scoring import _compute_recovery


def _field(value: float) -> xr.DataArray:
    return xr.DataArray(
        np.array([[value]], dtype=np.float32),
        coords={"lat": [45.0], "lon": [9.0]},
        dims=("lat", "lon"),
    )


def _scalar(value: xr.DataArray) -> float:
    return float(value.values.item())


def _dynamic(trigger: float = 0.2, moisture: float = 0.2, stress: float = 0.2) -> xr.Dataset:
    return xr.Dataset(
        {
            "trigger": _field(trigger),
            "moisture": _field(moisture),
            "stress": _field(stress),
        }
    )


def _history(score: float, moisture: float = 1.0, stress: float = 1.0) -> list[tuple[int, xr.Dataset]]:
    return [
        (
            1,
            xr.Dataset(
                {
                    "porcini_score": _field(score),
                    "porcini_moisture": _field(moisture),
                    "porcini_stress": _field(stress),
                }
            ),
        )
    ]


def _with_aux_lag(value: xr.DataArray, lag: int) -> xr.DataArray:
    return value.assign_coords(lag=(("lat", "lon"), np.array([[lag]], dtype=np.int32)))


def test_presence_carryover_raises_lower_base_score() -> None:
    recovery = _compute_recovery(
        base_score=_field(50.0),
        habitat=_field(0.8),
        dynamic=_dynamic(),
        species="porcini",
        history=_history(70.0),
        enable_recovery=True,
    )

    assert _scalar(recovery["score"]) == 60.0
    assert _scalar(recovery["presence_carryover"]) == 10.0


def test_presence_carryover_never_lowers_better_current_score() -> None:
    recovery = _compute_recovery(
        base_score=_field(80.0),
        habitat=_field(0.8),
        dynamic=_dynamic(),
        species="porcini",
        history=_history(70.0),
        enable_recovery=True,
    )

    assert _scalar(recovery["score"]) == 80.0
    assert _scalar(recovery["presence_carryover"]) == 0.0


def test_presence_threshold_requires_high_previous_score() -> None:
    recovery = _compute_recovery(
        base_score=_field(50.0),
        habitat=_field(0.8),
        dynamic=_dynamic(),
        species="porcini",
        history=_history(69.0),
        enable_recovery=True,
    )

    assert _scalar(recovery["score"]) == 50.0
    assert _scalar(recovery["presence_carryover"]) == 0.0


def test_rain_seed_does_not_restart_when_base_score_is_too_low() -> None:
    recovery = _compute_recovery(
        base_score=_field(5.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=1.0, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(20.0),
        enable_recovery=True,
    )

    assert _scalar(recovery["score"]) == 5.0
    assert _scalar(recovery["rain_recovery_seed"]) == 0.0


def test_rain_seed_can_gently_restart_after_dry_low_score_history() -> None:
    recovery = _compute_recovery(
        base_score=_field(35.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=1.0, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(20.0),
        enable_recovery=True,
    )

    assert np.isclose(_scalar(recovery["score"]), 38.111111, atol=1e-5)
    assert np.isclose(_scalar(recovery["rain_recovery_seed"]), 3.111111, atol=1e-5)


def test_rain_seed_is_capped_to_moderate_boost() -> None:
    recovery = _compute_recovery(
        base_score=_field(50.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=1.0, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(20.0),
        enable_recovery=True,
    )

    assert np.isclose(_scalar(recovery["score"]), 61.111111, atol=1e-5)
    assert np.isclose(_scalar(recovery["rain_recovery_seed"]), 11.111111, atol=1e-5)


def test_rain_seed_is_continuous_around_old_trigger_threshold() -> None:
    below = _compute_recovery(
        base_score=_field(45.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=0.449, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(20.0),
        enable_recovery=True,
    )
    above = _compute_recovery(
        base_score=_field(45.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=0.451, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(20.0),
        enable_recovery=True,
    )

    below_seed = _scalar(below["rain_recovery_seed"])
    above_seed = _scalar(above["rain_recovery_seed"])
    assert below_seed > 0.0
    assert above_seed > below_seed
    assert above_seed - below_seed < 0.1


def test_rain_seed_does_not_restart_when_recent_peak_is_high() -> None:
    recovery = _compute_recovery(
        base_score=_field(50.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=1.0, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(70.0),
        enable_recovery=True,
    )

    assert _scalar(recovery["rain_recovery_seed"]) == 0.0
    assert _scalar(recovery["presence_carryover"]) == 10.0
    assert _scalar(recovery["score"]) == 60.0


def test_recovery_can_be_disabled() -> None:
    recovery = _compute_recovery(
        base_score=_field(50.0),
        habitat=_field(1.0),
        dynamic=_dynamic(trigger=1.0, moisture=1.0, stress=1.0),
        species="porcini",
        history=_history(90.0),
        enable_recovery=False,
    )

    assert _scalar(recovery["score"]) == 50.0
    assert _scalar(recovery["recovery"]) == 1.0


def test_recovery_drops_stale_auxiliary_lag_coordinates() -> None:
    dynamic = xr.Dataset(
        {
            "trigger": _with_aux_lag(_field(1.0), 7),
            "moisture": _with_aux_lag(_field(1.0), 7),
            "stress": _with_aux_lag(_field(1.0), 7),
        }
    )
    history = [
        (
            1,
            xr.Dataset(
                {
                    "porcini_score": _with_aux_lag(_field(20.0), 9),
                    "porcini_moisture": _with_aux_lag(_field(1.0), 9),
                    "porcini_stress": _with_aux_lag(_field(1.0), 9),
                }
            ),
        )
    ]

    recovery = _compute_recovery(
        base_score=_field(35.0),
        habitat=_field(1.0),
        dynamic=dynamic,
        species="porcini",
        history=history,
        enable_recovery=True,
    )

    assert "lag" not in recovery.coords
    assert np.isclose(_scalar(recovery["rain_recovery_seed"]), 3.111111, atol=1e-5)
