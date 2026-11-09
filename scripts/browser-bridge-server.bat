@echo off
setlocal DisableDelayedExpansion
node -e "process.exit(typeof fetch === 'function' && typeof require('node:util').parseArgs === 'function' && typeof AbortSignal.timeout === 'function' ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto python
node "%~dp0node\server.mjs" %*
exit /b %ERRORLEVEL%
:python
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 goto pylauncher
python -B "%~dp0python\server.py" %*
exit /b %ERRORLEVEL%
:pylauncher
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if errorlevel 1 goto missing
py -3 -B "%~dp0python\server.py" %*
exit /b %ERRORLEVEL%
:missing
echo Install a current Node.js LTS from https://nodejs.org/en/download or Python 3.10+ from https://www.python.org/downloads/windows/ and add it to PATH.
echo You may also provide a portable runtime. No runtime was downloaded.
exit /b 3
