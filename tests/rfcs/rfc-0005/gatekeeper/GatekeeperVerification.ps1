# GatekeeperVerification.ps1
# RFC-0005 Gatekeeper Independent Verification Suite
# Strict assertions on contracts, OWASP security, TerminalOutputRouter, DynamicThrottle, and pipeline sync.

$ErrorActionPreference = "Stop"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  RFC-0005 GATEKEEPER INDEPENDENT VERIFICATION SUITE" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Traverse up from tests/rfcs/rfc-0005/gatekeeper to repo root
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..\..\..")
$WindowsDir = Join-Path $RepoRoot "windows"
$CsprojPath = Join-Path $WindowsDir "DeepSeek.csproj"
$MainWindowPath = Join-Path $WindowsDir "MainWindow.xaml.cs"
$RouterPath = Join-Path $WindowsDir "TerminalOutputRouter.cs"
$BridgeJsPath = Join-Path $RepoRoot "agent_bridge.js"
$PublishBridgePath = Join-Path $WindowsDir "publish\agent_bridge.js"

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
    # SECTION 1: Static Contract & Architectural Auditing
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 1] Static Contract & Architectural Auditing" -ForegroundColor Yellow

    # GK-1.1: TerminalOutputRouter.cs exists and defines constants
    Assert-Condition -Name "GK-1.1: TerminalOutputRouter.cs exists" `
        -Condition (Test-Path $RouterPath) `
        -FailMessage "TerminalOutputRouter.cs not found at $RouterPath"

    $routerContent = Get-Content -Path $RouterPath -Raw
    $hasMaxDirect = $routerContent.Contains("MaxDirectTextLength = 16000")
    $hasHeadKeep = $routerContent.Contains("HeadKeepChars = 7500")
    $hasTailKeep = $routerContent.Contains("TailKeepChars = 7500")
    $hasMaxUpload = $routerContent.Contains("MaxUploadBytes = 5 * 1024 * 1024")
    Assert-Condition -Name "GK-1.2: TerminalOutputRouter defines mandatory constants (16000, 7500, 7500, 5MB)" `
        -Condition ($hasMaxDirect -and $hasHeadKeep -and $hasTailKeep -and $hasMaxUpload) `
        -FailMessage "Missing one or more required constants in TerminalOutputRouter.cs"

    # GK-1.3: TerminalOutputRouter method signatures
    $hasRoute = $routerContent.Contains("public static RoutingResult Route(")
    $hasOversizedText = $routerContent.Contains("HandleOversizedText(")
    $hasOversizedFile = $routerContent.Contains("HandleOversizedFile(")
    $hasIsTextExt = $routerContent.Contains("IsTextExtension(")
    $hasGetMime = $routerContent.Contains("GetMimeType(")
    Assert-Condition -Name "GK-1.3: TerminalOutputRouter exposes required static routing API" `
        -Condition ($hasRoute -and $hasOversizedText -and $hasOversizedFile -and $hasIsTextExt -and $hasGetMime) `
        -FailMessage "Missing required routing methods in TerminalOutputRouter.cs"

    # GK-1.4: MainWindow.xaml.cs wires TerminalOutputRouter.Route, hostMs, attach_failed
    $mwContent = Get-Content -Path $MainWindowPath -Raw
    $hasRouterCall = $mwContent.Contains("TerminalOutputRouter.Route(")
    $hasHostMs = $mwContent.Contains("hostMs = hostMs")
    $hasAttachFailed = $mwContent.Contains('action == "attach_failed"') -or $mwContent.Contains('case "attach_failed":')
    Assert-Condition -Name "GK-1.4: MainWindow.xaml.cs integrates TerminalOutputRouter, hostMs, and attach_failed" `
        -Condition ($hasRouterCall -and $hasHostMs -and $hasAttachFailed) `
        -FailMessage "MainWindow.xaml.cs missing router integration, hostMs IPC dispatch, or attach_failed listener"

    # GK-1.5: agent_bridge.js implements DynamicThrottle with performance.now() and unified queueFeedbackSlot
    $bridgeContent = Get-Content -Path $BridgeJsPath -Raw
    $hasDynamicThrottle = $bridgeContent.Contains("const DynamicThrottle =")
    $hasPerfNow = $bridgeContent.Contains("performance.now()")
    $hasUnifiedSlot = $bridgeContent.Contains("function queueFeedbackSlot(")
    $hasNoMinSendGap = -not $bridgeContent.Contains("MIN_SEND_GAP_MS = 8000")
    Assert-Condition -Name "GK-1.5: agent_bridge.js adopts DynamicThrottle with monotonic clock and removes MIN_SEND_GAP_MS=8000" `
        -Condition ($hasDynamicThrottle -and $hasPerfNow -and $hasUnifiedSlot -and $hasNoMinSendGap) `
        -FailMessage "agent_bridge.js lacks DynamicThrottle, monotonic clock, or still contains MIN_SEND_GAP_MS=8000"

    # GK-1.6: waitForAttachmentReady signature and return object contract, DirectSend sync & streamBuf cleanup
    $hasWaitForAttach = $bridgeContent.Contains("function waitForAttachmentReady(")
    $hasAttachReturnObj = $bridgeContent.Contains("timedOut:") -and $bridgeContent.Contains("ok:")
    $hasDirectSendSync = $bridgeContent.Contains("syncDirectSendSuccess")
    $hasStreamBufCleanup = $bridgeContent.Contains("120000") -and $bridgeContent.Contains("60000")
    Assert-Condition -Name "GK-1.6: waitForAttachmentReady object return, DirectSend sync, and streamBuf lazy cleanup verified" `
        -Condition ($hasWaitForAttach -and $hasAttachReturnObj -and $hasDirectSendSync -and $hasStreamBufCleanup) `
        -FailMessage "agent_bridge.js missing attachment ready contract, DirectSend clock sync, or 60s streamBuf lazy cleaner"

    # -------------------------------------------------------------
    # SECTION 2: OWASP Security & Safe Memory Auditing
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 2] OWASP Security & Safe Memory Auditing" -ForegroundColor Yellow

    # GK-2.1: Credential and secret scanning
    $sensitivePatterns = @(
        'sk-[a-zA-Z0-9]{20,}',
        'api[_-]?key\s*[:=]\s*["''][^"'']+["'']',
        'secret\s*[:=]\s*["''][^"'']+["'']',
        'password\s*[:=]\s*["''][^"'']+["'']'
    )
    $foundSecrets = @()
    foreach ($p in $sensitivePatterns) {
        if ($routerContent -match $p) { $foundSecrets += "TerminalOutputRouter: $p" }
        if ($bridgeContent -match $p) { $foundSecrets += "agent_bridge: $p" }
    }
    Assert-Condition -Name "GK-2.1: Zero hardcoded API keys, tokens, or credentials in touched files" `
        -Condition ($foundSecrets.Count -eq 0) `
        -FailMessage "Potential sensitive credential pattern matched: $($foundSecrets -join ', ')"

    # GK-2.2: Pre-read 5MB length guard against OOM in TerminalOutputRouter
    $hasFileInfoGuard = $routerContent.Contains("fileInfo.Length <= MaxUploadBytes")
    $hasNoBlindReadAllBytes = -not ($routerContent -match 'ReadAllBytes(Async)?\([^)]+\)\s*;\s*if\s*\([^)]*Length\s*<=\s*MaxUploadBytes')
    Assert-Condition -Name "GK-2.2: Strict FileInfo.Length <= MaxUploadBytes pre-guard before ReadAllBytes" `
        -Condition ($hasFileInfoGuard -and $hasNoBlindReadAllBytes) `
        -FailMessage "TerminalOutputRouter does not guard file size before ReadAllBytes"

    # GK-2.3: Binary file protection (no ReadAllText on binary files)
    $hasBinaryCheck = $routerContent.Contains("IsTextExtension(ext)") -and $routerContent.Contains("无法作为文本展开")
    Assert-Condition -Name "GK-2.3: Binary files intercepted with metadata prompt, rejecting blind ReadAllText" `
        -Condition ($hasBinaryCheck) `
        -FailMessage "Binary file protection logic missing from TerminalOutputRouter"

    # GK-2.4: Math truncation and collision-resistant path generation
    $hasStrictTruncationMath = $routerContent.Contains("output.Length - (HeadKeepChars + TailKeepChars)")
    $hasGuidCollisionGuard = $routerContent.Contains("agent_output_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}.txt")
    Assert-Condition -Name "GK-2.4: Truncation math exactitude and GUID-guarded cache path generation" `
        -Condition ($hasStrictTruncationMath -and $hasGuidCollisionGuard) `
        -FailMessage "Truncation formula or GUID collision guard is incorrect"

    # -------------------------------------------------------------
    # SECTION 3: Compilation & 0 Warning 0 Error Quality Check
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 3] Compilation & Zero Warning Quality Auditing" -ForegroundColor Yellow

    Write-Host "  [INFO] Compiling DeepSeek.csproj with Release configuration..."
    $buildOutput = dotnet build $CsprojPath -c Release 2>&1
    $buildSuccess = ($LASTEXITCODE -eq 0)
    $outString = $buildOutput -join "`n"
    $hasZeroWarnings = $outString.Contains("0 Warning(s)")
    $hasZeroErrors = $outString.Contains("0 Error(s)")

    Assert-Condition -Name "GK-3.1: dotnet build -c Release succeeds with 0 Warning(s) and 0 Error(s)" `
        -Condition ($buildSuccess -and $hasZeroWarnings -and $hasZeroErrors) `
        -FailMessage "Build output contained warnings or errors:`n$outString"

    # Verify compiled assembly exists and has TerminalOutputRouter type
    $dllPath = Join-Path $WindowsDir "bin\Release\net8.0-windows\DeepSeek.dll"
    if (-not (Test-Path $dllPath)) {
        $dllPath = Join-Path $WindowsDir "bin\x64\Release\net8.0-windows\DeepSeek.dll"
    }
    Assert-Condition -Name "GK-3.2: Compiled DeepSeek.dll exists" `
        -Condition (Test-Path $dllPath) `
        -FailMessage "DeepSeek.dll not found at $dllPath"

    $assemblyDef = [System.Reflection.Assembly]::LoadFrom($dllPath)
    $routerType = $assemblyDef.GetType("DeepSeek.TerminalOutputRouter")
    Assert-Condition -Name "GK-3.3: DeepSeek.TerminalOutputRouter type exported in compiled assembly" `
        -Condition ($routerType -ne $null) `
        -FailMessage "Type DeepSeek.TerminalOutputRouter missing from assembly"

    # -------------------------------------------------------------
    # SECTION 4: TerminalOutputRouter Dynamic Assertions & Edge Cases
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 4] TerminalOutputRouter Dynamic Assertions & Edge Cases" -ForegroundColor Yellow

    $tempTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gk_test_" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tempTestDir -Force | Out-Null

    try {
        # GK-4.1: Empty or whitespace text edge case
        $emptyRes = [DeepSeek.TerminalOutputRouter]::Route("   ", $tempTestDir)
        Assert-Condition -Name "GK-4.1: Whitespace output returns placeholder with IsAttachment=false" `
            -Condition (-not $emptyRes.IsAttachment -and $emptyRes.OutputText -eq "(命令执行完毕，无终端文字输出)") `
            -FailMessage "Empty text did not return expected placeholder: $($emptyRes.OutputText)"

        # GK-4.2: Direct text routing under 16,000 characters
        $text10k = "K" * 10000
        $res10k = [DeepSeek.TerminalOutputRouter]::Route($text10k, $tempTestDir)
        Assert-Condition -Name "GK-4.2: 10,000 chars routed directly without attachment or disk spill" `
            -Condition (-not $res10k.IsAttachment -and $res10k.OutputText.Length -eq 10000 -and [string]::IsNullOrEmpty($res10k.LocalOversizedPath)) `
            -FailMessage "10k text was incorrectly altered or saved"

        # GK-4.3: Oversized text truncation and persistence (20,000 chars)
        $headPart = "H" * 7500
        $midPart = "M" * 5000
        $tailPart = "T" * 7500
        $text20k = $headPart + $midPart + $tailPart
        $res20k = [DeepSeek.TerminalOutputRouter]::Route($text20k, $tempTestDir)

        $persistedOk = (-not [string]::IsNullOrEmpty($res20k.LocalOversizedPath)) -and (Test-Path $res20k.LocalOversizedPath)
        $persistedContent = if ($persistedOk) { [System.IO.File]::ReadAllText($res20k.LocalOversizedPath, [System.Text.Encoding]::UTF8) } else { "" }
        $headPreserved = $res20k.OutputText.StartsWith($headPart)
        $tailPreserved = $res20k.OutputText.EndsWith($tailPart)
        $lengthWithinLimit = $res20k.OutputText.Length -le 16000

        Assert-Condition -Name "GK-4.3: 20,000 chars truncated to <=16,000 chars (Head 7500 + Tail 7500 preserved, persisted file intact)" `
            -Condition (-not $res20k.IsAttachment -and $lengthWithinLimit -and $headPreserved -and $tailPreserved -and ($persistedContent.Length -eq 20000)) `
            -FailMessage "Truncation mathematics or disk persistence failed"

        # GK-4.4: 10MB binary file guard against OOM
        $bin10mb = Join-Path $tempTestDir "dummy_large.bin"
        $fs = [System.IO.File]::Create($bin10mb)
        $fs.SetLength(10 * 1024 * 1024)
        $fs.Close()

        $cmdAttach10mb = "Command done. [[AGENT_ATTACH_FILE:${bin10mb}:请分析]]"
        $resBin = [DeepSeek.TerminalOutputRouter]::Route($cmdAttach10mb, $tempTestDir)
        Assert-Condition -Name "GK-4.4: 10MB binary attachment intercepted without OOM, IsAttachment=false with rejection prompt" `
            -Condition (-not $resBin.IsAttachment -and $resBin.OutputText.Contains("二进制类型 [.bin]，无法作为文本展开")) `
            -FailMessage "10MB binary file was not properly intercepted"

        # GK-4.5: 1MB image file valid attachment with Base64 encoding
        $png1mb = Join-Path $tempTestDir "valid_diagram.png"
        $pngBytes = [byte[]]::new(1024 * 1024)
        for ($i = 0; $i -lt $pngBytes.Length; $i++) { $pngBytes[$i] = [byte]($i % 256) }
        [System.IO.File]::WriteAllBytes($png1mb, $pngBytes)

        $cmdAttachPng = "[[AGENT_ATTACH_FILE:${png1mb}:示意图]]"
        $resPng = [DeepSeek.TerminalOutputRouter]::Route($cmdAttachPng, $tempTestDir)
        $expectedBase64 = [Convert]::ToBase64String($pngBytes)
        Assert-Condition -Name "GK-4.5: 1MB PNG correctly parsed as attachment with exact Base64 and image/png MIME" `
            -Condition ($resPng.IsAttachment -and ($resPng.MimeType -eq "image/png") -and ($resPng.Base64Data -eq $expectedBase64) -and ($resPng.Filename -eq "valid_diagram.png")) `
            -FailMessage "1MB PNG attachment routing or Base64 data mismatch"

        # GK-4.6: Windows drive letter colon and parameter prompt separation
        $dummyTextFile = Join-Path $tempTestDir "test_info.txt"
        [System.IO.File]::WriteAllText($dummyTextFile, "Sample content", [System.Text.Encoding]::UTF8)
        $cmdDriveColon = "[[AGENT_ATTACH_FILE:${dummyTextFile}:Custom Prompt]]"
        $resColon = [DeepSeek.TerminalOutputRouter]::Route($cmdDriveColon, $tempTestDir)
        Assert-Condition -Name "GK-4.6: Windows drive letter colon disambiguated from prompt parameter colon" `
            -Condition ($resColon.IsAttachment -and ($resColon.Prompt -eq "Custom Prompt") -and ($resColon.Filename -eq "test_info.txt")) `
            -FailMessage "Drive letter colon misinterpreted: Prompt='$($resColon.Prompt)', Filename='$($resColon.Filename)'"
    }
    finally {
        if (Test-Path $tempTestDir) {
            Remove-Item -Path $tempTestDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # -------------------------------------------------------------
    # SECTION 5: DynamicThrottle Node.js Sandbox Assertions
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 5] DynamicThrottle Monotonic Clock & Algorithm Assertions" -ForegroundColor Yellow

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    Assert-Condition -Name "GK-5.1: Node.js runtime available for dynamic testing" `
        -Condition ($nodeCmd -ne $null) `
        -FailMessage "Node.js executable not found in PATH"

    $gatekeeperNodeScript = @'
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const bridgePath = process.argv[2];
const content = fs.readFileSync(bridgePath, 'utf8');

const startIdx = content.indexOf('const DynamicThrottle = {');
assert(startIdx !== -1, 'DynamicThrottle declaration not found');

let openBraces = 0, endIdx = -1, started = false;
for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') { openBraces++; started = true; }
    else if (content[i] === '}') {
        openBraces--;
        if (started && openBraces === 0) { endIdx = i + 1; break; }
    }
}
assert(endIdx !== -1, 'DynamicThrottle end brace not found');
const dtCode = content.slice(startIdx, endIdx);

const context = {
    performance: performance,
    console: console,
    Math: Math,
    Date: Date,
    rateLimitBackoffUntil: 0,
    result: null
};
vm.createContext(context);
vm.runInContext(dtCode + ';\nresult = DynamicThrottle;', context);
const DynamicThrottle = context.result;

// 1. Cold start: lastSendMono = 0
DynamicThrottle.lastSendMono = 0;
DynamicThrottle.recentSends = [];
const r1 = DynamicThrottle.evaluate({ cardId: 'c1', isAttachment: false, hostMs: 0 });
assert.strictEqual(r1.remainingWaitMs, 0, 'Cold start wait must be 0');

// 2. Host offset: hostMs = 3000 offset with base text 1500
DynamicThrottle.recordSendCommit(performance.now());
const r2 = DynamicThrottle.evaluate({ cardId: 'c2', isAttachment: false, hostMs: 3000 });
assert.strictEqual(r2.remainingWaitMs, 0, 'Host offset must reduce wait to 0');

// 3. Burst penalty tiers: 2 sends => +1000ms, 3 sends => +2500ms
const t = performance.now();
DynamicThrottle.recentSends = [t, t + 1];
const r3_2 = DynamicThrottle.evaluate({ cardId: 'c3', isAttachment: false, hostMs: 0 });
assert.strictEqual(r3_2.burstCount, 2, 'Burst count must be 2');
assert(r3_2.targetGap >= 2500, 'Target gap with 2 bursts must be >= 2500ms');

DynamicThrottle.recentSends = [t, t + 1, t + 2];
const r3_3 = DynamicThrottle.evaluate({ cardId: 'c4', isAttachment: false, hostMs: 0 });
assert.strictEqual(r3_3.burstCount, 3, 'Burst count must be 3');
assert(r3_3.targetGap >= 4000, 'Target gap with 3 bursts must be >= 4000ms (1500+2500)');

// 4. Clock skew backward defense
DynamicThrottle.lastSendMono = performance.now() + 500000;
const r4 = DynamicThrottle.evaluate({ cardId: 'c5', isAttachment: false, hostMs: -100 });
assert(r4.remainingWaitMs >= 0 && !isNaN(r4.remainingWaitMs), 'Wait must be non-negative valid number');

// 5. Sliding window clean: entries older than 10,000ms must be discarded
const now = performance.now();
DynamicThrottle.recentSends = [now - 15000, now - 11000, now - 5000];
DynamicThrottle.clean(now);
assert.strictEqual(DynamicThrottle.recentSends.length, 1, 'Only entries within 10,000ms should remain');

// 6. DirectSend sync integration
DynamicThrottle.lastSendMono = 0;
DynamicThrottle.recentSends = [];
DynamicThrottle.syncDirectSendSuccess();
assert(DynamicThrottle.lastSendMono > 0, 'syncDirectSendSuccess must update lastSendMono');
assert.strictEqual(DynamicThrottle.recentSends.length, 1, 'syncDirectSendSuccess must record send commit');

console.log('[NODE-PASS] All DynamicThrottle assertions passed successfully.');
'@

    $gkTempJs = [System.IO.Path]::GetTempFileName() + ".js"
    [System.IO.File]::WriteAllText($gkTempJs, $gatekeeperNodeScript, [System.Text.Encoding]::UTF8)
    try {
        $nodeOut = & node $gkTempJs $BridgeJsPath 2>&1
        $nodeExit = $LASTEXITCODE
        $nodePassed = ($nodeExit -eq 0) -and ($nodeOut -match 'NODE-PASS')
        Assert-Condition -Name "GK-5.2: DynamicThrottle sandbox execution (cold start, host offset, burst tiers, clock skew, window clean, DirectSend sync)" `
            -Condition $nodePassed `
            -FailMessage ($nodeOut -join "`n")
    }
    finally {
        if (Test-Path $gkTempJs) {
            Remove-Item -Path $gkTempJs -Force -ErrorAction SilentlyContinue
        }
    }

    # -------------------------------------------------------------
    # SECTION 6: Single-Source Pipeline Sync & TestOnly Bypass
    # -------------------------------------------------------------
    Write-Host "`n[PHASE 6] Single-Source Pipeline Sync & TestOnly Mode Auditing" -ForegroundColor Yellow

    # GK-6.1: MD5 hash parity between root and publish
    $rootHash = (Get-FileHash -Path $BridgeJsPath -Algorithm MD5).Hash
    $publishHash = (Get-FileHash -Path $PublishBridgePath -Algorithm MD5).Hash
    Assert-Condition -Name "GK-6.1: Root and publish agent_bridge.js MD5 hash parity ($rootHash)" `
        -Condition ($rootHash -eq $publishHash) `
        -FailMessage "Hash mismatch: Root=$rootHash, Publish=$publishHash"

    # GK-6.2: TestOnly mode script safe bypass without publish directory
    $syncScript = Join-Path $WindowsDir "scripts\verify-rfc0005-bridge-sync.ps1"
    $testOnlyRun = & pwsh -NoProfile -File $syncScript -TestOnly 2>&1
    $syncExit = $LASTEXITCODE
    Assert-Condition -Name "GK-6.2: verify-rfc0005-bridge-sync.ps1 safely handles -TestOnly without deadlock" `
        -Condition ($syncExit -eq 0) `
        -FailMessage ($testOnlyRun -join "`n")

    Write-Host "`n========================================================" -ForegroundColor Green
    Write-Host "  RFC-0005 GATEKEEPER VERIFICATION: ALL $PassedAssertions/$TotalAssertions PASSED" -ForegroundColor Green
    Write-Host "  QUALITY GATE STATUS: FULL PASS (APPROVED FOR SHIP)" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
}
catch {
    Write-Host "`n[FATAL] Gatekeeper verification failed: $_" -ForegroundColor Red
    exit 1
}
