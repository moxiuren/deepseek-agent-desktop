# GatekeeperVerification.ps1
# RFC-0004 Gatekeeper Independent Verification Suite
# Strict assertions on contracts, security, log rotation, heartbeat denoising, legacy cleanup, and versioning.

$ErrorActionPreference = "Stop"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  RFC-0004 GATEKEEPER INDEPENDENT VERIFICATION SUITE" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Traverse up from tests/rfcs/rfc-0004/gatekeeper to repo root
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..\..\..")
$WindowsDir = Join-Path $RepoRoot "windows"
$CsprojPath = Join-Path $WindowsDir "DeepSeek.csproj"
$MainWindowPath = Join-Path $WindowsDir "MainWindow.xaml.cs"
$AppPath = Join-Path $WindowsDir "App.xaml.cs"

$TotalAssertions = 0
$PassedAssertions = 0
$FailedAssertions = 0

function Assert-Condition {
    param(
        [string]$Name,
        [bool]$Condition,
        [string]$FailMessage = ""
    )
    $script:TotalAssertions++
    if ($Condition) {
        $script:PassedAssertions++
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    } else {
        $script:FailedAssertions++
        Write-Host "  [FAIL] $($Name): $FailMessage" -ForegroundColor Red
        throw "[GATEKEEPER FAILURE] $($Name): $FailMessage"
    }
}

try {
    # -------------------------------------------------------------
    # SECTION 1: Static Contract & Anti-Regression Verification
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 1] Static Contract & Anti-Regression Auditing" -ForegroundColor Yellow

    # GK-1.1: Verify complete removal of WH_KEYBOARD_LL & hook symbols
    $mwContent = Get-Content -Path $MainWindowPath -Raw
    $forbiddenSymbols = @("SetWindowsHookEx", "UnhookWindowsHookEx", "CallNextHookEx", "LowLevelKeyboardProc", "WH_KEYBOARD_LL", "_llHookProc", "_llHookId")
    $foundForbidden = @()
    foreach ($sym in $forbiddenSymbols) {
        if ($mwContent -match [regex]::Escape($sym)) {
            $foundForbidden += $sym
        }
    }
    Assert-Condition -Name "GK-1.1: Zero low-level keyboard hook symbols in MainWindow.xaml.cs" `
        -Condition ($foundForbidden.Count -eq 0) `
        -FailMessage "Found forbidden symbols: $($foundForbidden -join ', ')"

    # GK-1.2: Verify native accelerator and Win32 debounce contract
    $hasGetAsyncKeyState = $mwContent.Contains("GetAsyncKeyState")
    $hasDebounce = $mwContent.Contains("HotkeyDebounceTicks")
    $hasHandledTrue = $mwContent.Contains("args.Handled = true")
    Assert-Condition -Name "GK-1.2: Native accelerator key debounce and Handled=true contract" `
        -Condition ($hasGetAsyncKeyState -and $hasDebounce -and $hasHandledTrue) `
        -FailMessage "Missing GetAsyncKeyState ($hasGetAsyncKeyState), HotkeyDebounceTicks ($hasDebounce), or args.Handled ($hasHandledTrue)"

    # GK-1.3: Verify App.xaml.cs logging architecture contract
    $appContent = Get-Content -Path $AppPath -Raw
    $hasLogLock = $appContent.Contains("_logLock")
    $hasMaxLogSize = $appContent.Contains("MaxLogSizeBytes = 5 * 1024 * 1024")
    $hasApproxCounter = $appContent.Contains("_approximateLogSizeBytes")
    $hasRotateProc = $appContent.Contains("RotateLogsSafe")
    $hasCleanupProc = $appContent.Contains("CleanupLegacyDesktopLogSafe")
    $hasHeartbeatFilter = $appContent.Contains("[read_file] OK:") -and $appContent.Contains("Task-State.md")
    Assert-Condition -Name "GK-1.3: Safe rotating log, denoising and cleanup contract in App.xaml.cs" `
        -Condition ($hasLogLock -and $hasMaxLogSize -and $hasApproxCounter -and $hasRotateProc -and $hasCleanupProc -and $hasHeartbeatFilter) `
        -FailMessage "App.xaml.cs does not implement required logging and cleanup contract"

    # GK-1.4: Verify csproj Version alignment to 1.0.8
    [xml]$csprojXml = Get-Content -Path $CsprojPath -Raw
    $versionNode = $csprojXml.SelectSingleNode("//Version")
    $version = if ($versionNode) { $versionNode.InnerText.Trim() } else { "" }
    Assert-Condition -Name "GK-1.4: Project Version strictly aligned to 1.0.8" `
        -Condition ([version]$version -ge [version]"1.0.8") `
        -FailMessage "Expected 1.0.8, found '$version'"

    # -------------------------------------------------------------
    # SECTION 2: Build & Binary Inspection
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 2] Release Compilation & Assembly Security Auditing" -ForegroundColor Yellow

    Write-Host "  [INFO] Compiling DeepSeek.csproj with Release configuration..."
    $buildOutput = dotnet build $CsprojPath -c Release 2>&1
    Assert-Condition -Name "GK-2.1: dotnet build -c Release succeeds with exit code 0" `
        -Condition ($LASTEXITCODE -eq 0) `
        -FailMessage ($buildOutput -join "`n")

    # Locate DeepSeek.dll
    $dllPath = Join-Path $WindowsDir "bin\Release\net8.0-windows\DeepSeek.dll"
    if (-not (Test-Path $dllPath)) {
        $dllPath = Join-Path $WindowsDir "bin\x64\Release\net8.0-windows\DeepSeek.dll"
    }
    Assert-Condition -Name "GK-2.2: Compiled assembly DeepSeek.dll exists" `
        -Condition (Test-Path $dllPath) `
        -FailMessage "Path not found: $dllPath"

    # Assembly binary inspection: ensure no SetWindowsHookEx import symbol
    $dllBytes = [System.IO.File]::ReadAllBytes($dllPath)
    $dllAscii = [System.Text.Encoding]::ASCII.GetString($dllBytes)
    $hasHookImport = $dllAscii -match "SetWindowsHookEx"
    Assert-Condition -Name "GK-2.3: Zero SetWindowsHookEx import symbol in DeepSeek.dll" `
        -Condition (-not $hasHookImport) `
        -FailMessage "SetWindowsHookEx symbol detected in compiled binary"

    # Assembly metadata version inspection
    $assemblyDef = [System.Reflection.Assembly]::LoadFrom($dllPath)
    $asmVer = $assemblyDef.GetName().Version.ToString(3)
    Assert-Condition -Name "GK-2.4: Binary AssemblyVersion aligns with 1.0.8" `
        -Condition ([version]$asmVer -ge [version]"1.0.8") `
        -FailMessage "Compiled assembly version is $asmVer, expected 1.0.8"

    # -------------------------------------------------------------
    # SECTION 3: Dynamic Log Rotation & Concurrency / Lock Stress
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 3] Dynamic Log Rotation & Exclusive Lock Safety" -ForegroundColor Yellow

    $appType = $assemblyDef.GetType("DeepSeek.App")
    $logMethod = $appType.GetMethod("Log", [System.Reflection.BindingFlags]"Public,Static")
    Assert-Condition -Name "GK-3.1: DeepSeek.App.Log reflection entrypoint available" `
        -Condition ($logMethod -ne $null) `
        -FailMessage "Method DeepSeek.App.Log not found"

    $localAppData = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
    $logDir = Join-Path $localAppData "DeepSeek-Agent\logs"
    $mainLog = Join-Path $logDir "deepseek.log"
    $log1 = Join-Path $logDir "deepseek.log.1"
    $log2 = Join-Path $logDir "deepseek.log.2"
    $log3 = Join-Path $logDir "deepseek.log.3"

    # Reset logs for isolated test
    if (Test-Path $logDir) {
        Get-ChildItem -Path $logDir -Filter "deepseek.log*" | Remove-Item -Force -ErrorAction SilentlyContinue
    }

    # Stress write 15MB log data (60KB x 256)
    Write-Host "  [INFO] Generating ~15MB log volume to trigger multi-phase rotation..."
    $chunk = "B" * 61440
    for ($i = 0; $i -lt 256; $i++) {
        $logMethod.Invoke($null, @("GATEKEEPER-STRESS-$i $chunk"))
    }

    $mainSize = if (Test-Path $mainLog) { (Get-Item $mainLog).Length } else { -1 }
    $log1Size = if (Test-Path $log1) { (Get-Item $log1).Length } else { -1 }
    $log2Size = if (Test-Path $log2) { (Get-Item $log2).Length } else { -1 }
    $hasLog3 = Test-Path $log3

    $maxBoundary = 5.5 * 1024 * 1024 # 5.5MB

    Assert-Condition -Name "GK-3.2: deepseek.log within 5.5MB limit ($mainSize bytes)" `
        -Condition ($mainSize -gt 0 -and $mainSize -le $maxBoundary) `
        -FailMessage "deepseek.log size $mainSize exceeds $maxBoundary or is 0"

    Assert-Condition -Name "GK-3.3: deepseek.log.1 rotated and within 5.5MB limit ($log1Size bytes)" `
        -Condition ($log1Size -gt 0 -and $log1Size -le $maxBoundary) `
        -FailMessage "deepseek.log.1 size $log1Size exceeds $maxBoundary or is missing"

    Assert-Condition -Name "GK-3.4: deepseek.log.2 rotated and within 5.5MB limit ($log2Size bytes)" `
        -Condition ($log2Size -gt 0 -and $log2Size -le $maxBoundary) `
        -FailMessage "deepseek.log.2 size $log2Size exceeds $maxBoundary or is missing"

    Assert-Condition -Name "GK-3.5: Maximum 2 historical slices enforced (deepseek.log.3 must NOT exist)" `
        -Condition (-not $hasLog3) `
        -FailMessage "deepseek.log.3 found! Slice count exceeds limit."

    # Exclusive lock test
    Write-Host "  [INFO] Verifying graceful degradation under exclusive file lock..."
    $lockedStream = [System.IO.File]::Open($mainLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        $logMethod.Invoke($null, @("[GATEKEEPER-LOCK-TEST] Should not throw"))
        Assert-Condition -Name "GK-3.6: Writing to exclusively locked log does not throw unhandled exception" `
            -Condition $true
    } catch {
        Assert-Condition -Name "GK-3.6: Writing to exclusively locked log does not throw unhandled exception" `
            -Condition $false `
            -FailMessage "Threw exception: $_"
    } finally {
        $lockedStream.Close()
        $lockedStream.Dispose()
    }

    # -------------------------------------------------------------
    # SECTION 4: Heartbeat Denoising & Target Filtering
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 4] Heartbeat Denoising & Whitelist Verification" -ForegroundColor Yellow

    # Test 4.1: Normal heartbeat silently dropped
    $heartbeatTaskState = "[read_file] OK: ~/Documents/ObsidianVault/00-Dashboard/Task-State.md"
    $logMethod.Invoke($null, @($heartbeatTaskState))
    $logContent = [System.IO.File]::ReadAllText($mainLog)
    $dropped = -not $logContent.Contains($heartbeatTaskState)
    Assert-Condition -Name "GK-4.1: Task-State.md normal heartbeat silently dropped" `
        -Condition $dropped `
        -FailMessage "Heartbeat was written to log file instead of being dropped"

    # Test 4.2: Error on Task-State.md MUST be logged
    $errorTaskState = "[read_file Error]: Failed to read Task-State.md: FileNotFound"
    $logMethod.Invoke($null, @($errorTaskState))
    $logContent = [System.IO.File]::ReadAllText($mainLog)
    $errorLogged = $logContent.Contains($errorTaskState)
    Assert-Condition -Name "GK-4.2: Task-State.md error message preserved in log" `
        -Condition $errorLogged `
        -FailMessage "Error message was erroneously dropped"

    # Test 4.3: Read on other files MUST be logged (no blanket suppression)
    $otherRead = "[read_file] OK: ~/Documents/OtherNotes/Project.md"
    $logMethod.Invoke($null, @($otherRead))
    $logContent = [System.IO.File]::ReadAllText($mainLog)
    $otherLogged = $logContent.Contains($otherRead)
    Assert-Condition -Name "GK-4.3: Non-Task-State read_file events preserved in log" `
        -Condition $otherLogged `
        -FailMessage "Legitimate non-heartbeat read_file log was improperly suppressed"

    # -------------------------------------------------------------
    # SECTION 5: Startup Legacy Desktop Log Cleanup
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 5] Startup Legacy Desktop Log Cleanup" -ForegroundColor Yellow

    $cleanupMethod = $appType.GetMethod("CleanupLegacyDesktopLogSafe", [System.Reflection.BindingFlags]"Public,Static")
    Assert-Condition -Name "GK-5.1: DeepSeek.App.CleanupLegacyDesktopLogSafe reflection entrypoint available" `
        -Condition ($cleanupMethod -ne $null) `
        -FailMessage "Method DeepSeek.App.CleanupLegacyDesktopLogSafe not found"

    $desktopPath = [Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory)
    $legacyLog = Join-Path $desktopPath "deepseek_debug.log"

    # Create dummy 56MB desktop file
    $fs = [System.IO.File]::Create($legacyLog)
    $fs.SetLength(56 * 1024 * 1024)
    $fs.Close()

    $cleanupMethod.Invoke($null, $null)
    $desktopCleaned = -not (Test-Path $legacyLog)
    Assert-Condition -Name "GK-5.2: Legacy 56MB desktop debug log safely deleted" `
        -Condition $desktopCleaned `
        -FailMessage "Desktop log still exists after CleanupLegacyDesktopLogSafe execution"

    # Test file lock resilience during cleanup
    $dummyOccupied = [System.IO.File]::Create($legacyLog)
    $dummyOccupied.SetLength(1024)
    try {
        # While occupied, invoking cleanup should not throw
        $cleanupMethod.Invoke($null, $null)
        Assert-Condition -Name "GK-5.3: Occupied legacy desktop log cleanup does not throw exception" `
            -Condition $true
    } catch {
        Assert-Condition -Name "GK-5.3: Occupied legacy desktop log cleanup does not throw exception" `
            -Condition $false `
            -FailMessage "Threw exception during occupied cleanup: $_"
    } finally {
        $dummyOccupied.Close()
        $dummyOccupied.Dispose()
        if (Test-Path $legacyLog) {
            Remove-Item -Path $legacyLog -Force -ErrorAction SilentlyContinue
        }
    }

    # -------------------------------------------------------------
    # SECTION 6: Builder Self-Test Suite Invocation
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 6] Builder Automated Verification Suite Regression Run" -ForegroundColor Yellow

    $builderBuildScript = Join-Path $WindowsDir "build.ps1"
    Write-Host "  [INFO] Invoking builder verification suite: pwsh -NoProfile -File windows/build.ps1 -TestOnly"
    $builderTestOutput = & pwsh -NoProfile -File $builderBuildScript -TestOnly 2>&1
    Assert-Condition -Name "GK-6.1: Builder verification suite runs and passes with exit code 0" `
        -Condition ($LASTEXITCODE -eq 0) `
        -FailMessage ($builderTestOutput -join "`n")

    # -------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "  [GATEKEEPER-PASS] ALL $PassedAssertions/$TotalAssertions INDEPENDENT ASSERTIONS PASSED" -ForegroundColor Green
    Write-Host "  Gate 2 Quality & Security Verification: APPROVED" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
    exit 0

} catch {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "  [GATEKEEPER-FAIL] GATEKEEPER VERIFICATION ABORTED" -ForegroundColor Red
    Write-Host "  Passed: $PassedAssertions, Failed: $FailedAssertions, Total: $TotalAssertions" -ForegroundColor Red
    Write-Host "  Failure Details: $_" -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    exit 1
}
