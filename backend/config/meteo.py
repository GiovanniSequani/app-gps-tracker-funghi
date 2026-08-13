from __future__ import annotations

from backend.config.domain import BBOX, TARGET_CRS, TARGET_STEP_DEG
from backend.config.paths import BACKEND_DIR


METEO_SOURCE = "ICON_D2"
TIMEZONE_DAILY = "Europe/Rome"

ROLLING_HOURLY_WINDOW_HOURS = 48
RAW_RUN_RETENTION_DAYS = 30

MIN_LEAD_HOURS = 2
DUPLICATE_VALID_TIME_POLICY = "latest_run_wins"

METEO_TARGET_CRS = TARGET_CRS
METEO_TARGET_STEP_DEG = TARGET_STEP_DEG
METEO_BBOX = BBOX

RAW_METEO_DIR = BACKEND_DIR / "data" / "raw" / "meteo"
INTERMEDIATE_METEO_DIR = BACKEND_DIR / "data" / "intermediate" / "meteo"
FINAL_METEO_DIR = BACKEND_DIR / "data" / "final" / "meteo"

ICON_D2_RAW_DIR = RAW_METEO_DIR / "icon_d2"

PUBLICATION_DELAY_H = 0    # ritardo medio pubblicazione run

DWD_ICON_D2_BASE_URL = "https://opendata.dwd.de/weather/nwp/icon-d2/grib"
ICON_D2_RUN_HOURS = (0, 3, 6, 9, 12, 15, 18, 21)
ICON_D2_DEFAULT_STEPS = tuple(range(1, 8))  # raw +1 ... +7; output starts at MIN_LEAD_HOURS

ICON_D2_RAW_VARIABLES = {
    "t2m": {
        "dwd_var_dir": "t_2m",
        "level_kind": "single-level",
        "description": "2 m air temperature",
    },
    "rh2m": {
        "dwd_var_dir": "relhum_2m",
        "level_kind": "single-level",
        "description": "2 m relative humidity",
    },
    "gust10m": {
        "dwd_var_dir": "vmax_10m",
        "level_kind": "single-level",
        "description": "10 m max wind gust",
    },
    "precip": {
        "dwd_var_dir": "tot_prec",
        "level_kind": "single-level",
        "description": "total precipitation",
    },
    "tground": {
        "dwd_var_dir": "t_g",
        "level_kind": "single-level",
        "description": "ground surface temperature",
    },
    "smi9": {
        "dwd_var_dir": "smi",
        "level_kind": "soil-level",
        "grid_type": "regular-lat-lon",
        "description": "soil moisture index, upper soil layer level 9",
        "levels": (9,),
    },
    #"soil_temp": {
    #    "dwd_var_dir": "t_so",
    #    "level_kind": "soil-level",
    #    "description": "soil temperature",
    #    # livelli osservati nel tree DWD per T_SO
    #    "levels": (0, 2, 6, 18, 54, 162, 486, 1458),
    #},
    #"soil_moisture": {
    #    "dwd_var_dir": "w_so",
    #    "level_kind": "soil-level",
    #    "description": "soil moisture",
    #    # per W_SO i livelli utili di lavoro sono quelli superficiali
    #    # nella pipeline potremo usare solo un subset
    #    "levels": (0, 1, 3, 9, 27, 81),
    #},
}

DAILY_FINAL_VARIABLES = (
    "t2m_mean",
    "t2m_min",
    "t2m_max",
    "precip_sum",
    "rh_mean",
    "rh_min",
    "gust_mean",
    "gust_max",
    "tground_mean",
    "tground_min",
    "tground_max",
    "smi9_mean",
    "smi9_min",
)

DAILY_AGGREGATIONS = {
    "t2m": ("mean", "min", "max"),
    "precip": ("sum",),
    "rh2m": ("mean", "min"),
    "gust10m": ("mean", "max"),
    "tground": ("mean", "min", "max"),
    "smi9": ("mean", "min"),
}

PRECIP_HOURLY_MODE = "decumulated_last_hour"
