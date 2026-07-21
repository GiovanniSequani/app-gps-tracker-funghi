from backend.scripts.pipeline_logging import format_cmd, is_superfluous_log_line


def test_format_cmd_compacts_python_module_command() -> None:
    cmd = [
        r"C:\Program Files\Python312\python.exe",
        "-m",
        "backend.scripts.index.run_index_pipeline",
        "--date",
        "2026-06-29",
    ]

    assert format_cmd(cmd) == "python -m backend.scripts.index.run_index_pipeline --date 2026-06-29"


def test_compact_log_filter_removes_progress_noise() -> None:
    assert is_superfluous_log_line("0...10...20...100 - done.\n") is True
    assert is_superfluous_log_line("  round=1 250/3325 total_ok=250 round_fail=0\n") is True
    assert is_superfluous_log_line("[GET] https://example.test/file.grib2.bz2\n") is True
    assert is_superfluous_log_line("[STEP 002]\n") is True


def test_compact_log_filter_keeps_decision_and_failure_lines() -> None:
    assert is_superfluous_log_line("[WARN] 04 non ha prodotto daily candidates\n") is False
    assert is_superfluous_log_line("[FAIL] tile HTTP 504\n") is False
    assert is_superfluous_log_line("[PUBLISH] Publishing day(s): ['2026-06-29']\n") is False
