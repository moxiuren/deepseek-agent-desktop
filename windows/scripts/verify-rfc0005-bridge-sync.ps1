# verify-rfc0005-bridge-sync.ps1 - RFC-0005 Section 11.1 Verification
# Asserts root and publish agent_bridge.js hash synchronization.

param(
    [switch]$TestOnly = $false
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir

$rootBridge = Join-Path $RepoRoot "agent_bridge.js"
$publishBridge = Join-Path $WindowsDir "publish\agent_bridge.js"

Write-Host "[INFO] Starting verification: agent_bridge.js single-source publish sync..." -ForegroundColor Cyan

if (-not (Test-Path $rootBridge)) {
    Write-Error "[FAIL] Root agent_bridge.js not found at $rootBridge"
    exit 1
}

# 时序前置断言保护 (RFC-0005 Section 11.1)
if (-not (Test-Path $publishBridge)) {
    if ($TestOnly) {
        Write-Host "[SKIP] publish\agent_bridge.js does not exist in -TestOnly mode (pre-build phase). Safe bypass." -ForegroundColor Yellow
        exit 0
    } else {
        Write-Error "[FAIL] publish\agent_bridge.js does not exist! Pipeline failed to copy it."
        exit 1
    }
}

$rootHash = (Get-FileHash -Path $rootBridge -Algorithm MD5).Hash
$publishHash = (Get-FileHash -Path $publishBridge -Algorithm MD5).Hash

Write-Host "[INFO] Root MD5:    $rootHash"
Write-Host "[INFO] Publish MD5: $publishHash"

if ($rootHash -ne $publishHash) {
    Write-Error "[FAIL] Hash mismatch between root and publish agent_bridge.js!"
    exit 1
}

Write-Host "[PASS] Root and publish agent_bridge.js hashes match 100%." -ForegroundColor Green
exit 0
