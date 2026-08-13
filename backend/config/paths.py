from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BACKEND_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
INTERMEDIATE_DIR = DATA_DIR / "intermediate"
FINAL_DIR = DATA_DIR / "final"
OUTPUTS_DIR = BACKEND_DIR / "outputs"
TMP_DIR = BACKEND_DIR / "tmp"

RAW_DEM_DIR = RAW_DIR / "dem"
RAW_FOREST_DIR = RAW_DIR / "forest"
RAW_METEO_DIR = RAW_DIR / "meteo"

INT_TERRAIN_DIR = INTERMEDIATE_DIR / "terrain"
INT_FOREST_DIR = INTERMEDIATE_DIR / "forest"
INT_METEO_DIR = INTERMEDIATE_DIR / "meteo"
INT_INDEX_DIR = INTERMEDIATE_DIR / "index"

FINAL_STATIC_DIR = FINAL_DIR / "static"
FINAL_METEO_DIR = FINAL_DIR / "meteo"
FINAL_METEO_HISTORIC_DIR = FINAL_METEO_DIR / "historic"


def icon_ruc_time_series_path(year: int) -> Path:
    return FINAL_METEO_DIR / f"icon_ruc_time_series_{year}.nc"


def icon_ruc_recovery_path(year: int) -> Path:
    return FINAL_METEO_DIR / f"recovery_icon_ruc_time_series_{year}.nc"


def hrs_time_series_path(year: int) -> Path:
    return FINAL_METEO_DIR / f"hrs_time_series_{year}.nc"

OUT_GEOJSON_DIR = OUTPUTS_DIR / "index_geojson"
OUT_INDEX_NC_DIR = OUTPUTS_DIR / "index_nc"
OUT_TIF_DIR = OUTPUTS_DIR / "index_tif"
OUT_TILES_DIR = OUTPUTS_DIR / "tiles_local"
OUT_PUBLICATION_DIR = OUTPUTS_DIR / "publication"
OUT_PUBLIC_WEATHER_DIR = OUT_PUBLICATION_DIR / "weather"
OUT_PUBLIC_TERRAIN_DIR = OUT_PUBLICATION_DIR / "terrain"
OUT_PUBLIC_INDEX_POINT_DIR = OUT_PUBLICATION_DIR / "index_point"
LOG_DIR = OUTPUTS_DIR / "logs"
TMP_GDAL_DIR = TMP_DIR / "gdal"
