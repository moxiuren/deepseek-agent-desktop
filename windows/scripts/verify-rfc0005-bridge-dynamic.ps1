# verify-rfc0005-bridge-dynamic.ps1 - RFC-0005 Section 11.1 Verification
# Asserts DynamicThrottle algorithm via Node.js execution.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $WindowsDir
$bridgeJs = Join-Path $RepoRoot "agent_bridge.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "[FAIL] Node.js not found in PATH! Required for DynamicThrottle tests."
    exit 1
}

$nodeScript = @'
const fs = require('fs');
const assert = require('assert');

const bridgePath = process.argv[2];
const content = fs.readFileSync(bridgePath, 'utf8');

// Extract DynamicThrottle definition via balanced braces
const startIdx = content.indexOf('const DynamicThrottle = {');
if (startIdx === -1) {
    console.error('[FAIL] Could not find DynamicThrottle start in agent_bridge.js');
    process.exit(1);
}
let openBraces = 0, endIdx = -1, started = false;
for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') { openBraces++; started = true; }
    else if (content[i] === '}') {
        openBraces--;
        if (started && openBraces === 0) { endIdx = i + 1; break; }
    }
}
if (endIdx === -1) {
    console.error('[FAIL] Unbalanced braces for DynamicThrottle in agent_bridge.js');
    process.exit(1);
}
const dtCode = content.slice(startIdx, endIdx);

// Evaluate DynamicThrottle in a sandbox context
const vm = require('vm');
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

console.log('[INFO] DynamicThrottle extracted successfully.');

// 断言 1 (冷启动): lastSendMono = 0 时，断言 remainingWaitMs == 0
DynamicThrottle.lastSendMono = 0;
DynamicThrottle.recentSends = [];
const res1 = DynamicThrottle.evaluate({ cardId: 'c1', isAttachment: false, hostMs: 0 });
console.log('[TEST 1/4] Cold start evaluation:', res1);
assert.strictEqual(res1.remainingWaitMs, 0, 'Cold start remainingWaitMs must be 0');
console.log('[PASS] Test 1: Cold start remainingWaitMs is 0');

// 断言 2 (长执行冲抵): hostMs = 5000 时，断言 remainingWaitMs == 0
DynamicThrottle.recordSendCommit(performance.now());
const res2 = DynamicThrottle.evaluate({ cardId: 'c2', isAttachment: false, hostMs: 5000 });
console.log('[TEST 2/4] Long execution offset evaluation (hostMs=5000):', res2);
assert.strictEqual(res2.remainingWaitMs, 0, 'hostMs=5000 offset must result in remainingWaitMs == 0');
console.log('[PASS] Test 2: Long execution offset reduces wait to 0ms');

// 断言 3 (突发密集): 连续触发 3 次 recordSendCommit，断言 burstCount >= 3 且 remainingWaitMs >= 2000
const tNow = performance.now();
DynamicThrottle.recentSends = [];
DynamicThrottle.recordSendCommit(tNow);
DynamicThrottle.recordSendCommit(tNow + 1);
DynamicThrottle.recordSendCommit(tNow + 2);
const res3 = DynamicThrottle.evaluate({ cardId: 'c3', isAttachment: false, hostMs: 0 });
console.log('[TEST 3/4] Burst sends evaluation:', res3);
assert(res3.burstCount >= 3, 'burstCount must be >= 3');
assert(res3.remainingWaitMs >= 2000, 'remainingWaitMs must be >= 2000 on 3 bursts (penalty=2500)');
console.log('[PASS] Test 3: Burst penalty correctly enforces wait >= 2000ms');

// 断言 4 (时钟回拨): 构造异常负时间差，断言函数不产生负等待且不抛出异常
DynamicThrottle.lastSendMono = performance.now() + 1000000; // future timestamp simulating clock skew backwards
const res4 = DynamicThrottle.evaluate({ cardId: 'c4', isAttachment: false, hostMs: -500 });
console.log('[TEST 4/4] Clock skew evaluation:', res4);
assert(res4.remainingWaitMs >= 0, 'remainingWaitMs must not be negative');
assert(!isNaN(res4.remainingWaitMs), 'remainingWaitMs must be a valid number');
console.log('[PASS] Test 4: Clock skew handled safely, non-negative wait');

console.log('[PASS] All 4 DynamicThrottle assertions passed.');
'@

$tempJs = [System.IO.Path]::GetTempFileName() + ".js"
[System.IO.File]::WriteAllText($tempJs, $nodeScript, [System.Text.Encoding]::UTF8)

try {
    Write-Host "[INFO] Running Node.js dynamic throttle verification..." -ForegroundColor Cyan
    & node $tempJs $bridgeJs
    if ($LASTEXITCODE -ne 0) {
        Write-Error "[FAIL] Node.js dynamic verification failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
    Write-Host "[PASS] All dynamic throttle verifications passed." -ForegroundColor Green
    exit 0
}
finally {
    if (Test-Path $tempJs) {
        Remove-Item -Path $tempJs -Force -ErrorAction SilentlyContinue
    }
}
