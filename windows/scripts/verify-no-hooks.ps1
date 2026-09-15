# verify-no-hooks.ps1 - RFC-0004 Chapter 11.1 Verification
# Asserts that all global low-level keyboard hook symbols and P/Invoke calls are removed.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir

Write-Host "[INFO] Starting verification: Verify no low-level hooks..." -ForegroundColor Cyan

# 1. Source code static scan on MainWindow.xaml.cs
$sourceFile = Join-Path $WindowsDir "MainWindow.xaml.cs"
if (-not (Test-Path $sourceFile)) {
    Write-Error "[FAIL] Source file not found: $sourceFile"
    exit 1
}

Write-Host "[INFO] Scanning source file: $sourceFile"
$forbiddenSymbols = @(
    "SetWindowsHookEx",
    "LowLevelKeyboardProc",
    "WH_KEYBOARD_LL",
    "_llHookProc"
)

$sourceContent = Get-Content -Path $sourceFile -Raw
$foundInSource = @()

foreach ($sym in $forbiddenSymbols) {
    if ($sourceContent -match [regex]::Escape($sym)) {
        $foundInSource += $sym
    }
}

if ($foundInSource.Count -gt 0) {
    Write-Error "[FAIL] Forbidden hook symbols found in source code: $($foundInSource -join ', ')"
    exit 1
}
Write-Host "[PASS] No forbidden hook symbols found in MainWindow.xaml.cs" -ForegroundColor Green

# 2. Binary symbol scan on compiled DeepSeek.dll
# Ensure build exists or locate DeepSeek.dll
$dllCandidates = @(
    (Join-Path $WindowsDir "bin\x64\Release\net8.0-windows\DeepSeek.dll"),
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
    Write-Host "[INFO] DeepSeek.dll not found, building Release..."
    dotnet build (Join-Path $WindowsDir "DeepSeek.csproj") -c Release
    foreach ($cand in $dllCandidates) {
        if (Test-Path $cand) {
            $targetDll = $cand
            break
        }
    }
}

if (-not $targetDll) {
    Write-Error "[FAIL] Could not locate compiled DeepSeek.dll for symbol inspection."
    exit 1
}

Write-Host "[INFO] Inspecting compiled assembly: $targetDll"
$dllBytes = [System.IO.File]::ReadAllBytes($targetDll)
$dllText = [System.Text.Encoding]::ASCII.GetString($dllBytes)

if ($dllText -match "SetWindowsHookEx") {
    Write-Error "[FAIL] SetWindowsHookEx symbol detected in compiled assembly: $targetDll"
    exit 1
}

Write-Host "[PASS] No SetWindowsHookEx import symbol in DeepSeek.dll" -ForegroundColor Green
Write-Host "[PASS] All hook verification assertions passed successfully." -ForegroundColor Green
exit 0
