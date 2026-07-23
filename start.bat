@echo off
REM Voxel Demolition - LAN host launcher for Windows. Double-click to start hosting.
cd /d %~dp0
if not exist node_modules (
  echo Installing dependencies for the first time...
  call npm install
)
echo.
echo Starting the Voxel Demolition host server...
echo Read the "PLAYERS JOIN AT" address below and share it with friends on your LAN.
echo (If Windows Firewall asks, click Allow on Private networks.)
echo.
node server\server.js
pause
