from __future__ import annotations

SPECIES_CONFIG = {
    "porcini": {
        "label": "Porcini",
        "rain_trigger_mm": (4.0, 16.0, 45.0, 95.0),
        "post_trigger_rain_mm": (0.0, 4.0, 28.0, 75.0),
        "temp_mean_c": (5.0, 10.0, 18.0, 24.0),
        "temp_min_c": (0.0, 5.0, 13.0, 18.0),
        "temp_max_c": (10.0, 15.0, 24.0, 30.0),
        "rh_mean_pct": (52.0, 68.0, 95.0, 100.0),
        "rh_min_pct": (28.0, 42.0, 78.0, 100.0),
        "gust_max_kmh": (55.0, 35.0, 0.0, 0.0),
        "elevation_m": (350.0, 700.0, 1700.0, 2250.0),
        "forest_mix": {"broadleaf": 0.55, "conifer": 0.45},
        "weights": {
            "habitat": 0.28,
            "trigger": 0.30,
            "incubation": 0.22,
            "moisture": 0.16,
            "stress": 0.04,
        },
    },
    "finferli": {
        "label": "Finferli",
        "rain_trigger_mm": (6.0, 20.0, 55.0, 115.0),
        "post_trigger_rain_mm": (0.0, 6.0, 35.0, 90.0),
        "temp_mean_c": (7.0, 12.0, 20.0, 26.0),
        "temp_min_c": (2.0, 7.0, 15.0, 20.0),
        "temp_max_c": (12.0, 17.0, 26.0, 32.0),
        "rh_mean_pct": (55.0, 72.0, 96.0, 100.0),
        "rh_min_pct": (32.0, 46.0, 80.0, 100.0),
        "gust_max_kmh": (58.0, 38.0, 0.0, 0.0),
        "elevation_m": (200.0, 400.0, 1300.0, 1850.0),
        "forest_mix": {"broadleaf": 0.60, "conifer": 0.40},
        "weights": {
            "habitat": 0.24,
            "trigger": 0.30,
            "incubation": 0.24,
            "moisture": 0.18,
            "stress": 0.04,
        },
    },
}

