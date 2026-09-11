@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================================
echo   DeepSeek for Windows - Build ^& Publish Script (.NET 8)
echo ========================================================

where dotnet >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] .NET SDK not found in PATH!
    echo Please install .NET 8.0 SDK from https://dotnet.microsoft.com/download
    pause
    exit /b 1
)

echo [1/3] Restoring NuGet dependencies...
dotnet restore DeepSeek.csproj
if %ERRORLEVEL% neq 0 (
    echo [ERROR] dotnet restore failed.
    pause
    exit /b 1
)

echo [2/3] Building and publishing...
rem NOTE: PublishSingleFile is forbidden (PowerShell SDK crashes under single-file, see csproj comment)
dotnet publish DeepSeek.csproj -c Release -r win-x64 --self-contained false -o publish
if %ERRORLEVEL% neq 0 (
    echo [ERROR] dotnet publish failed.
    pause
    exit /b 1
)

echo [3/3] Build completed successfully!
echo Executable generated at: %~dp0publish\DeepSeek.exe
echo.
pause
