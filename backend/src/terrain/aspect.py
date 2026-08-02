from __future__ import annotations

import numpy as np


def validate_north_up_geotransform(
    geotransform: tuple[float, float, float, float, float, float],
) -> None:
    """Require an unrotated GDAL north-up raster."""

    _, pixel_width, row_rotation, _, col_rotation, pixel_height = geotransform
    if pixel_width <= 0.0 or pixel_height >= 0.0:
        raise ValueError(
            "DEM must be north-up with positive pixel width and negative pixel height; "
            f"got pixel_width={pixel_width}, pixel_height={pixel_height}"
        )
    if not np.isclose(row_rotation, 0.0) or not np.isclose(col_rotation, 0.0):
        raise ValueError(
            "rotated DEM geotransforms are not supported for slope/aspect; "
            f"got rotations {row_rotation}, {col_rotation}"
        )


def downhill_aspect_deg_north_up(
    dz_south: np.ndarray,
    dz_east: np.ndarray,
) -> np.ndarray:
    """Return downslope aspect in degrees, with 0=N and clockwise rotation.

    ``dz_south`` follows increasing array rows and ``dz_east`` follows
    increasing columns, as in an unrotated GDAL north-up raster.
    """

    return np.mod(
        np.degrees(np.arctan2(-dz_east, dz_south)),
        360.0,
    ).astype(np.float32)
