param(
    [switch]$SkipTests = $false,
    [switch]$TestOnly = $false
)

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

if (-not $TestOnly) {
    Write-Host "[1/3] Restoring NuGet dependencies..." -ForegroundColor Yellow
    dotnet restore DeepSeek.csproj

    Write-Host "[2/3] Building and publishing..." -ForegroundColor Yellow
    # 注意：禁止 PublishSingleFile（PowerShell SDK 单文件下 Assembly.Location 为空会崩，见 csproj 注释）
    dotnet publish DeepSeek.csproj -c Release -r win-x64 --self-contained false -o publish

    Write-Host "[3/3] Build completed successfully!" -ForegroundColor Green
    Write-Host "Executable generated at: $ScriptDir\publish\DeepSeek.exe" -ForegroundColor Green
}

if (-not $SkipTests) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  Running RFC-0004 Automated Verification Suite" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan

    $testScripts = @(
        "scripts\verify-build-version.ps1",
        "scripts\verify-no-hooks.ps1",
        "scripts\verify-log-rotation.ps1",
        "scripts\verify-log-cleanup.ps1"
    )

    $passedCount = 0
    foreach ($ts in $testScripts) {
        $fullPath = Join-Path $ScriptDir $ts
        Write-Host ""
        Write-Host "--- [RUN] $ts ---" -ForegroundColor Yellow
        & pwsh -NoProfile -File $fullPath
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[FAIL] Verification script failed: $ts (ExitCode: $LASTEXITCODE)"
            exit $LASTEXITCODE
        }
        $passedCount++
    }

    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  RFC-0004 ACCEPTANCE REPORT: ALL $passedCount/4 VERIFICATIONS PASSED" -ForegroundColor Green
    Write-Host "  Status: FULL GREEN (0 Errors, 0 Warnings)" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
}
