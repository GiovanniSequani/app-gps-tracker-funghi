from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from dotenv import load_dotenv

from backend.src.publication.common import canonical_json_bytes
from backend.src.publication.terrain import TerrainDataset
from backend.src.publication.weather import WeatherDataset


RETRYABLE_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}


class SupabaseRequestError(RuntimeError):
    pass


class SupabaseClient:
    def __init__(
        self,
        url: str,
        service_role_key: str,
        *,
        retries: int = 6,
        timeout_seconds: int = 120,
        session: requests.Session | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.key = service_role_key
        self.retries = max(1, retries)
        self.timeout_seconds = timeout_seconds
        self.session = session or requests.Session()

    @classmethod
    def from_env(
        cls,
        env_file: Path,
        *,
        retries: int | None = None,
    ) -> "SupabaseClient":
        if env_file.is_file():
            load_dotenv(env_file, override=False)
        import os

        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY")
        if not url or not key:
            raise RuntimeError(
                "Supabase backend config missing: set SUPABASE_URL and "
                "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) in backend/.env"
            )
        retry_count = retries
        if retry_count is None:
            try:
                retry_count = int(os.getenv("SUPABASE_PUBLICATION_RETRIES", "6"))
            except ValueError:
                retry_count = 6
        return cls(url, key, retries=retry_count)

    def _headers(self, content_type: str = "application/json") -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.key}",
            "apikey": self.key,
            "Content-Type": content_type,
        }

    def request(
        self,
        method: str,
        path: str,
        *,
        expected: tuple[int, ...] = (200,),
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> requests.Response:
        url = f"{self.url}{path}"
        last_error = "unknown error"
        for attempt in range(1, self.retries + 1):
            try:
                response = self.session.request(
                    method,
                    url,
                    headers=headers or self._headers(),
                    timeout=self.timeout_seconds,
                    **kwargs,
                )
                if response.status_code in expected:
                    return response
                last_error = f"HTTP {response.status_code}: {response.text[:500]}"
                if response.status_code not in RETRYABLE_STATUS_CODES:
                    break
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
            if attempt < self.retries:
                time.sleep(min(30.0, 2.0 ** min(attempt, 5)) + random.uniform(0.0, 0.5))
        raise SupabaseRequestError(f"{method} {path} failed: {last_error}")

    def rest_select(
        self,
        table: str,
        *,
        params: dict[str, str],
    ) -> list[dict[str, Any]]:
        response = self.request(
            "GET",
            f"/rest/v1/{quote(table, safe='')}",
            params=params,
        )
        result = response.json()
        if not isinstance(result, list):
            raise SupabaseRequestError(f"unexpected REST response for {table}")
        return result

    def rest_upsert(
        self,
        table: str,
        rows: list[dict[str, object]],
        *,
        on_conflict: str,
    ) -> None:
        headers = self._headers()
        headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
        self.request(
            "POST",
            f"/rest/v1/{quote(table, safe='')}?on_conflict={quote(on_conflict, safe=',')}",
            expected=(200, 201, 204),
            headers=headers,
            json=rows,
        )

    def rpc(self, function: str, payload: dict[str, object]) -> Any:
        response = self.request(
            "POST",
            f"/rest/v1/rpc/{quote(function, safe='')}",
            expected=(200, 204),
            json=payload,
        )
        if not response.content:
            return None
        return response.json()

    def storage_get(self, bucket: str, remote_path: str) -> bytes | None:
        encoded = quote(remote_path.strip("/"), safe="/")
        response = self.request(
            "GET",
            f"/storage/v1/object/{quote(bucket, safe='')}/{encoded}",
            expected=(200, 400, 404),
            headers=self._headers("application/octet-stream"),
        )
        if response.status_code == 404:
            return None
        if response.status_code == 400:
            try:
                error_body = response.json()
            except ValueError:
                error_body = {}
            if str(error_body.get("statusCode")) == "404":
                return None
            raise SupabaseRequestError(
                f"GET storage {bucket}/{remote_path} failed: "
                f"HTTP 400: {response.text[:500]}"
            )
        return response.content

    def storage_upload(
        self,
        bucket: str,
        remote_path: str,
        payload: bytes,
        *,
        content_type: str,
        cache_control: str,
    ) -> None:
        headers = self._headers(content_type)
        headers["x-upsert"] = "true"
        headers["cache-control"] = cache_control
        encoded = quote(remote_path.strip("/"), safe="/")
        self.request(
            "POST",
            f"/storage/v1/object/{quote(bucket, safe='')}/{encoded}",
            expected=(200, 201),
            headers=headers,
            data=payload,
        )

    def storage_delete(self, bucket: str, remote_paths: list[str]) -> None:
        if not remote_paths:
            return
        for start in range(0, len(remote_paths), 500):
            batch = remote_paths[start:start + 500]
            self.request(
                "DELETE",
                f"/storage/v1/object/{quote(bucket, safe='')}",
                expected=(200,),
                json={"prefixes": batch},
            )

    def ensure_public_storage_bucket(
        self,
        bucket: str,
        *,
        file_size_limit: int = 5 * 1024 * 1024,
    ) -> None:
        encoded_bucket = quote(bucket, safe="")
        response = self.request(
            "GET",
            f"/storage/v1/bucket/{encoded_bucket}",
            expected=(200, 400, 404),
        )
        body = {
            "id": bucket,
            "name": bucket,
            "public": True,
            "file_size_limit": file_size_limit,
            "allowed_mime_types": ["application/octet-stream", "application/json"],
        }
        bucket_missing = response.status_code == 404
        if response.status_code == 400:
            try:
                error_body = response.json()
            except requests.JSONDecodeError:
                error_body = {}
            bucket_missing = str(error_body.get("statusCode")) == "404"
            if not bucket_missing:
                raise SupabaseRequestError(
                    f"GET bucket {bucket} failed: HTTP 400: {response.text[:500]}"
                )
        if bucket_missing:
            self.request(
                "POST",
                "/storage/v1/bucket",
                expected=(200, 201),
                json=body,
            )
            return
        current = response.json()
        if (
            not bool(current.get("public"))
            or current.get("file_size_limit") != file_size_limit
            or set(current.get("allowed_mime_types") or [])
            != set(body["allowed_mime_types"])
        ):
            update_body = dict(body)
            update_body.pop("id")
            self.request(
                "PUT",
                f"/storage/v1/bucket/{encoded_bucket}",
                expected=(200,),
                json=update_body,
            )


def latest_tile_index_date(
    client: SupabaseClient,
    *,
    bucket: str = "tiles",
    manifest_path: str = "tile_sets.json",
) -> str:
    payload = client.storage_get(bucket, manifest_path)
    if payload is None:
        raise RuntimeError(f"{bucket}/{manifest_path} is missing")
    try:
        manifest = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{bucket}/{manifest_path} is invalid: {exc}") from exc
    entries = manifest.get("tileSets")
    if not isinstance(entries, list):
        raise RuntimeError(f"{bucket}/{manifest_path} has no tileSets array")
    dates: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("date"), str):
            continue
        raw_date = str(entry["date"]).replace("_", "-")
        try:
            parsed = time.strptime(raw_date, "%Y-%m-%d")
        except ValueError:
            continue
        dates.append(time.strftime("%Y-%m-%d", parsed))
    if not dates:
        raise RuntimeError(f"{bucket}/{manifest_path} contains no valid index dates")
    return max(dates)


def weather_publication_decision(requested_date: str, latest_index_date: str) -> str:
    try:
        requested = time.strptime(requested_date, "%Y-%m-%d")
        latest = time.strptime(latest_index_date, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError("weather and index versions must be YYYY-MM-DD") from exc
    if requested < latest:
        return "skip_older"
    if requested > latest:
        raise RuntimeError(
            f"weather version {requested_date} cannot be published because the latest "
            f"Supabase index in tiles/tile_sets.json is {latest_index_date}"
        )
    return "publish"


@dataclass(frozen=True)
class WeatherPublishResult:
    action: str
    version: str
    uploaded_cells: int
    storage_stats: dict[str, object] | None


class WeatherPublisher:
    def __init__(self, client: SupabaseClient, *, batch_size: int = 200) -> None:
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self.client = client
        self.batch_size = batch_size

    def _current(self) -> dict[str, object] | None:
        rows = self.client.rest_select(
            "public_weather_state",
            params={"select": "current_version", "singleton_id": "eq.1"},
        )
        return rows[0] if rows else None

    def _dataset(self, version: str) -> dict[str, object] | None:
        rows = self.client.rest_select(
            "public_weather_datasets",
            params={
                "select": "version,status,content_sha256,expected_cells",
                "version": f"eq.{version}",
            },
        )
        return rows[0] if rows else None

    def publish(self, dataset: WeatherDataset) -> WeatherPublishResult:
        current = self._current()
        if (
            current
            and isinstance(current.get("current_version"), str)
            and str(current["current_version"]) > dataset.version
        ):
            stats = self.client.rpc("public_weather_storage_stats", {})
            return WeatherPublishResult("skipped_older", dataset.version, 0, stats)
        if current and current.get("current_version") == dataset.version:
            remote = self._dataset(dataset.version)
            if (
                remote
                and remote.get("status") == "current"
                and remote.get("content_sha256") == dataset.content_sha256
                and int(remote.get("expected_cells", -1)) == dataset.expected_cells
            ):
                stats = self.client.rpc("public_weather_storage_stats", {})
                return WeatherPublishResult("unchanged", dataset.version, 0, stats)
            raise RuntimeError(
                f"current weather version {dataset.version} exists with different content"
            )

        metadata = dataset.metadata
        self.client.rpc(
            "prepare_public_weather_version",
            {
                "p_version": dataset.version,
                "p_index_date": dataset.index_date.isoformat(),
                "p_dates": [item.isoformat() for item in dataset.dates],
                "p_missing_dates": metadata["missing_dates"],
                "p_rows": dataset.rows,
                "p_cols": dataset.cols,
                "p_bbox": metadata["bbox"],
                "p_origin_lat": metadata["origin_lat"],
                "p_origin_lon": metadata["origin_lon"],
                "p_step_deg": metadata["step_deg"],
                "p_source_stride": metadata["source_stride"],
                "p_sampling_method": metadata["sampling_method"],
                "p_variables": metadata["variables"],
                "p_content_sha256": dataset.content_sha256,
            },
        )

        uploaded = 0
        for batch in dataset.iter_cell_batches(self.batch_size):
            self.client.rest_upsert(
                "public_weather_cells",
                batch,
                on_conflict="version,row_idx,col_idx",
            )
            uploaded += len(batch)
        if uploaded != dataset.expected_cells:
            raise RuntimeError(
                f"uploaded {uploaded} weather cells; expected {dataset.expected_cells}"
            )

        result = self.client.rpc(
            "publish_public_weather_version",
            {"p_version": dataset.version},
        )
        stats = result if isinstance(result, dict) else None
        return WeatherPublishResult("published", dataset.version, uploaded, stats)


@dataclass(frozen=True)
class TerrainPublishResult:
    action: str
    version: str
    uploaded_objects: int
    deleted_objects: int


class TerrainPublisher:
    CURRENT_OBJECT = "current.json"

    def __init__(self, client: SupabaseClient, *, bucket: str = "terrain") -> None:
        if bucket == "tiles":
            raise ValueError("terrain publisher must not use the tiles bucket")
        self.client = client
        self.bucket = bucket

    def _get_json(self, remote_path: str) -> dict[str, object] | None:
        payload = self.client.storage_get(self.bucket, remote_path)
        if payload is None:
            return None
        result = json.loads(payload.decode("utf-8"))
        if not isinstance(result, dict):
            raise RuntimeError(f"{remote_path} is not a JSON object")
        return result

    def publish(self, dataset: TerrainDataset) -> TerrainPublishResult:
        current = self._get_json(self.CURRENT_OBJECT)
        if current and current.get("version") == dataset.version:
            if current.get("dataset_sha256") == dataset.dataset_sha256:
                return TerrainPublishResult("unchanged", dataset.version, 0, 0)
            raise RuntimeError(
                f"published terrain version {dataset.version} exists with different content"
            )

        uploaded = 0
        for chunk in dataset.chunks:
            payload = (dataset.output_dir / chunk.relative_path).read_bytes()
            if len(payload) != chunk.byte_length:
                raise RuntimeError(f"local terrain chunk size changed: {chunk.relative_path}")
            remote_path = f"{dataset.version}/{chunk.relative_path}"
            self.client.storage_upload(
                self.bucket,
                remote_path,
                payload,
                content_type="application/octet-stream",
                cache_control="public,max-age=31536000,immutable",
            )
            uploaded += 1

        manifest_path = f"{dataset.version}/manifest.json"
        self.client.storage_upload(
            self.bucket,
            manifest_path,
            dataset.manifest_bytes,
            content_type="application/json",
            cache_control="public,max-age=31536000,immutable",
        )
        uploaded += 1
        remote_manifest = self._get_json(manifest_path)
        if not remote_manifest or remote_manifest.get("dataset_sha256") != dataset.dataset_sha256:
            raise RuntimeError("remote terrain manifest verification failed")

        pointer = {
            "contract_version": 1,
            "version": dataset.version,
            "manifest_path": manifest_path,
            "dataset_sha256": dataset.dataset_sha256,
        }
        pointer_bytes = canonical_json_bytes(pointer) + b"\n"
        self.client.storage_upload(
            self.bucket,
            self.CURRENT_OBJECT,
            pointer_bytes,
            content_type="application/json",
            cache_control="public,max-age=60,must-revalidate",
        )
        uploaded += 1
        remote_pointer = self._get_json(self.CURRENT_OBJECT)
        if remote_pointer != pointer:
            raise RuntimeError("remote terrain current pointer verification failed")

        deleted = 0
        if current:
            old_version = current.get("version")
            old_manifest_path = current.get("manifest_path")
            if (
                isinstance(old_version, str)
                and old_version != dataset.version
                and isinstance(old_manifest_path, str)
            ):
                old_manifest = self._get_json(old_manifest_path)
                old_paths: list[str] = []
                if old_manifest:
                    chunks = old_manifest.get("chunks", [])
                    if isinstance(chunks, list):
                        for item in chunks:
                            if isinstance(item, dict) and isinstance(item.get("path"), str):
                                path = str(item["path"])
                                if path.startswith(f"{old_version}/"):
                                    old_paths.append(path)
                old_paths.append(old_manifest_path)
                self.client.storage_delete(self.bucket, sorted(set(old_paths)))
                deleted = len(set(old_paths))

        return TerrainPublishResult("published", dataset.version, uploaded, deleted)
