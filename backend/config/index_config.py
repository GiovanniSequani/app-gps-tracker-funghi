from __future__ import annotations

from backend.config.paths import (
    FINAL_METEO_DIR,
    FINAL_STATIC_DIR,
    INT_INDEX_DIR,
    OUT_INDEX_NC_DIR,
)

DEFAULT_SPECIES = ("porcini", "finferli")

METEO_RECENT_NC = FINAL_METEO_DIR / "meteo_recent_003deg.nc"
TERRAIN_STATIC_NC = FINAL_STATIC_DIR / "terrain_static_003deg.nc"

INDEX_FEATURE_WINDOW_DAYS = 19
TRIGGER_LAG_DAYS = tuple(range(7, 17))
TRIGGER_RAIN_WINDOW_DAYS = 3
MIN_SCORE_TO_EXPORT = 3.0

INDEX_FEATURES_TEMPLATE = INT_INDEX_DIR / "index_features_{date}.nc"
INDEX_OUTPUT_TEMPLATE = OUT_INDEX_NC_DIR / "funghi_index_{date}.nc"
