@echo off
title PISTA - servidor de teste
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0servidor.ps1"
if errorlevel 1 pause
