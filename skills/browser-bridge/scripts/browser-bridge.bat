@echo off
setlocal DisableDelayedExpansion
where curl.exe >nul 2>nul
if errorlevel 1 goto missing
if not defined BROWSER_BRIDGE_URL set "BROWSER_BRIDGE_URL=http://127.0.0.1:30003"
if "%~1"=="profiles" goto profiles
if "%~1"=="status" goto status
if "%~1"=="stop" goto stop
if "%~1"=="tabs" goto tabs
if "%~1"=="request" goto request
if "%~1"=="discover" goto discover
if "%~1"=="rdp" goto rdp
if "%~1"=="find" goto find
echo Usage: %~nx0 profiles ^| discover [REQUEST.json] ^| find REQUEST.json ^| rdp REQUEST.json ^| status ^| stop ^| tabs PROFILE normal/private ^| request PROFILE normal/private REQUEST.json
exit /b 2
:find
if "%~2"=="" exit /b 2
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" -H "Content-Type: application/json" --data-binary "@%~2" "%BROWSER_BRIDGE_URL%/find-tabs"
exit /b %ERRORLEVEL%
:discover
if not "%~2"=="" goto discover_request
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" "%BROWSER_BRIDGE_URL%/discover"
exit /b %ERRORLEVEL%
:discover_request
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" -H "Content-Type: application/json" --data-binary "@%~2" "%BROWSER_BRIDGE_URL%/discover"
exit /b %ERRORLEVEL%
:rdp
if "%~2"=="" exit /b 2
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" -H "Content-Type: application/json" --data-binary "@%~2" "%BROWSER_BRIDGE_URL%/rdp"
exit /b %ERRORLEVEL%
:profiles
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" "%BROWSER_BRIDGE_URL%/profiles"
exit /b %ERRORLEVEL%
:status
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body "%BROWSER_BRIDGE_URL%/probe"
exit /b %ERRORLEVEL%
:stop
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -X POST -H "X-Browser-Bridge-Client: 1" "%BROWSER_BRIDGE_URL%/shutdown"
exit /b %ERRORLEVEL%
:tabs
if "%~2"=="" exit /b 2
if "%~3"=="" exit /b 2
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" --get --data-urlencode "profile_id=%~2" --data-urlencode "context=%~3" "%BROWSER_BRIDGE_URL%/tabs"
exit /b %ERRORLEVEL%
:request
if "%~2"=="" exit /b 2
if "%~3"=="" exit /b 2
if "%~4"=="" exit /b 2
if not "%~3"=="normal" if not "%~3"=="private" exit /b 2
curl.exe --noproxy 127.0.0.1,localhost --silent --show-error --fail-with-body -H "X-Browser-Bridge-Client: 1" -H "Content-Type: application/json" --data-binary "@%~4" "%BROWSER_BRIDGE_URL%/request?profile_id=%~2&context=%~3"
exit /b %ERRORLEVEL%
:missing
echo curl.exe is required. Install curl from https://curl.se/windows/ and add it to PATH. No download was started.
exit /b 3
