from __future__ import annotations

import gzip
import hashlib
from dataclasses import dataclass
from pathlib import Path
from xml.etree.ElementTree import XMLPullParser


@dataclass(frozen=True)
class GpxValidationResult:
    compressed_size_bytes: int
    uncompressed_size_bytes: int
    content_sha256: str
    track_point_count: int


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


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

    parser = XMLPullParser(events=("start",))
    uncompressed_size = 0
    root_name: str | None = None
    track_points = 0
    try:
        with gzip.open(path, "rb") as source:
            while chunk := source.read(64 * 1024):
                uncompressed_size += len(chunk)
                if uncompressed_size > max_uncompressed_bytes:
                    raise ValueError("uncompressed GPX size exceeds configured limit")
                parser.feed(chunk)
                for _, element in parser.read_events():
                    name = _local_name(element.tag)
                    if root_name is None:
                        root_name = name
                    if name == "trkpt":
                        try:
                            latitude = float(element.attrib["lat"])
                            longitude = float(element.attrib["lon"])
                        except (KeyError, TypeError, ValueError) as exc:
                            raise ValueError("GPX track point has invalid coordinates") from exc
                        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                            raise ValueError("GPX track point coordinates are out of range")
                        track_points += 1
        parser.close()
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
    )
