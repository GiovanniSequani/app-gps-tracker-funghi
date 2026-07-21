@echo off
setlocal

cd /d "%~dp0\..\.."
python -m backend.scripts.run_daily_fungus_pipeline --meteo-bat backend\scripts\meteo\run_auto_meteo_ruc.bat --publication-model icon-d2-ruc %*
set "EXIT_CODE=%ERRORLEVEL%"

endlocal
exit /b %EXIT_CODE%
