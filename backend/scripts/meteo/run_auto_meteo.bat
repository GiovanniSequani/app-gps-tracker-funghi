@echo off
setlocal

cd /d "%~dp0\..\..\.."

call "C:\Users\giova\AppData\Local\Programs\OSGeo4W\bin\o4w_env.bat"
"C:\Users\giova\AppData\Local\Programs\OSGeo4W\bin\python.exe" -m backend.scripts.meteo.automatic_meteo_pipeline %*

endlocal