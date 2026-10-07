@echo off
setlocal
cd /d "%~dp0"
python -u -m backend.scripts.run_daily_forecast_pipeline %*
exit /b %errorlevel%
