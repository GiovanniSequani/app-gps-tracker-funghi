from __future__ import annotations

import numpy as np
import pytest

from backend.src.terrain.aspect import (
    downhill_aspect_deg_north_up,
    validate_north_up_geotransform,
)


@pytest.mark.parametrize(
    ("dem", "expected_deg"),
    [
        (np.indices((9, 9), dtype=np.float32)[0], 0.0),
        (-np.indices((9, 9), dtype=np.float32)[1], 90.0),
        (-np.indices((9, 9), dtype=np.float32)[0], 180.0),
        (np.indices((9, 9), dtype=np.float32)[1], 270.0),
    ],
    ids=("descent_north", "descent_east", "descent_south", "descent_west"),
)
def test_downhill_aspect_cardinal_slopes(dem: np.ndarray, expected_deg: float) -> None:
    dz_south, dz_east = np.gradient(dem, 1.0, 1.0)

    aspect = downhill_aspect_deg_north_up(dz_south, dz_east)

    assert float(aspect[4, 4]) == pytest.approx(expected_deg)


def test_north_up_geotransform_is_accepted() -> None:
    validate_north_up_geotransform((100.0, 30.0, 0.0, 200.0, 0.0, -30.0))


@pytest.mark.parametrize(
    "geotransform",
    [
        (100.0, -30.0, 0.0, 200.0, 0.0, -30.0),
        (100.0, 30.0, 0.0, 200.0, 0.0, 30.0),
        (100.0, 30.0, 0.1, 200.0, 0.0, -30.0),
        (100.0, 30.0, 0.0, 200.0, 0.1, -30.0),
    ],
)
def test_non_north_up_geotransform_is_rejected(
    geotransform: tuple[float, float, float, float, float, float],
) -> None:
    with pytest.raises(ValueError, match="north-up|rotated"):
        validate_north_up_geotransform(geotransform)
