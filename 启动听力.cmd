@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch.mjs
if errorlevel 1 (
  echo 启动遇到问题，请查看上面的提示或 runtime\server.log。
  pause
)
