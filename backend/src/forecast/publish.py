"""Forecast-only publication. Postgres CAS is the authoritative public pointer."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

from backend.src.publication.common import sha256_file


@contextmanager
def local_lock(path):
    with path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def cleanup_local(root, cache, now):
    """Only our explicit generation roots, never official files or broad globs."""
    cutoff = now - pd.Timedelta(days=7)
    for path in root.iterdir():
        if not path.is_dir() or not re.fullmatch(r"\d{8}T\d{6}Z", path.name):
            continue
        manifest = path / "manifest.json"
        expiry = pd.Timestamp(json.loads(manifest.read_text())["valid_until"]) if manifest.exists() else pd.to_datetime(path.name, format="%Y%m%dT%H%M%SZ", utc=True)
        if expiry <= cutoff:
            if path.resolve().parent != root.resolve():
                raise ValueError("unsafe forecast cleanup path")
            shutil.rmtree(path)
    if cache.exists():
        for path in cache.iterdir():
            if path.is_file() and pd.Timestamp(path.stat().st_mtime, unit="s", tz="UTC") < cutoff:
                path.unlink()


def object_inventory(manifest):
    version = manifest["version"]
    if not re.fullmatch(r"\d{8}T\d{6}Z", version):
        raise ValueError("invalid forecast version")
    records = []
    for key, bucket, local_prefix in (("chunks", "forecast-data", ""), ("tiles", "forecast-tiles", "tiles/")):
        for obj in manifest[key]:
            relative = obj["path"]
            if ".." in relative or relative.startswith(("/", "\\")) or "\\" in relative:
                raise ValueError("invalid forecast object path")
            records.append((bucket, version + "/" + relative, local_prefix + relative, obj))
    if len({(r[0], r[1]) for r in records}) != len(records):
        raise ValueError("duplicate forecast object paths")
    return records


def publish(directory, env_file, client=None):
    if client is None:
        from backend.src.publication.supabase import SupabaseClient
        client = SupabaseClient.from_env(env_file)
    manifest = json.loads((directory / "manifest.json").read_text())
    if "rows" in manifest:
        expected = math.ceil(manifest["rows"] / 50) * math.ceil(manifest["cols"] / 50)
        if len(manifest["chunks"]) != expected or not manifest["tiles"]:
            raise ValueError("incomplete forecast manifest")
    objects = object_inventory(manifest)
    # Validate all local bytes before any remote mutation.
    for _, _, relative, item in objects:
        path = directory / relative
        if path.stat().st_size != item["bytes"] or sha256_file(path) != item["sha256"]:
            raise ValueError("forecast local integrity failure")
    payload = {"p_version": manifest["version"], "p_issued_at": manifest["issued_at"],
               "p_valid_until": manifest["valid_until"], "p_manifest": manifest,
               "p_sha256": sha256_file(directory / "manifest.json")}
    cleanup_remote(client)
    result = client.rpc("stage_forecast", payload)
    if result in ("stale", "unchanged"):
        cleanup_remote(client)
        print(f"[FORECAST PUBLISH] action={result}")
        return result
    for idx, (bucket, remote, relative, _) in enumerate(objects, 1):
        client.storage_upload(bucket, remote, (directory / relative).read_bytes(),
                              content_type="image/png" if bucket == "forecast-tiles" else "application/octet-stream",
                              cache_control="31536000, immutable")
        # Exact-key readback, no listing. Check every payload before promotion.
        if client.storage_get(bucket, remote) != (directory / relative).read_bytes():
            raise ValueError("forecast object verification failed; pointer unchanged")
        if idx == 1 or idx % 100 == 0:
            print(f"[FORECAST UPLOAD] objects={idx}/{len(objects)}", flush=True)
    manifest_path = manifest["version"] + "/manifest.json"
    client.storage_upload("forecast-data", manifest_path, (directory / "manifest.json").read_bytes(),
                          content_type="application/json", cache_control="31536000, immutable")
    if client.storage_get("forecast-data", manifest_path) != (directory / "manifest.json").read_bytes():
        raise ValueError("remote forecast manifest verification failed; pointer unchanged")
    result = client.rpc("activate_forecast", {"p_version": manifest["version"], "p_sha256": payload["p_sha256"]})
    print(f"[FORECAST PUBLISH] action={result} version={manifest['version']}", flush=True)
    cleanup_remote(client)
    return result


def cleanup_remote(client):
    # Registry includes staging failures. No Storage discovery/listing.
    expired = client.rpc("expired_forecasts", {})
    for item in expired:
        manifest = item["manifest"]
        records = object_inventory(manifest)
        for bucket in ("forecast-data", "forecast-tiles"):
            paths = [remote for b, remote, _, _ in records if b == bucket]
            if bucket == "forecast-data":
                paths.append(manifest["version"] + "/manifest.json")
            client.storage_delete(bucket, paths)
        client.rpc("forget_forecast", {"p_version": manifest["version"]})
