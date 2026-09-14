from __future__ import annotations

import gzip
import hashlib
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from xml.parsers import expat


@dataclass(frozen=True)
class GpxValidationResult:
    compressed_size_bytes: int
    uncompressed_size_bytes: int
    content_sha256: str
    track_point_count: int
    started_at: datetime | None
    ended_at: datetime | None
    distance_m: float
    bbox: dict[str, float]


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1.0, math.sqrt(h)))


def validate_gpx_gzip(
    path: Path,
    *,
    max_compressed_bytes: int,
    max_uncompressed_bytes: int,
) -> GpxValidationResult:
    if path.name.lower().endswith(".gpx.gz") is False:
        raise ValueError("GPX archive filename must end in .gpx.gz")
    compressed_size = path.stat().st_size
    if compressed_size <= 0 or compressed_size > max_compressed_bytes:
        raise ValueError("compressed GPX size is outside configured limits")

    digest = hashlib.sha256()
    with path.open("rb") as source:
        magic = source.read(2)
        if magic != b"\x1f\x8b":
            raise ValueError("file does not contain gzip data")
        digest.update(magic)
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)

    uncompressed_size = 0
    root_name: str | None = None
    track_points = 0
    west = south = float("inf")
    east = north = float("-inf")
    started_at: datetime | None = None
    ended_at: datetime | None = None
    previous: tuple[float, float] | None = None
    distance_m = 0.0
    current_point: tuple[float, float] | None = None
    capture_time = False
    time_text: list[str] = []

    def reject_declaration(*_args: object) -> None:
        raise ValueError("GPX XML declarations for DTD/entities are forbidden")

    def start_element(tag: str, attributes: dict[str, str]) -> None:
        nonlocal root_name, track_points, west, east, south, north
        nonlocal previous, current_point, distance_m, capture_time, time_text
        name = _local_name(tag)
        if root_name is None:
            root_name = name
        if name == "trkseg":
            previous = None
        if name == "trkpt":
            try:
                latitude = float(attributes["lat"])
                longitude = float(attributes["lon"])
            except (KeyError, TypeError, ValueError) as exc:
                raise ValueError("GPX track point has invalid coordinates") from exc
            if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                raise ValueError("GPX track point coordinates are out of range")
            track_points += 1
            current_point = (latitude, longitude)
            west, east = min(west, longitude), max(east, longitude)
            south, north = min(south, latitude), max(north, latitude)
            if previous is not None:
                distance_m += _distance_m(previous, current_point)
            previous = current_point
        elif name == "time" and current_point is not None:
            capture_time = True
            time_text = []

    def character_data(value: str) -> None:
        if capture_time:
            time_text.append(value)

    def end_element(tag: str) -> None:
        nonlocal current_point, capture_time, started_at, ended_at
        name = _local_name(tag)
        if name == "time" and capture_time:
            capture_time = False
            value = "".join(time_text).strip()
            if value:
                try:
                    timestamp = _parse_time(value)
                except ValueError as exc:
                    raise ValueError("GPX track point has invalid time") from exc
                started_at = timestamp if started_at is None else min(started_at, timestamp)
                ended_at = timestamp if ended_at is None else max(ended_at, timestamp)
        elif name == "trkpt":
            current_point = None

    parser = expat.ParserCreate(namespace_separator="}")
    parser.buffer_text = True
    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.CharacterDataHandler = character_data
    parser.StartDoctypeDeclHandler = reject_declaration
    parser.EntityDeclHandler = reject_declaration
    parser.UnparsedEntityDeclHandler = reject_declaration
    parser.ExternalEntityRefHandler = reject_declaration
    parser.NotationDeclHandler = reject_declaration
    parser.SkippedEntityHandler = reject_declaration
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    try:
        with gzip.open(path, "rb") as source:
            while chunk := source.read(64 * 1024):
                uncompressed_size += len(chunk)
                if uncompressed_size > max_uncompressed_bytes:
                    raise ValueError("uncompressed GPX size exceeds configured limit")
                parser.Parse(chunk, False)
        parser.Parse(b"", True)
    except (gzip.BadGzipFile, EOFError, OSError) as exc:
        raise ValueError(f"invalid gzip stream: {exc}") from exc
    except Exception as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError(f"invalid GPX XML: {exc}") from exc

    if root_name != "gpx":
        raise ValueError("decompressed XML root is not gpx")
    if track_points == 0:
        raise ValueError("GPX contains no track points")
    return GpxValidationResult(
        compressed_size_bytes=compressed_size,
        uncompressed_size_bytes=uncompressed_size,
        content_sha256=digest.hexdigest(),
        track_point_count=track_points,
        started_at=started_at,
        ended_at=ended_at,
        distance_m=distance_m,
        bbox={"west": west, "south": south, "east": east, "north": north},
    )
