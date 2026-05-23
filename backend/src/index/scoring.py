from __future__ import annotations

import numpy as np
import xarray as xr

from backend.config.index_config import TRIGGER_LAG_DAYS, TRIGGER_RAIN_WINDOW_DAYS
from backend.config.species_config import SPECIES_CONFIG


def trapezoid(x: xr.DataArray, lo_bad: float, lo_ok: float, hi_ok: float, hi_bad: float) -> xr.DataArray:
    rising = ((x - lo_bad) / (lo_ok - lo_bad + 1e-6)).clip(0.0, 1.0)
    falling = ((hi_bad - x) / (hi_bad - hi_ok + 1e-6)).clip(0.0, 1.0)
    return xr.where(x < lo_ok, rising, xr.where(x <= hi_ok, 1.0, falling)).clip(0.0, 1.0)


def upper_penalty(x: xr.DataArray, ok: float, bad: float) -> xr.DataArray:
    return ((x - ok) / max(bad - ok, 1e-6)).clip(0.0, 1.0)


def lower_penalty(x: xr.DataArray, ok: float, bad: float) -> xr.DataArray:
    return ((ok - x) / max(ok - bad, 1e-6)).clip(0.0, 1.0)


def _mean_window(ds: xr.Dataset, var: str, start: int, end: int) -> xr.DataArray:
    return ds[var].isel(time=slice(start, end + 1)).mean("time", skipna=True)


def _sum_window(ds: xr.Dataset, var: str, start: int, end: int) -> xr.DataArray:
    return ds[var].isel(time=slice(start, end + 1)).sum("time", skipna=True)


def _max_window(ds: xr.Dataset, var: str, start: int, end: int) -> xr.DataArray:
    return ds[var].isel(time=slice(start, end + 1)).max("time", skipna=True)


def _min_window(ds: xr.Dataset, var: str, start: int, end: int) -> xr.DataArray:
    return ds[var].isel(time=slice(start, end + 1)).min("time", skipna=True)


def compute_habitat_score(ds: xr.Dataset, species: str) -> xr.DataArray:
    cfg = SPECIES_CONFIG[species]
    elev = trapezoid(ds["elevation"], *cfg["elevation_m"])
    forest = trapezoid(ds["forest_pct"], 15.0, 45.0, 100.0, 100.0)
    forest_gate = trapezoid(ds["forest_pct"], 8.0, 35.0, 100.0, 100.0)
    non_forest_gate = (1.0 - upper_penalty(ds["pct_non_forest"], 45.0, 90.0)).clip(0.0, 1.0)

    mix = cfg["forest_mix"]
    broadleaf = (ds["pct_broadleaf"] / 100.0).clip(0.0, 1.0)
    conifer = (ds["pct_conifer"] / 100.0).clip(0.0, 1.0)
    forest_mix = (mix["broadleaf"] * broadleaf + mix["conifer"] * conifer).clip(0.0, 1.0)

    slope_ok = 1.0 - upper_penalty(ds["slope"], 32.0, 48.0)
    retention = ds["retention_static"]
    habitat_base = (
        0.34 * elev
        + 0.24 * forest
        + 0.18 * forest_mix
        + 0.14 * slope_ok
        + 0.10 * retention
    )
    habitat = habitat_base * forest_gate * non_forest_gate
    return habitat.clip(0.0, 1.0).astype("float32")


def _rain_need_factor(ds: xr.Dataset) -> xr.DataArray:
    return (
        1.0
        + 0.30 * ds["southness"] * (0.35 + 0.65 * ds["slope_norm"])
        + 0.22 * ds["slope_norm"]
        + 0.18 * ds["ridge_exposure"]
        - 0.14 * ds["valley_shelter"]
        - 0.08 * ds["northness"]
    ).clip(0.70, 1.65)


def _dynamic_trapezoid(x: xr.DataArray, params: tuple[float, float, float, float], factor: xr.DataArray) -> xr.DataArray:
    lo_bad, lo_ok, hi_ok, hi_bad = params
    return trapezoid(x, lo_bad * factor, lo_ok * factor, hi_ok * factor, hi_bad * factor)


def _lag_candidate(ds: xr.Dataset, species: str, target_idx: int, lag: int) -> xr.Dataset | None:
    cfg = SPECIES_CONFIG[species]
    trigger_end = target_idx - lag
    trigger_start = trigger_end - TRIGGER_RAIN_WINDOW_DAYS + 1
    incubation_start = trigger_end + 1
    incubation_end = target_idx

    if trigger_start < 0 or incubation_start > incubation_end:
        return None

    rain_factor = _rain_need_factor(ds)
    trigger_rain = _sum_window(ds, "precip_sum", trigger_start, trigger_end)
    post_rain = _sum_window(ds, "precip_sum", incubation_start, incubation_end)

    trigger_score = _dynamic_trapezoid(trigger_rain, cfg["rain_trigger_mm"], rain_factor)
    post_rain_score = _dynamic_trapezoid(post_rain, cfg["post_trigger_rain_mm"], rain_factor)

    temp_mean = _mean_window(ds, "t2m_mean", incubation_start, incubation_end)
    temp_min = _min_window(ds, "t2m_min", incubation_start, incubation_end)
    temp_max = _max_window(ds, "t2m_max", incubation_start, incubation_end)
    rh_mean = _mean_window(ds, "rh_mean", incubation_start, incubation_end)
    rh_min = _min_window(ds, "rh_min", incubation_start, incubation_end)
    gust_max = _max_window(ds, "gust_max", incubation_start, incubation_end)

    temp_score = (
        0.45 * trapezoid(temp_mean, *cfg["temp_mean_c"])
        + 0.25 * trapezoid(temp_min, *cfg["temp_min_c"])
        + 0.30 * trapezoid(temp_max, *cfg["temp_max_c"])
    )
    humidity_score = (
        0.62 * trapezoid(rh_mean, *cfg["rh_mean_pct"])
        + 0.38 * trapezoid(rh_min, *cfg["rh_min_pct"])
    )

    drying_weather = (
        0.38 * lower_penalty(rh_min, cfg["rh_min_pct"][1], cfg["rh_min_pct"][0])
        + 0.32 * upper_penalty(gust_max, cfg["gust_max_kmh"][1], cfg["gust_max_kmh"][0])
        + 0.30 * upper_penalty(temp_max, cfg["temp_max_c"][2], cfg["temp_max_c"][3])
    ).clip(0.0, 1.0)
    drying_total = (
        0.62 * drying_weather
        + 0.38 * ds["drying_exposure_static"]
    ).clip(0.0, 1.0)

    moisture_score = (
        0.48 * post_rain_score
        + 0.30 * ds["retention_static"]
        + 0.22 * humidity_score
    ) * (1.0 - 0.55 * drying_total)

    incubation_score = (
        0.42 * temp_score
        + 0.30 * humidity_score
        + 0.18 * post_rain_score
        + 0.10 * (1.0 - drying_total)
    ).clip(0.0, 1.0)

    stress_score = (1.0 - drying_total).clip(0.0, 1.0)
    potential = (trigger_score * incubation_score * moisture_score).clip(0.0, 1.0)

    return xr.Dataset(
        {
            "potential": potential.astype("float32"),
            "trigger": trigger_score.astype("float32"),
            "incubation": incubation_score.astype("float32"),
            "moisture": moisture_score.clip(0.0, 1.0).astype("float32"),
            "stress": stress_score.astype("float32"),
        }
    ).expand_dims(lag=[lag])


def compute_dynamic_scores(ds: xr.Dataset, species: str) -> xr.Dataset:
    target_idx = ds.sizes["time"] - 1
    candidates = [
        candidate
        for lag in TRIGGER_LAG_DAYS
        if (candidate := _lag_candidate(ds, species, target_idx, lag)) is not None
    ]
    if not candidates:
        raise ValueError("not enough time steps for configured trigger lags")

    lagged = xr.concat(candidates, dim="lag")
    best_idx = lagged["potential"].argmax("lag")
    out = lagged.max("lag")
    out["best_lag_days"] = lagged["lag"].isel(lag=best_idx).astype("float32")
    return out


def compute_species_index(ds: xr.Dataset, species: str) -> xr.Dataset:
    if species not in SPECIES_CONFIG:
        raise ValueError(f"unknown species: {species}")

    habitat = compute_habitat_score(ds, species)
    dynamic = compute_dynamic_scores(ds, species)
    cfg = SPECIES_CONFIG[species]
    weights = cfg["weights"]

    dynamic_mix = (
        weights["trigger"] * dynamic["trigger"]
        + weights["incubation"] * dynamic["incubation"]
        + weights["moisture"] * dynamic["moisture"]
        + weights["stress"] * dynamic["stress"]
    ) / (weights["trigger"] + weights["incubation"] + weights["moisture"] + weights["stress"])

    recovery = xr.ones_like(habitat, dtype="float32")
    raw_score = habitat * dynamic["potential"]
    blended_score = habitat * dynamic_mix * dynamic["potential"] ** 0.45
    final_score = (100.0 * (0.72 * raw_score + 0.28 * blended_score) * recovery).clip(0.0, 100.0)

    prefix = species
    out = xr.Dataset(
        {
            f"{prefix}_score": final_score.astype("float32"),
            f"{prefix}_habitat": habitat.astype("float32"),
            f"{prefix}_trigger": dynamic["trigger"].astype("float32"),
            f"{prefix}_incubation": dynamic["incubation"].astype("float32"),
            f"{prefix}_moisture": dynamic["moisture"].astype("float32"),
            f"{prefix}_stress": dynamic["stress"].astype("float32"),
            f"{prefix}_recovery": recovery.astype("float32"),
            f"{prefix}_best_lag_days": dynamic["best_lag_days"].astype("float32"),
        }
    )
    out.attrs.update(
        species=species,
        scoring_version="0.1.0",
        recovery_note="Neutral recovery factor. Previous-flush depletion is not active yet.",
    )
    return out


def compute_all_indices(ds: xr.Dataset, species_list: list[str]) -> xr.Dataset:
    outputs = [compute_species_index(ds, species) for species in species_list]
    out = xr.merge(outputs, compat="override")
    out.attrs.pop("species", None)
    out.attrs.update(
        species_list=",".join(species_list),
        target_date=ds.attrs.get("target_date", str(ds["time"].values[-1])[:10]),
        description="Funghi Tracker mushroom suitability index, values 0-100",
    )
    return out
