from datetime import datetime, timezone

from backend.scripts.meteo import automatic_meteo_pipeline as pipeline


def test_generate_candidate_runs_excludes_oldest_rolling_edge(monkeypatch, tmp_path) -> None:
    buffer_path = tmp_path / "hourly_buffer.nc"
    buffer_path.write_text("")
    monkeypatch.setattr(pipeline, "get_latest_run_from_buffer", lambda path: "2026062918")

    runs = pipeline.generate_candidate_runs(
        datetime(2026, 6, 29, 21, tzinfo=timezone.utc),
        buffer_path,
    )

    assert runs[0] == "2026062800"
    assert runs[-1] == "2026062921"
    assert "2026062721" not in runs
