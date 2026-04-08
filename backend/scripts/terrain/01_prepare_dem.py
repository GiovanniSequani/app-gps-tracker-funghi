from __future__ import annotations

import argparse
from pathlib import Path

from osgeo import gdal  # type: ignore

from backend.config.paths import RAW_DEM_DIR, INT_TERRAIN_DIR
from backend.config.domain import BBOX, TARGET_CRS


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def prepare_dem(
    src_path: Path,
    dst_path: Path,
    bbox: dict[str, float],
    dst_crs: str,
    overwrite: bool = False,
) -> Path:
    if dst_path.exists() and not overwrite:
        print(f"[SKIP] DEM già pronto: {dst_path}")
        return dst_path

    if not src_path.is_file():
        raise FileNotFoundError(f"DEM sorgente non trovato: {src_path}")

    ensure_dir(dst_path.parent)

    src_ds = gdal.Open(str(src_path))
    if src_ds is None:
        raise RuntimeError(f"Impossibile aprire DEM: {src_path}")

    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]

    print("=" * 70)
    print("PREPARE DEM")
    print(f"Input       : {src_path}")
    print(f"Output      : {dst_path}")
    print(f"BBOX        : {west}, {south}, {east}, {north}")
    print(f"Target CRS  : {dst_crs}")
    print("=" * 70)

    warp_ds = gdal.Warp(
        str(dst_path),
        src_ds,
        format="GTiff",
        outputBounds=[west, south, east, north],
        dstSRS=dst_crs,
        multithread=True,
        resampleAlg="bilinear",
        srcNodata=None,
        dstNodata=-9999.0,
        creationOptions=[
            "COMPRESS=DEFLATE",
            "PREDICTOR=2",
            "ZLEVEL=6",
            "TILED=YES",
            "BIGTIFF=IF_SAFER",
        ],
    )

    if warp_ds is None:
        raise RuntimeError("gdal.Warp fallito durante la preparazione del DEM")

    band = warp_ds.GetRasterBand(1)
    band.SetNoDataValue(-9999.0)
    band.FlushCache()
    warp_ds.FlushCache()

    print(f"[OK] DEM preparato: {dst_path}")
    return dst_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--src",
        default=str(RAW_DEM_DIR / "dsm_30m.tif"),
        help="GeoTIFF DEM sorgente",
    )
    parser.add_argument(
        "--dst",
        default=str(INT_TERRAIN_DIR / "dem_work.tif"),
        help="GeoTIFF DEM di lavoro",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sovrascrive l'output se esiste già",
    )
    args = parser.parse_args()

    prepare_dem(
        src_path=Path(args.src),
        dst_path=Path(args.dst),
        bbox=BBOX,
        dst_crs=TARGET_CRS,
        overwrite=args.overwrite,
    )


if __name__ == "__main__":
    main()