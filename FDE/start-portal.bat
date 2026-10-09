@echo off
rem Opens the FDE portal in your browser (local mode: tick, log time, save).
rem It pulls the latest progress from GitHub first. Keep this window open while you work.
cd /d "%~dp0"
python portal\serve.py
if errorlevel 1 pause
