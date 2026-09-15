# verify-build-version.ps1 - RFC-0004 Chapter 11.4 Verification
# Asserts csproj version alignment to 1.0.9 and successful Release build.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir

Write-Host "[INFO] Starting verification: Version alignment and Release build..." -ForegroundColor Cyan

# 1. Parse windows/DeepSeek.csproj and assert <Version> == 1.0.9
$csprojPath = Join-Path $WindowsDir "DeepSeek.csproj"
if (-not (Test-Path $csprojPath)) {
    Write-Error "[FAIL] Project file not found: $csprojPath"
    exit 1
}

Write-Host "[INFO] Parsing project file: $csprojPath"
[xml]$csprojXml = Get-Content -Path $csprojPath -Raw
$versionNode = $csprojXml.SelectSingleNode("//Version")
if (-not $versionNode) {
    Write-Error "[FAIL] <Version> node not found in $csprojPath"
    exit 1
}

$versionValue = $versionNode.InnerText.Trim()
Write-Host "[INFO] Detected version: $versionValue"

if ($versionValue -ne "1.0.9") {
    Write-Error "[FAIL] Version mismatch! Expected: 1.0.9, Actual: $versionValue"
    exit 1
}
Write-Host "[PASS] Version is strictly 1.0.9" -ForegroundColor Green

# 2. Execute dotnet build -c Release and assert exit code == 0
Write-Host "[INFO] Building DeepSeek.csproj with Release configuration..."
dotnet build $csprojPath -c Release
if ($LASTEXITCODE -ne 0) {
    Write-Error "[FAIL] dotnet build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
Write-Host "[PASS] dotnet build -c Release completed successfully." -ForegroundColor Green

Write-Host "[PASS] All version and build verification assertions passed successfully." -ForegroundColor Green
exit 0
