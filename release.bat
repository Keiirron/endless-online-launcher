@echo off
cd /d "%~dp0"
set /p V=New version number (for example 0.1.2): 
if "%V%"=="" goto :eof
git add -A
git commit -m "Prepare v%V%"
git pull --rebase
if errorlevel 1 goto failed
call npm version %V% --allow-same-version -m "v%%s"
if errorlevel 1 goto failed
git push --follow-tags
if errorlevel 1 goto failed
echo.
echo Done. GitHub is now building the release:
echo https://github.com/Keiirron/endless-online-launcher/actions
pause
goto :eof
:failed
echo.
echo Something went wrong above. Nothing else was done.
pause
