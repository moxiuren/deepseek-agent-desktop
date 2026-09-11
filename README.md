# DeepSeek Desktop (Agent Closed-Loop Edition)

> 🐬 原生极轻量、跨平台（macOS & Windows）的 DeepSeek 桌面客户端，内置 **本地 Agent 闭环执行引擎**。
> 让 DeepSeek 官方网页端免费、顶级的 R1 / V3 思考能力作为你的「规划大脑」，直接驱动本地终端与代码工具自主完成任务。

---

## 🌟 核心理念：网页端大脑 + 本地执行者

- **DeepSeek 网页端作为大脑（Planner）**：利用官方网页端免费且顶级的 R1 深度思考与推理能力进行任务规划、分步决策与代码审查。
- **本地 macOS / Windows 作为执行者（Executor）**：通过应用内置的 Native Bridge，自动捕获 DeepSeek 输出的代码块并在本地终端执行：
  - **macOS**：通过 Swift Native Bridge 调用 `/bin/zsh`
  - **Windows**：通过 C# (.NET 8) WebView2 调用 `PowerShell`
  - **系统级命令**：`local_cmd` 直接执行系统原生命令（文件读写、目录检索、编译测试、git 操作等）。
  - **极速代码生成**：支持 `agy-run`（基于 Gemini 3.8 Flash Low，无思考损耗，极速纯代码输出）。
- **零额外 API 费用**：完全基于官方 Web 端，免去商业 API 计量计费。
- **防频控与交互降噪**：
  - **智能节流（Anti-Rate-Limit）**：内置 3 秒自动节流倒计时，防止频繁触发网页端「Messages too frequent」限制。
  - **原生卡片化 UI**：在聊天窗口直接渲染高颜值 Tool Call 卡片，实时展现终端执行状态与输出。
  - **反馈自动折叠**：自动将长终端反馈折叠为紧凑胶囊，保持聊天界面整洁有序。

---

## 🖥️ 平台架构与技术栈

| 平台 | 宿主技术栈 | 网页渲染内核 | 终端执行底座 | 安装包体积 |
| :--- | :--- | :--- | :--- | :--- |
| **macOS** | Swift 6 + AppKit | 系统内置 `WKWebView` | `/bin/zsh -l -c` | **~500 KB** |
| **Windows** | C# (.NET 8 WPF) | 系统内置 Edge `CoreWebView2` | `powershell.exe -EncodedCommand` | **~3 MB** |

两端共享同一个高度优化的前端闭环注入引擎 [`agent_bridge.js`](agent_bridge.js)，自动识别当前操作系统并适配对应的提示词与交互协议。

---

## ✨ 主要特性

### 1. Agent 悬浮控制胶囊 (HUD)
应用右上角常驻浮动控制栏：
- `🟢 Agent 就绪` / `🟡 正在执行...`：实时监测任务执行状态与心跳。
- `⚡️ 注入大脑协议`：一键将 Agent 指令协议填入输入框并激活。
- `自动闭环: 开/暂停`：支持一键暂停自动执行或恢复闭环。

### 2. 原生快捷键支持
- **macOS**：
  - `⌘ I`：注入 Agent 协议
  - `⌘ N`：新建会话
  - `⌘ R` / `⌘ ⇧ R`：刷新 / 强制刷新
  - `⌘ W`：隐藏窗口（保持后台状态）
  - `⌘ Q`：退出应用
- **Windows**：
  - `Ctrl + I`：注入 Agent 协议
  - `Ctrl + N`：新建会话
  - `Ctrl + R` / `Ctrl + Shift + R`：刷新 / 强制刷新
  - `Ctrl + +` / `Ctrl + -` / `Ctrl + 0`：页面缩放与重置

### 3. 安全防护与稳定性
- **执行防死锁**：单条命令最大超时时间 180 秒，超时自动中断并上报。
- **输出截断保护**：超长终端输出自动保留首尾各 4000 字符，避免撑爆模型上下文。
- **流式输出防抖**：严格语法检测与 1.8 秒流式输出防抖，杜绝未写完的命令提前触发。
- **外链安全隔离**：聊天中的外部链接自动分发至系统默认浏览器打开。

---

## 🚀 编译与安装

### 🍎 macOS 用户

1. 前置准备：
   ```bash
   xcode-select --install
   ```
2. 运行根目录构建脚本：
   ```bash
   ./build.sh
   ```
   构建完成后将自动安装至 `/Applications/DeepSeek.app`。

### 🪟 Windows 用户

1. 前置准备：
   - 安装 [.NET 8.0 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
   - 系统支持 WebView2（Windows 11 及现代 Win 10 均默认自带）
2. 运行构建脚本：
   进入 `windows` 目录，双击运行 `build.bat` 或在 PowerShell 中执行：
   ```powershell
   cd windows
   .\build.ps1
   ```
   构建完成后在 `windows/publish/` 生成单文件可执行程序 `DeepSeek.exe`。

---

## 💡 代码生成工具适配 (`agy-run`)

若希望 DeepSeek 驱动本地模型极速编写代码，可配置 `agy-run` 别名包装脚本：

- **macOS (`~/.local/bin/agy-run`)**：
  ```bash
  cat << 'EOF' > ~/.local/bin/agy-run
  #!/bin/bash
  exec agy --model gemini-3.8-flash-low --disable-slash-commands -p "$@"
  EOF
  chmod +x ~/.local/bin/agy-run
  ```

- **Windows (`%USERPROFILE%\.local\bin\agy-run.cmd`)**：
  ```batch
  @echo off
  agy --model gemini-3.8-flash-low --disable-slash-commands -p %*
  ```

---

## 🛠️ 工作流演示

1. 打开应用，正常登录 DeepSeek 账号；
2. 点击右上角 **`⚡️ 注入大脑协议`**（或按快捷键），发送激活协议；
3. 向 DeepSeek 提出你的任务，例如：
   > *"帮我分析当前目录下的代码文件，并写一个自动化测试脚本。"*
4. DeepSeek 会自动进入思考，并输出命令代码块；
5. App 自动在本地终端运行该命令，回传结果，DeepSeek 继续下一步，直到全部完成！

---

## 📄 License

[MIT License](LICENSE) © 2026 moxiuren
