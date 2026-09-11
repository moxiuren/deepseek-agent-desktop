# DeepSeek for Windows (Agent Closed-Loop Edition)

基于 **.NET 8 (WPF) + Microsoft Edge WebView2** 构建的原生极轻量 Windows 客户端，内置本地 Agent 闭环执行支持。

---

## 🌟 特性

- **极轻量**：单文件发布仅 ~3MB，依托 Windows 10/11 系统内置的 Edge Chromium WebView2 运行时，无需打包庞大浏览器内核。
- **全自动 Tool Call 闭环**：通过 `window.chrome.webview` 双向消息通道，捕获 DeepSeek 网页端输出的命令并在本地 PowerShell 执行，自动将结果回填到聊天流。
- **稳健脚本执行**：本地执行采用 PowerShell `-EncodedCommand`（Base64 编码调用），杜绝引号、换行与特殊字符转义失效。
- **原生视觉感知 (`agent-screenshot`)**：内置 C# 原生屏幕捕获，免除第三方截图脚本依赖与杀软误报，毫秒级抓取桌面并自动打包为图片附件回传。
- **大文件安全挂载 (`agent-attach`)**：支持本地大文件直接挂载为附件，终端输出超 6KB 自动打包为附件上传，防止上下文溢出。
- **单实例互斥唤醒**：内置进程互斥锁与窗口唤醒机制，防止重复多开进程，再次启动自动将已有窗口还原并置顶。
- **微软 7 阶混合应用图标**：遵循 Windows 原生标准，大图标层支持 4K 高分屏平铺，中小图标层支持资源管理器原生渲染不白板。
- **原生卡片与降噪**：聊天界面嵌入高颜值状态卡片、3 秒节流倒计时与反馈长文本自动折叠胶囊。
- **快捷键**：
  - `Ctrl + N`：新建聊天会话
  - `Ctrl + I`：注入 Agent 大脑系统协议
  - `Ctrl + R` / `Ctrl + Shift + R`：刷新 / 强制刷新
  - `Ctrl + +` / `Ctrl + -` / `Ctrl + 0`：页面缩放与重置

---

## 🚀 编译与运行

### 1. 前置准备
- Windows 10 (1809+) 或 Windows 11
- 已安装 [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- 系统已安装 Microsoft Edge WebView2 Runtime（Win 11 与更新版 Win 10 均已默认预装）

### 2. 一键编译打包
在当前 `windows` 目录下双击运行 `build.bat`，或在 PowerShell 中执行：
```powershell
.\build.ps1
```
编译成功后，将在 `windows\publish\` 目录下生成单文件独立可执行程序 `DeepSeek.exe`。

---

## 💡 代码生成工具适配 (`agy-run`)

若希望 DeepSeek 驱动本地模型极速生成代码，可在 Windows 用户目录创建批处理脚本 `%USERPROFILE%\.local\bin\agy-run.cmd`：
```batch
@echo off
agy --model gemini-3.8-flash-low --disable-slash-commands -p %*
```
应用启动时会自动将 `%USERPROFILE%\.local\bin` 纳入系统环境变量 `PATH`。
