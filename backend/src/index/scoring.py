from __future__ import annotations

import xarray as xr

from backend.config.index_config import (
    RECOVERY_COMPONENT_GATE_BASE,
    RECOVERY_DRY_HISTORY_SCORE_RANGE,
    RECOVERY_LAG_WEIGHTS,
    RECOVERY_MAX_PRESENCE_BOOST,
    RECOVERY_PRESENCE_SCORE_THRESHOLD,
    RECOVERY_RAIN_SEED_BASE_SCORE_RANGE,
    RECOVERY_RAIN_SEED_HABITAT_RANGE,
    RECOVERY_RAIN_SEED_MAX_BOOST,
    RECOVERY_RAIN_SEED_MOISTURE_RANGE,
    RECOVERY_RAIN_SEED_STRESS_RANGE,
    RECOVERY_RAIN_SEED_TARGET_SCORE,
    RECOVERY_RAIN_SEED_TRIGGER_RANGE,
    TRIGGER_LAG_DAYS,
    TRIGGER_RAIN_WINDOW_DAYS,
)
from backend.config.species_config import SPECIES_CONFIG

RecoveryHistory = dict[str, list[tuple[int, xr.Dataset]]]


def _drop_auxiliary_coords(value):
    drop_names = [name for name in value.coords if name not in value.dims]
    return value.drop_vars(drop_names) if drop_names else value


def trapezoid(x: xr.DataArray, lo_bad: float, lo_ok: float, hi_ok: float, hi_bad: float) -> xr.DataArray:
    rising = ((x - lo_bad) / (lo_ok - lo_bad + 1e-6)).clip(0.0, 1.0)
    falling = ((hi_bad - x) / (hi_bad - hi_ok + 1e-6)).clip(0.0, 1.0)
    return xr.where(x < lo_ok, rising, xr.where(x <= hi_ok, 1.0, falling)).clip(0.0, 1.0)


def upper_penalty(x: xr.DataArray, ok: float, bad: float) -> xr.DataArray:
    return ((x - ok) / max(bad - ok, 1e-6)).clip(0.0, 1.0)


def lower_penalty(x: xr.DataArray, ok: float, bad: float) -> xr.DataArray:
    return ((ok - x) / max(ok - bad, 1e-6)).clip(0.0, 1.0)


def smoothstep(x: xr.DataArray, lo: float, hi: float) -> xr.DataArray:
    t = ((x - lo) / max(hi - lo, 1e-6)).clip(0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).clip(0.0, 1.0)


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
    low_humidity_days = (
        ds["rh_min"].isel(time=slice(incubation_start, incubation_end + 1))
        < cfg["rh_min_pct"][1]
    ).sum("time")

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
            # Compact public diagnostics select these values from the same lag
            # that maximises potential. They do not alter the index formula.
            "temp_score": temp_score.clip(0.0, 1.0).astype("float32"),
            "humidity_score": humidity_score.clip(0.0, 1.0).astype("float32"),
            "post_rain_score": post_rain_score.clip(0.0, 1.0).astype("float32"),
            "drying_total": drying_total.astype("float32"),
            "temp_mean_c": temp_mean.astype("float32"),
            "low_humidity_days": low_humidity_days.astype("float32"),
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
    best_lag_days = _drop_auxiliary_coords(lagged["lag"].isel(lag=best_idx)).astype("float32")
    out = _drop_auxiliary_coords(lagged.max("lag"))
    out["best_lag_days"] = best_lag_days
    return out


def _history_var(history_ds: xr.Dataset, species: str, suffix: str) -> xr.DataArray | None:
    name = f"{species}_{suffix}"
    return _drop_auxiliary_coords(history_ds[name]) if name in history_ds else None


def _history_base_score(history_ds: xr.Dataset, species: str) -> xr.DataArray | None:
    base_score = _history_var(history_ds, species, "base_score")
    return base_score if base_score is not None else _history_var(history_ds, species, "score")


def _component_gate(history_ds: xr.Dataset, species: str, reference: xr.DataArray) -> xr.DataArray:
    moisture = _history_var(history_ds, species, "moisture")
    stress = _history_var(history_ds, species, "stress")
    if moisture is None or stress is None:
        return xr.ones_like(reference, dtype="float32")

    quality = (0.55 * moisture + 0.45 * stress).clip(0.0, 1.0)
    gate = (RECOVERY_COMPONENT_GATE_BASE + (1.0 - RECOVERY_COMPONENT_GATE_BASE) * quality).clip(
        RECOVERY_COMPONENT_GATE_BASE,
        1.0,
    )
    return gate.astype("float32")


def _max_dataarray(values: list[xr.DataArray], reference: xr.DataArray) -> xr.DataArray:
    if not values:
        return xr.zeros_like(reference, dtype="float32")
    out = values[0]
    for value in values[1:]:
        out = xr.where(value > out, value, out)
    return out.clip(0.0, 100.0).astype("float32")


def _presence_carryover(
    base_score: xr.DataArray,
    species: str,
    history: list[tuple[int, xr.Dataset]],
) -> xr.DataArray:
    candidates: list[xr.DataArray] = []
    for lag, history_ds in history:
        if lag < 1 or lag > len(RECOVERY_LAG_WEIGHTS):
            continue
        source_score = _history_base_score(history_ds, species)
        if source_score is None:
            continue

        source_score, current_base = xr.align(source_score, base_score, join="exact")
        gate = _component_gate(history_ds, species, current_base)
        gate, current_base = xr.align(gate, current_base, join="exact")
        weight = RECOVERY_LAG_WEIGHTS[lag - 1]
        candidate = xr.where(
            source_score >= RECOVERY_PRESENCE_SCORE_THRESHOLD,
            (source_score - current_base).clip(min=0.0) * weight * gate,
            0.0,
        ).clip(0.0, RECOVERY_MAX_PRESENCE_BOOST)
        candidates.append(candidate)

    return _max_dataarray(candidates, base_score)


def _recent_history_peak(
    species: str,
    history: list[tuple[int, xr.Dataset]],
    reference: xr.DataArray,
) -> xr.DataArray | None:
    scores: list[xr.DataArray] = []
    for _, history_ds in history:
        source_score = _history_base_score(history_ds, species)
        if source_score is None:
            continue
        source_score, _ = xr.align(source_score, reference, join="exact")
        scores.append(source_score)
    if not scores:
        return None
    return _max_dataarray(scores, reference)


def _rain_seed_current(
    base_score: xr.DataArray,
    habitat: xr.DataArray,
    dynamic: xr.Dataset,
    recent_peak: xr.DataArray | None,
) -> xr.DataArray:
    if recent_peak is None:
        return xr.zeros_like(base_score, dtype="float32")

    dry_factor = 1.0 - smoothstep(recent_peak, *RECOVERY_DRY_HISTORY_SCORE_RANGE)
    base_factor = smoothstep(base_score, *RECOVERY_RAIN_SEED_BASE_SCORE_RANGE)
    trigger_factor = smoothstep(dynamic["trigger"], *RECOVERY_RAIN_SEED_TRIGGER_RANGE)
    moisture_factor = smoothstep(dynamic["moisture"], *RECOVERY_RAIN_SEED_MOISTURE_RANGE)
    stress_factor = smoothstep(dynamic["stress"], *RECOVERY_RAIN_SEED_STRESS_RANGE)
    habitat_factor = smoothstep(habitat, *RECOVERY_RAIN_SEED_HABITAT_RANGE)

    restart_signal = (
        dry_factor
        * base_factor
        * trigger_factor
        * moisture_factor
        * stress_factor
        * habitat_factor
    ).clip(0.0, 1.0)
    seed_headroom = (RECOVERY_RAIN_SEED_TARGET_SCORE - base_score).clip(
        0.0,
        RECOVERY_RAIN_SEED_MAX_BOOST,
    )
    return _drop_auxiliary_coords(
        (seed_headroom * restart_signal).clip(0.0, RECOVERY_RAIN_SEED_MAX_BOOST).astype("float32")
    )


def _rain_seed_carryover(
    base_score: xr.DataArray,
    species: str,
    history: list[tuple[int, xr.Dataset]],
) -> xr.DataArray:
    candidates: list[xr.DataArray] = []
    for lag, history_ds in history:
        if lag < 1 or lag > len(RECOVERY_LAG_WEIGHTS):
            continue
        past_seed = _history_var(history_ds, species, "rain_recovery_seed")
        past_base = _history_base_score(history_ds, species)
        if past_seed is None or past_base is None:
            continue

        past_seed, past_base, current_base = xr.align(past_seed, past_base, base_score, join="exact")
        past_seed_target = past_base + past_seed
        candidate = (past_seed_target - current_base).clip(min=0.0) * RECOVERY_LAG_WEIGHTS[lag - 1]
        candidates.append(candidate)

    return _max_dataarray(candidates, base_score)


def _compute_recovery(
    base_score: xr.DataArray,
    habitat: xr.DataArray,
    dynamic: xr.Dataset,
    species: str,
    history: list[tuple[int, xr.Dataset]],
    enable_recovery: bool,
) -> xr.Dataset:
    if not enable_recovery:
        zero = xr.zeros_like(base_score, dtype="float32")
        one = xr.ones_like(base_score, dtype="float32")
        return xr.Dataset(
            {
                "presence_carryover": zero,
                "rain_recovery_seed": zero,
                "recovery": one,
                "score": base_score.astype("float32"),
            }
        )

    presence = _presence_carryover(base_score, species, history)
    recent_peak = _recent_history_peak(species, history, base_score)
    rain_seed_current = _rain_seed_current(base_score, habitat, dynamic, recent_peak)
    rain_seed_history = _rain_seed_carryover(base_score, species, history)
    rain_seed = xr.where(rain_seed_current > rain_seed_history, rain_seed_current, rain_seed_history).astype("float32")

    boost = xr.where(presence > rain_seed, presence, rain_seed)
    final_score = (base_score + boost).clip(0.0, 100.0).astype("float32")
    recovery = xr.where(base_score > 0.01, final_score / base_score, 1.0).clip(1.0, 100.0).astype("float32")
    presence = _drop_auxiliary_coords(presence)
    rain_seed = _drop_auxiliary_coords(rain_seed)
    recovery = _drop_auxiliary_coords(recovery)
    final_score = _drop_auxiliary_coords(final_score)
    return xr.Dataset(
        {
            "presence_carryover": presence.astype("float32"),
            "rain_recovery_seed": rain_seed.astype("float32"),
            "recovery": recovery,
            "score": final_score,
        }
    )


def compute_species_index(
    ds: xr.Dataset,
    species: str,
    recovery_history: RecoveryHistory | None = None,
    enable_recovery: bool = True,
) -> xr.Dataset:
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

    raw_score = habitat * dynamic["potential"]
    blended_score = habitat * dynamic_mix * dynamic["potential"] ** 0.45
    base_score = (100.0 * (0.72 * raw_score + 0.28 * blended_score)).clip(0.0, 100.0).astype("float32")
    recovery = _compute_recovery(
        base_score=base_score,
        habitat=habitat,
        dynamic=dynamic,
        species=species,
        history=(recovery_history or {}).get(species, []),
        enable_recovery=enable_recovery,
    )

    prefix = species
    out = xr.Dataset(
        {
            f"{prefix}_score": recovery["score"].astype("float32"),
            f"{prefix}_base_score": base_score.astype("float32"),
            f"{prefix}_habitat": habitat.astype("float32"),
            f"{prefix}_trigger": dynamic["trigger"].astype("float32"),
            f"{prefix}_incubation": dynamic["incubation"].astype("float32"),
            f"{prefix}_moisture": dynamic["moisture"].astype("float32"),
            f"{prefix}_stress": dynamic["stress"].astype("float32"),
            f"{prefix}_presence_carryover": recovery["presence_carryover"].astype("float32"),
            f"{prefix}_rain_recovery_seed": recovery["rain_recovery_seed"].astype("float32"),
            f"{prefix}_recovery": recovery["recovery"].astype("float32"),
            f"{prefix}_best_lag_days": dynamic["best_lag_days"].astype("float32"),
        }
    )
    out.attrs.update(
        species=species,
        scoring_version="0.2.0",
        recovery_note=(
            "Temporal recovery can only raise the base score. Presence carryover uses recent high scores; "
            "rain recovery seed supports restart after dry low-score periods."
        ),
    )
    return out


def compute_all_indices(
    ds: xr.Dataset,
    species_list: list[str],
    recovery_history: RecoveryHistory | None = None,
    enable_recovery: bool = True,
) -> xr.Dataset:
    outputs = [
        compute_species_index(
            ds,
            species,
            recovery_history=recovery_history,
            enable_recovery=enable_recovery,
        )
        for species in species_list
    ]
    out = xr.merge(outputs, compat="override")
    out.attrs.pop("species", None)
    out.attrs.update(
        species_list=",".join(species_list),
        target_date=ds.attrs.get("target_date", str(ds["time"].values[-1])[:10]),
        description="Funghi Tracker mushroom suitability index, values 0-100",
        scoring_version="0.2.0",
        recovery_enabled=str(bool(enable_recovery)).lower(),
    )
    return out
