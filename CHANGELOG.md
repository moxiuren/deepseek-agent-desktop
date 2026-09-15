# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.9] - 2026-09-15

### Added
- **Decoupled Terminal Output Router**: Added `TerminalOutputRouter.cs` as a pure stateless static routing engine for Windows terminal outputs, completely decoupled from WPF STA threads and GUI dependencies. Supports direct text transmission up to 16,000 characters, head/tail truncation preservation (7,500 + 7,500 chars), 5MB pre-guard against OOM, and Windows drive letter colon disambiguation.
- **Host Execution Offset Mechanism**: Added precision measurement of PowerShell/terminal execution time (`hostMs`) passed via IPC JSON to front-end bridge, dynamically offsetting UI pacing delays.
- **Single-Source Automation Test Suites**: Added builder verification scripts (`verify-rfc0005-router.ps1`, `verify-rfc0005-bridge-dynamic.ps1`, `verify-rfc0005-bridge-sync.ps1`) integrated into `build.ps1`, and 23 independent assertion tests in `tests/rfcs/rfc-0005/gatekeeper/GatekeeperVerification.ps1`.

### Changed
- **Single-Authority Dynamic Throttle**: Re-architected front-end queuing in `agent_bridge.js` with `DynamicThrottle` powered by `performance.now()` monotonic clock, eliminating the legacy `MIN_SEND_GAP_MS = 8000` hardcoded wait.
- **Attachment Lifecycle & DOM State Machine**: Enhanced `waitForAttachmentReady` with dynamic 3~10s timeout calculation based on file size and structured `{ ok, timedOut, elapsed }` return; integrated `attach_failed` IPC event loop in host `MainWindow.xaml.cs`.
- **DirectSend Clock Synchronization**: Enforced monotonic clock alignment via `syncDirectSendSuccess()` when HTTP API direct channel succeeds.
- **Memory Guard & Resource Cleanup**: Replaced per-element timeout timers with singleton 60s periodic cleanup for dormant `streamBuf` entries (>120s).
- **Zero CS Compiler Warnings**: Resolved all nullable reference type warnings in `MainWindow.xaml.cs` and `TerminalOutputRouter.cs`, achieving 0 Warning(s), 0 Error(s) in Release builds.

### Fixed
- **Terminal Output Lag**: Eliminated 16~25s terminal response delays caused by misrouting text output through attachment rendering.
- **Pre-Guard OOM Vulnerability**: Intercepted oversized files by checking `FileInfo.Length <= MaxUploadBytes` before calling `File.ReadAllBytes`.
- **Binary Corrupted Text Decoding**: Prevented binary files (>5MB) from corrupting text streams by returning formatted metadata fallback instead of invoking `ReadAllText`.
- **Windows Path Disambiguation**: Resolved path truncation issues where Windows drive letters (e.g. `C:\path:Prompt`) were misidentified as prompt parameter separators.

## [1.0.8] - 2026-09-15

### Added
- **Native Accelerator Hotkey**: Added `CoreWebView2Controller.AcceleratorKeyPressed` and `webView.PreviewKeyDown` dual-layer interception for `Ctrl+I`, eliminating global keyboard hooks.
- **Robust Rolling Log Manager**: Added safe rotating file logger with a 5MB size ceiling, maximum 2 historical slices (`deepseek.log.1`, `deepseek.log.2`), and explicit thread synchronization.
- **Heartbeat Denoising Filter**: Added silent filtering for high-frequency `[read_file] OK` events targeting `Task-State.md` while preserving critical error events.
- **Legacy Desktop Log Cleanup**: Added startup detector and safe removal logic for oversized `deepseek_debug.log` on the user's desktop.
- **Automated Verification Test Suite**: Added 4 builder verification test scripts in `windows/scripts/` and 21 independent assertion tests in `tests/rfcs/rfc-0004/gatekeeper/`.

### Changed
- **Version Alignment**: Bumped project and assembly version to `1.0.8` across `DeepSeek.csproj` and runtime binaries.
- **Log Path Convergence**: Relocated runtime logging to standard `%LOCALAPPDATA%\DeepSeek-Agent\logs\deepseek.log`.

### Removed
- **Low-Level Keyboard Hook**: Completely removed `WH_KEYBOARD_LL`, `SetWindowsHookEx`, `UnhookWindowsHookEx`, `CallNextHookEx`, and `LowLevelKeyboardProc`, eradicating antivirus false positives and system-wide input latency risks.
