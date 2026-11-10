@echo off
setlocal DisableDelayedExpansion
node "%~dp0check-server-runtime.mjs" >nul 2>nul
if errorlevel 1 goto python
node "%~dp0node\server.mjs" %*
exit /b %ERRORLEVEL%
:python
where uv.exe >nul 2>nul
if errorlevel 1 goto missing
uv run --offline --no-project --python ">=3.10" --with-requirements "%~dp0python\requirements.txt" python -B "%~dp0python\server.py" %*
exit /b %ERRORLEVEL%
:missing
echo Prepare the locked npm dependencies for Node.js 20+, or uv and the pinned Python WebSocket dependencies described in references/setup.md.
echo The launcher does not install packages or download a runtime.
exit /b 3
