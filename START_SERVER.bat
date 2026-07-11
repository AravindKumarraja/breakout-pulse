@echo off
title BreakoutPulse - Live Trading Scanner
color 0A
echo.
echo  ===============================================
echo   BREAKOUTPULSE - Starting Live Scanner...
echo  ===============================================
echo.
cd /d "C:\Users\Asus\.gemini\antigravity\scratch\breakout_pulse"
echo  Server starting on http://localhost:3005
echo  Keep this window OPEN to keep the scanner running.
echo  Press CTRL+C to stop the server.
echo.
node server.js
pause
