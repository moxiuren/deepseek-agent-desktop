# verify-log-rotation.ps1 - RFC-0004 Chapter 11.2 Verification
# Asserts 5MB log rotation, slice count <= 2 (.log.1, .log.2), and safe handling during file lock.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir

Write-Host "[INFO] Starting verification: Log rotation and file lock safety..." -ForegroundColor Cyan

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
$logMethod = $appType.GetMethod("Log", [System.Reflection.BindingFlags]"Public,Static")
if (-not $logMethod) {
    Write-Error "[FAIL] Could not find DeepSeek.App.Log method"
    exit 1
}

# 2. Setup isolated test log directory
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) {
    $localAppData = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
}
$logDir = Join-Path $localAppData "DeepSeek-Agent\logs"

if (Test-Path $logDir) {
    Get-ChildItem -Path $logDir -Filter "deepseek.log*" | Remove-Item -Force -ErrorAction SilentlyContinue
} else {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

Write-Host "[INFO] Writing ~12MB simulated log data through DeepSeek.App.Log..."
# 64 KB block * 192 = 12 MB
$chunk = "A" * 65536
for ($i = 0; $i -lt 192; $i++) {
    $logMethod.Invoke($null, @("CHUNK-$i $chunk"))
}
Write-Host "[PASS] 12MB log data written without exception." -ForegroundColor Green

# 3. Assertions on generated log slices
$logFile = Join-Path $logDir "deepseek.log"
$log1 = Join-Path $logDir "deepseek.log.1"
$log2 = Join-Path $logDir "deepseek.log.2"
$log3 = Join-Path $logDir "deepseek.log.3"

if (-not (Test-Path $logFile)) {
    Write-Error "[FAIL] Main log file does not exist: $logFile"
    exit 1
}
$logSize = (Get-Item $logFile).Length
$maxAllowed = 5.5 * 1024 * 1024 # 5.5 MB threshold

Write-Host "[INFO] deepseek.log size: $logSize bytes"
if ($logSize -gt $maxAllowed) {
    Write-Error "[FAIL] deepseek.log exceeds 5.5MB: $logSize bytes"
    exit 1
}
Write-Host "[PASS] deepseek.log exists and is within 5.5MB" -ForegroundColor Green

if (-not (Test-Path $log1)) {
    Write-Error "[FAIL] Historical slice deepseek.log.1 does not exist"
    exit 1
}
$log1Size = (Get-Item $log1).Length
Write-Host "[INFO] deepseek.log.1 size: $log1Size bytes"
if ($log1Size -gt $maxAllowed) {
    Write-Error "[FAIL] deepseek.log.1 exceeds 5.5MB: $log1Size bytes"
    exit 1
}
Write-Host "[PASS] deepseek.log.1 exists and is within 5.5MB" -ForegroundColor Green

if (Test-Path $log3) {
    Write-Error "[FAIL] Historical slice deepseek.log.3 exists (max slices should be 2)"
    exit 1
}
Write-Host "[PASS] Historical slice count <= 2 (deepseek.log.3 does not exist)" -ForegroundColor Green

# 4. File Lock Safety Assertion
Write-Host "[INFO] Testing write behavior during exclusive file lock..."
$fileStream = $null
try {
    $fileStream = [System.IO.File]::Open($logFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    # This invocation must NOT throw IOException, should gracefully downgrade
    $logMethod.Invoke($null, @("[TEST] Writing while file is exclusively locked"))
    Write-Host "[PASS] Writing during file lock completed without crash/unhandled exception." -ForegroundColor Green
}
finally {
    if ($fileStream) {
        $fileStream.Close()
        $fileStream.Dispose()
    }
}

Write-Host "[PASS] All log rotation and file lock assertions passed successfully." -ForegroundColor Green
exit 0
