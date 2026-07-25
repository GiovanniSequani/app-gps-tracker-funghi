from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

import numpy as np


VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def validate_version(value: str) -> str:
    if not VERSION_RE.fullmatch(value):
        raise ValueError(
            "version must start with an alphanumeric character and contain only "
            "letters, digits, '.', '_' or '-' (maximum 64 characters)"
        )
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path, block_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(block_size):
            digest.update(block)
    return digest.hexdigest()


def require_ascending_regular_coordinate(
    values: np.ndarray,
    *,
    name: str,
    expected_step: float,
    tolerance: float = 5e-6,
) -> None:
    coord = np.asarray(values, dtype=np.float64)
    if coord.ndim != 1 or coord.size < 2:
        raise ValueError(f"{name} must be a one-dimensional coordinate with at least two values")
    if not np.isfinite(coord).all():
        raise ValueError(f"{name} contains non-finite values")
    diffs = np.diff(coord)
    if not np.all(diffs > 0):
        raise ValueError(f"{name} must be strictly ascending")
    if not np.allclose(diffs, expected_step, rtol=0.0, atol=tolerance):
        raise ValueError(
            f"{name} is not regular at {expected_step} degrees: "
            f"observed range {float(diffs.min())}..{float(diffs.max())}"
        )


def coordinate_to_index(
    value: float,
    *,
    bbox_min: float,
    bbox_max: float,
    origin: float,
    step: float,
    count: int,
) -> int:
    if not math.isfinite(value):
        raise ValueError("coordinate must be finite")
    if value < bbox_min or value > bbox_max:
        raise ValueError(f"coordinate {value} is outside [{bbox_min}, {bbox_max}]")
    nearest = math.floor(((value - origin) / step) + 0.5)
    return min(max(nearest, 0), count - 1)

