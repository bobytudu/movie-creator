@echo off
title Movie Creator Studio
cls
echo ===================================================
echo   Starting Movie Creator Studio...
echo ===================================================
echo.
echo Launching Backend server (Bun) in a new window...
start "Movie Creator Backend" cmd /k "cd /d "%~dp0backend" && bun run server"
echo.
echo Launching Frontend dev server (Vite) in a new window...
start "Movie Creator Frontend" cmd /k "cd /d "%~dp0frontend" && bun dev"
echo.
echo ===================================================
echo   Both servers are starting up!
echo   - Backend: http://localhost:3001
echo   - Frontend: check the console for Vite URL
echo ===================================================
timeout /t 5
