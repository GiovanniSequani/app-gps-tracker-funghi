@echo off
setlocal

cd /d "%~dp0\..\.."
python -m backend.scripts.run_daily_fungus_pipeline %*

endlocal
