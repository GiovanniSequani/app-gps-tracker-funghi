from __future__ import annotations

import numpy as np
import xarray as xr


def require_vars(ds: xr.Dataset, names: list[str], source_name: str) -> None:
    missing = [name for name in names if name not in ds]
    if missing:
        raise ValueError(f"{source_name} missing variables: {', '.join(missing)}")


def select_recent_window(ds: xr.Dataset, target_date: str | None, window_days: int) -> xr.Dataset:
    if "time" not in ds.coords:
        raise ValueError("meteo dataset must have a time coordinate")

    ds = ds.sortby("time")
    times = ds["time"].values
    if len(times) == 0:
        raise ValueError("meteo dataset has no time steps")

    if target_date is None:
        target = times[-1]
    else:
        target = np.datetime64(target_date)
        available = times[times <= target]
        if len(available) == 0:
            raise ValueError(f"no meteo data available up to target date {target_date}")
        target = available[-1]

    recent = ds.sel(time=slice(None, target)).tail(time=window_days)
    if recent.sizes.get("time", 0) < 8:
        raise ValueError("not enough meteo days to compute the index")
    return recent


def add_static_derivatives(ds: xr.Dataset) -> xr.Dataset:
    require_vars(
        ds,
        [
            "elevation",
            "slope",
            "tpi",
            "aspect_deg",
            "pct_broadleaf",
            "pct_conifer",
            "pct_non_forest",
        ],
        "terrain dataset",
    )

    aspect_rad = np.deg2rad(ds["aspect_deg"])
    north_raw = np.cos(aspect_rad)
    east_raw = np.sin(aspect_rad)

    forest_pct = (ds["pct_broadleaf"] + ds["pct_conifer"]).clip(0.0, 100.0)
    slope_norm = (ds["slope"] / 35.0).clip(0.0, 1.0)
    ridge_exposure = (ds["tpi"] / 120.0).clip(0.0, 1.0)
    valley_shelter = ((-ds["tpi"]) / 80.0).clip(0.0, 1.0)
    northness = ((north_raw + 1.0) / 2.0).clip(0.0, 1.0)
    southness = ((-north_raw + 1.0) / 2.0).clip(0.0, 1.0)

    out = ds.copy()
    out["forest_pct"] = forest_pct.astype("float32")
    out["slope_norm"] = slope_norm.astype("float32")
    out["ridge_exposure"] = ridge_exposure.astype("float32")
    out["valley_shelter"] = valley_shelter.astype("float32")
    out["northness"] = northness.astype("float32")
    out["southness"] = southness.astype("float32")
    out["eastness"] = ((east_raw + 1.0) / 2.0).clip(0.0, 1.0).astype("float32")
    out["westness"] = ((-east_raw + 1.0) / 2.0).clip(0.0, 1.0).astype("float32")
    out["drying_exposure_static"] = (
        0.42 * southness * (0.35 + 0.65 * slope_norm)
        + 0.30 * ridge_exposure
        + 0.18 * slope_norm
        + 0.10 * (1.0 - forest_pct / 100.0)
    ).clip(0.0, 1.0).astype("float32")
    out["retention_static"] = (
        0.35 * (forest_pct / 100.0)
        + 0.25 * northness
        + 0.25 * valley_shelter
        + 0.15 * (1.0 - slope_norm)
    ).clip(0.0, 1.0).astype("float32")
    return out


def build_feature_dataset(
    meteo: xr.Dataset,
    terrain: xr.Dataset,
    target_date: str | None,
    window_days: int,
) -> xr.Dataset:
    require_vars(
        meteo,
        [
            "t2m_mean",
            "t2m_min",
            "t2m_max",
            "precip_sum",
            "rh_mean",
            "rh_min",
            "gust_mean",
            "gust_max",
        ],
        "meteo dataset",
    )

    meteo_recent = select_recent_window(meteo, target_date, window_days)
    terrain_features = add_static_derivatives(terrain)

    meteo_recent, terrain_features = xr.align(meteo_recent, terrain_features, join="exact")
    ds = xr.merge([meteo_recent, terrain_features], compat="override")
    target_value = str(ds["time"].values[-1])[:10]
    ds.attrs.update(
        target_date=target_value,
        feature_window_days=int(ds.sizes["time"]),
        description="Feature dataset for Funghi Tracker mushroom index",
    )
    return ds.astype({name: "float32" for name in ds.data_vars if ds[name].dtype.kind == "f"})

