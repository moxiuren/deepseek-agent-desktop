# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
