# verify-rfc0005-router.ps1 - RFC-0005 Section 11.1 Verification
# Asserts TerminalOutputRouter decoupled static routing and memory guards.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("deepseek_test_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
    Write-Host "[INFO] Starting verification: TerminalOutputRouter (RFC-0005 Section 8.1)..." -ForegroundColor Cyan

    $routerCs = Join-Path $WindowsDir "TerminalOutputRouter.cs"
    if (-not (Test-Path $routerCs)) {
        Write-Error "[FAIL] File not found: $routerCs"
        exit 1
    }

    Write-Host "[INFO] Compiling and loading TerminalOutputRouter via Add-Type..."
    Add-Type -Path $routerCs

    # --- 断言 1: 输入 10,000 字符文本 ---
    Write-Host "[TEST 1/4] Direct text routing (10,000 chars)..." -ForegroundColor Yellow
    $text10k = "A" * 10000
    $res1 = [DeepSeek.TerminalOutputRouter]::Route($text10k, $TempDir)
    if ($res1.IsAttachment) {
        Write-Error "[FAIL] Test 1: IsAttachment should be false, but was true"
        exit 1
    }
    if ($res1.OutputText.Length -ne 10000) {
        Write-Error "[FAIL] Test 1: OutputText.Length expected 10000, got $($res1.OutputText.Length)"
        exit 1
    }
    Write-Host "[PASS] Test 1: 10,000 chars routed directly without attachment." -ForegroundColor Green

    # --- 断言 2: 输入 20,000 字符文本 ---
    Write-Host "[TEST 2/4] Oversized text truncation and disk persistence (20,000 chars)..." -ForegroundColor Yellow
    $text20k = "B" * 20000
    $res2 = [DeepSeek.TerminalOutputRouter]::Route($text20k, $TempDir)
    if ($res2.IsAttachment) {
        Write-Error "[FAIL] Test 2: IsAttachment should be false, but was true"
        exit 1
    }
    if ($res2.OutputText.Length -gt 16000) {
        Write-Error "[FAIL] Test 2: OutputText.Length exceeds 16000 (actual: $($res2.OutputText.Length))"
        exit 1
    }
    if ([string]::IsNullOrEmpty($res2.LocalOversizedPath) -or -not (Test-Path $res2.LocalOversizedPath)) {
        Write-Error "[FAIL] Test 2: LocalOversizedPath not found or not set: $($res2.LocalOversizedPath)"
        exit 1
    }
    $persistedContent = [System.IO.File]::ReadAllText($res2.LocalOversizedPath, [System.Text.Encoding]::UTF8)
    if ($persistedContent.Length -ne 20000) {
        Write-Error "[FAIL] Test 2: Persisted file length expected 20000, got $($persistedContent.Length)"
        exit 1
    }
    Write-Host "[PASS] Test 2: 20,000 chars safely truncated to $($res2.OutputText.Length) and persisted to disk." -ForegroundColor Green

    # --- 断言 3: 构造 10MB 假二进制文件，触发 [[AGENT_ATTACH_FILE:...]] ---
    Write-Host "[TEST 3/4] 10MB binary file guard against OOM..." -ForegroundColor Yellow
    $bin10mb = Join-Path $TempDir "large_test.bin"
    $fs = [System.IO.File]::Create($bin10mb)
    $fs.SetLength(10 * 1024 * 1024)
    $fs.Close()

    $cmdOutput3 = "Command done. [[AGENT_ATTACH_FILE:${bin10mb}:请分析]]"
    $res3 = [DeepSeek.TerminalOutputRouter]::Route($cmdOutput3, $TempDir)
    if ($res3.IsAttachment) {
        Write-Error "[FAIL] Test 3: 10MB file should not be attached, IsAttachment must be false"
        exit 1
    }
    if (-not $res3.OutputText.Contains("二进制类型 [.bin]，无法作为文本展开")) {
        Write-Error "[FAIL] Test 3: OutputText missing binary rejection message: $($res3.OutputText)"
        exit 1
    }
    Write-Host "[PASS] Test 3: 10MB binary file intercepted without OOM, properly categorized." -ForegroundColor Green

    # --- 断言 4: 构造 1MB 正常图片 ---
    Write-Host "[TEST 4/4] 1MB regular image attachment..." -ForegroundColor Yellow
    $img1mb = Join-Path $TempDir "sample_screenshot.png"
    $bytes1mb = [byte[]]::new(1024 * 1024)
    [System.IO.File]::WriteAllBytes($img1mb, $bytes1mb)

    $cmdOutput4 = "[[AGENT_ATTACH_FILE:${img1mb}:屏幕截图]]"
    $res4 = [DeepSeek.TerminalOutputRouter]::Route($cmdOutput4, $TempDir)
    if (-not $res4.IsAttachment) {
        Write-Error "[FAIL] Test 4: IsAttachment expected true for 1MB image"
        exit 1
    }
    if ([string]::IsNullOrEmpty($res4.Base64Data)) {
        Write-Error "[FAIL] Test 4: Base64Data must not be empty"
        exit 1
    }
    if ($res4.MimeType -ne "image/png") {
        Write-Error "[FAIL] Test 4: MimeType expected 'image/png', got '$($res4.MimeType)'"
        exit 1
    }
    if ($res4.Filename -ne "sample_screenshot.png") {
        Write-Error "[FAIL] Test 4: Filename expected 'sample_screenshot.png', got '$($res4.Filename)'"
        exit 1
    }
    Write-Host "[PASS] Test 4: 1MB image correctly parsed as attachment." -ForegroundColor Green

    Write-Host ""
    Write-Host "[PASS] All 4 router verification tests passed successfully." -ForegroundColor Green
    exit 0
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
