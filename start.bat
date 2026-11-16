@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CreatorTecets

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
  python -c "import sys" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python не найден. Установите Python 3.10+ с https://www.python.org/downloads/
  echo При установке отметьте галочку "Add python.exe to PATH".
  pause
  exit /b 1
)

echo Установка зависимостей...
%PY% -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo Не удалось установить зависимости.
  pause
  exit /b 1
)

echo.
echo Приложение запускается: http://localhost:8000
echo Для остановки закройте это окно или нажмите Ctrl+C.
start "" http://localhost:8000
%PY% -m uvicorn app.main:app --port 8000
pause
