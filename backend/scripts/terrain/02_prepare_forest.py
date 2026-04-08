from __future__ import annotations

import argparse
from pathlib import Path

from osgeo import gdal  # type: ignore

from backend.config.paths import INT_FOREST_DIR
from backend.config.domain import BBOX


DLT_VALUES = {
    "non_forest": 0,
    "broadleaf": 1,
    "conifer": 2,
}


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def prepare_forest(
    src_path: Path,
    dst_path: Path,
    bbox: dict[str, float],
    overwrite: bool = False,
) -> Path:
    """
    Ritaglia il mosaico DLT sul bbox di progetto.
    Mantiene il CRS nativo del prodotto (EPSG:3035) per evitare
    resampling prematuri su un raster categorico.
    """
    if dst_path.exists() and not overwrite:
        print(f"[SKIP] Forest work raster già pronto: {dst_path}")
        return dst_path

    if not src_path.is_file():
        raise FileNotFoundError(f"Mosaico forestale sorgente non trovato: {src_path}")

    ensure_dir(dst_path.parent)

    src_ds = gdal.Open(str(src_path))
    if src_ds is None:
        raise RuntimeError(f"Impossibile aprire raster forestale: {src_path}")

    west = bbox["west"]
    south = bbox["south"]
    east = bbox["east"]
    north = bbox["north"]

    print("=" * 70)
    print("PREPARE FOREST")
    print(f"Input       : {src_path}")
    print(f"Output      : {dst_path}")
    print(f"BBOX WGS84  : {west}, {south}, {east}, {north}")
    print("Classi DLT  : 0=non_forest, 1=broadleaf, 2=conifer")
    print("=" * 70)

    # bbox fornito in WGS84, raster nativo in EPSG:3035
    warp_ds = gdal.Warp(
        str(dst_path),
        src_ds,
        format="GTiff",
        outputBounds=[west, south, east, north],
        outputBoundsSRS="EPSG:4326",
        dstSRS=src_ds.GetProjection(),
        multithread=True,
        resampleAlg="near",
        srcNodata=None,
        dstNodata=255,
        creationOptions=[
            "COMPRESS=DEFLATE",
            "PREDICTOR=2",
            "ZLEVEL=6",
            "TILED=YES",
            "BIGTIFF=IF_SAFER",
        ],
    )

    if warp_ds is None:
        raise RuntimeError("gdal.Warp fallito durante il ritaglio del raster forestale")

    band = warp_ds.GetRasterBand(1)
    band.SetNoDataValue(255)
    band.FlushCache()
    warp_ds.FlushCache()

    print(f"[OK] Forest raster preparato: {dst_path}")
    return dst_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--src",
        default=str(INT_FOREST_DIR / "dlt_2023_mosaic.tif"),
        help="Mosaico DLT sorgente",
    )
    parser.add_argument(
        "--dst",
        default=str(INT_FOREST_DIR / "dlt_2023_work.tif"),
        help="Raster forestale di lavoro ritagliato sul progetto",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Sovrascrive l'output se esiste già",
    )
    args = parser.parse_args()

    prepare_forest(
        src_path=Path(args.src),
        dst_path=Path(args.dst),
        bbox=BBOX,
        overwrite=args.overwrite,
    )


if __name__ == "__main__":
    main()