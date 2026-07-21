@echo off
setlocal

cd /d "%~dp0\..\.."
python -m backend.scripts.run_daily_fungus_pipeline %*
set "EXIT_CODE=%ERRORLEVEL%"

endlocal
exit /b %EXIT_CODE%
