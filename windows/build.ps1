$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  DeepSeek for Windows - Build & Publish Script (.NET 8)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error ".NET SDK not found in PATH! Please install .NET 8.0 SDK from https://dotnet.microsoft.com/download"
    exit 1
}

Write-Host "[1/3] Restoring NuGet dependencies..." -ForegroundColor Yellow
dotnet restore DeepSeek.csproj

Write-Host "[2/3] Building and publishing single-file executable..." -ForegroundColor Yellow
dotnet publish DeepSeek.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o publish

Write-Host "[3/3] Build completed successfully!" -ForegroundColor Green
Write-Host "Executable generated at: $ScriptDir\publish\DeepSeek.exe" -ForegroundColor Green
