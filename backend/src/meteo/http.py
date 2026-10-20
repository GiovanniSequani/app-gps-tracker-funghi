"""Bounded availability checks for public weather files."""
from __future__ import annotations

import time

import requests


def remote_file_available(url: str, timeout: int = 20, attempts: int = 3) -> bool:
    """Only 404/410 mean absent; transport failures must not skip valid runs.

    DWD HEAD requests can time out while GET works. Request a tiny range and
    close the stream immediately, including when the server ignores Range.
    """
    for attempt in range(1, attempts + 1):
        status = None
        delay = min(2 ** (attempt - 1), 10)
        try:
            with requests.get(
                url, headers={"Range": "bytes=0-15", "Connection": "close"}, stream=True,
                timeout=(min(10, timeout), timeout),
            ) as response:
                status = response.status_code
                if status in (404, 410):
                    return False
                if status in (200, 206):
                    if next(response.iter_content(chunk_size=16), b""):
                        return True
                    status = "empty"
                elif status not in (408, 425, 429, 500, 502, 503, 504):
                    print(f"[METEO PROBE ERROR] status={status}; availability unknown", flush=True)
                    raise RuntimeError(f"Weather availability check rejected: HTTP {status}")
                retry_after = response.headers.get("Retry-After", "")
                if retry_after.isdigit():
                    delay = max(delay, min(int(retry_after), 30))
        except requests.RequestException as exc:
            status = type(exc).__name__
        if attempt == attempts:
            print(f"[METEO PROBE ERROR] status={status} attempts={attempts}; availability unknown", flush=True)
            raise RuntimeError("Weather availability check failed; retry the pipeline")
        print(f"[METEO PROBE RETRY] status={status} attempt={attempt}/{attempts}", flush=True)
        time.sleep(delay)
    raise ValueError("attempts must be positive")
