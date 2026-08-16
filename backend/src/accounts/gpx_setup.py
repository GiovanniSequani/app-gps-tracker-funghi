from __future__ import annotations

from dataclasses import dataclass
from typing import Any


EXPECTED_GPX_POLICIES = {
    "gpx_archive_config_read",
    "user_profiles_read_own",
    "user_profiles_update_username",
    "user_gpx_tracks_read_own",
    "user_gpx_mushroom_markers_read_own",
    "user_gpx_objects_select_own",
    "user_gpx_objects_insert_reserved",
    "user_gpx_objects_delete_own",
}


@dataclass(frozen=True)
class GpxSetupSummary:
    max_tracks_per_user: int
    max_compressed_bytes: int
    max_uncompressed_bytes: int
    profile_count: int
    track_count: int
    marker_count: int


def validate_gpx_setup_audit(payload: Any) -> GpxSetupSummary:
    if not isinstance(payload, dict):
        raise ValueError("user_gpx_setup_audit returned a non-object response")

    config = payload.get("config")
    bucket = payload.get("bucket")
    rls = payload.get("rls")
    policies = payload.get("policies")
    if not isinstance(config, dict):
        raise ValueError("GPX archive config is missing")
    if not isinstance(bucket, dict) or bucket.get("id") != "user-gpx":
        raise ValueError("private user-gpx bucket is missing")
    if bucket.get("public") is not False:
        raise ValueError("user-gpx bucket must be private")
    if not isinstance(rls, dict) or not all(
        rls.get(table) is True
        for table in (
            "user_profiles",
            "user_gpx_tracks",
            "user_gpx_mushroom_markers",
        )
    ):
        raise ValueError("RLS is not enabled on all private user tables")
    if not isinstance(policies, list):
        raise ValueError("GPX policy audit is missing")
    missing_policies = EXPECTED_GPX_POLICIES.difference(str(item) for item in policies)
    if missing_policies:
        raise ValueError(f"GPX policies are missing: {sorted(missing_policies)}")

    max_tracks = int(config.get("max_tracks_per_user", 0))
    max_compressed = int(config.get("max_compressed_bytes", 0))
    max_uncompressed = int(config.get("max_uncompressed_bytes", 0))
    if max_tracks <= 0 or max_compressed <= 0 or max_uncompressed < max_compressed:
        raise ValueError("GPX quota configuration is invalid")
    if int(bucket.get("file_size_limit", -1)) != max_compressed:
        raise ValueError("bucket file limit does not match database configuration")
    allowed_mimes = set(bucket.get("allowed_mime_types") or [])
    if allowed_mimes != {"application/gzip", "application/x-gzip"}:
        raise ValueError("user-gpx bucket MIME restrictions are invalid")

    return GpxSetupSummary(
        max_tracks_per_user=max_tracks,
        max_compressed_bytes=max_compressed,
        max_uncompressed_bytes=max_uncompressed,
        profile_count=int(payload.get("profiles", 0)),
        track_count=int(payload.get("tracks", 0)),
        marker_count=int(payload.get("markers", 0)),
    )
