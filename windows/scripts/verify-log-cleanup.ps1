# verify-log-cleanup.ps1 - RFC-0004 Chapter 11.3 Verification
# Asserts desktop legacy debug log cleanup and heartbeat denoising whitelist.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir

Write-Host "[INFO] Starting verification: Legacy log cleanup and heartbeat denoising..." -ForegroundColor Cyan

# 1. Locate DeepSeek.dll
$dllCandidates = @(
    (Join-Path $WindowsDir "bin\Release\net8.0-windows\DeepSeek.dll"),
    (Join-Path $WindowsDir "bin\Debug\net8.0-windows\DeepSeek.dll")
)
$targetDll = $null
foreach ($cand in $dllCandidates) {
    if (Test-Path $cand) {
        $targetDll = $cand
        break
    }
}
if (-not $targetDll) {
    Write-Host "[INFO] Compiling DeepSeek.csproj..."
    dotnet build (Join-Path $WindowsDir "DeepSeek.csproj") -c Release
    $targetDll = Join-Path $WindowsDir "bin\Release\net8.0-windows\DeepSeek.dll"
}
if (-not (Test-Path $targetDll)) {
    Write-Error "[FAIL] Could not locate DeepSeek.dll"
    exit 1
}

$asm = [System.Reflection.Assembly]::LoadFrom($targetDll)
$appType = $asm.GetType("DeepSeek.App")
$cleanupMethod = $appType.GetMethod("CleanupLegacyDesktopLogSafe", [System.Reflection.BindingFlags]"Public,Static")
$logMethod = $appType.GetMethod("Log", [System.Reflection.BindingFlags]"Public,Static")

if (-not $cleanupMethod -or -not $logMethod) {
    Write-Error "[FAIL] App methods CleanupLegacyDesktopLogSafe or Log not found"
    exit 1
}

# 2. Desktop legacy debug log cleanup test
$desktopPath = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory)
$legacyLog = Join-Path $desktopPath "deepseek_debug.log"

Write-Host "[INFO] Creating simulated 55MB legacy log on Desktop: $legacyLog"
$fs = [System.IO.File]::Create($legacyLog)
$fs.SetLength(55 * 1024 * 1024)
$fs.Close()

if (-not (Test-Path $legacyLog)) {
    Write-Error "[FAIL] Failed to create simulated desktop legacy log."
    exit 1
}

Write-Host "[INFO] Invoking CleanupLegacyDesktopLogSafe()..."
$cleanupMethod.Invoke($null, $null)

if (Test-Path $legacyLog) {
    Write-Error "[FAIL] Legacy desktop log still exists after CleanupLegacyDesktopLogSafe: $legacyLog"
    exit 1
}
Write-Host "[PASS] Legacy desktop debug log successfully deleted." -ForegroundColor Green

# 3. Heartbeat denoising whitelist test
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) {
    $localAppData = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
}
$logPath = Join-Path $localAppData "DeepSeek-Agent\logs\deepseek.log"

# Send heartbeat message that should be dropped
$silentHeartbeat = "[read_file] OK: ~/Documents/ObsidianVault/00-Dashboard/Task-State.md"
Write-Host "[INFO] Sending normal heartbeat: $silentHeartbeat"
$logMethod.Invoke($null, @($silentHeartbeat))

if (Test-Path $logPath) {
    $content = Get-Content -Path $logPath -Raw
    if ($content -and $content.Contains($silentHeartbeat)) {
        Write-Error "[FAIL] Normal Task-State.md heartbeat was written to log, expected silent drop."
        exit 1
    }
}
Write-Host "[PASS] Task-State.md heartbeat silently dropped (denoising active)." -ForegroundColor Green

# Send error message that MUST be logged
$errorMsg = "[read_file Error]: Simulated failure reading Task-State.md"
Write-Host "[INFO] Sending error message: $errorMsg"
$logMethod.Invoke($null, @($errorMsg))

if (-not (Test-Path $logPath)) {
    Write-Error "[FAIL] Log file not found after sending error message."
    exit 1
}
$content = Get-Content -Path $logPath -Raw
if (-not $content -or -not $content.Contains($errorMsg)) {
    Write-Error "[FAIL] Error message was not logged to deepseek.log"
    exit 1
}
Write-Host "[PASS] Error message was properly logged to deepseek.log." -ForegroundColor Green

Write-Host "[PASS] All cleanup and heartbeat denoising assertions passed successfully." -ForegroundColor Green
exit 0
