# DeepSeek for macOS (Agent Closed-Loop Edition)

> 🐬 极轻量（~500KB）、原生体验的 macOS DeepSeek 独立桌面客户端，内置 **本地 Agent 闭环执行桥梁**。
> 让 DeepSeek 官方网页端作为你的「规划大脑」，直接驱动本地终端与代码工具执行任务。

---

## 🌟 核心理念：网页端大脑 + 本地执行者

- **DeepSeek 网页端作为大脑（Planner）**：利用官方网页端免费、无限制且顶级的 R1 / V3 深度思考能力进行任务规划与分步决策。
- **本地 macOS 作为执行者（Executor）**：通过 App 内置的 Swift Native Bridge，自动捕获 DeepSeek 输出的代码块并在本地终端执行：
  - **系统级命令**：`local_cmd` 直接执行标准 Shell 命令（如 `ls`、`grep`、`git`、`python3`、`curl` 等）。
  - **极速代码生成**：支持 `agy-run`（基于 Gemini 3.8 Flash Low，无思考损耗，极速纯代码输出）。
- **零额外 API 费用**：完全基于官方 Web 端，免去商业 API 计量计费。
- **防频控与交互降噪**：
  - **智能节流（Anti-Rate-Limit）**：内置 3 秒自动节流倒计时，防止频繁触发网页端「Messages too frequent」限制。
  - **原生卡片化 UI**：在聊天窗口直接渲染高颜值 Tool Call 卡片，实时展现终端执行状态与输出。
  - **反馈自动折叠**：自动将长终端反馈折叠为紧凑胶囊，保持聊天界面整洁有序。

---

## ✨ 主要特性

### 1. Agent 悬浮控制胶囊 (HUD)
应用右上角常驻浮动控制栏：
- `🟢 Agent 就绪` / `🟡 正在执行...`：实时监测任务执行状态与心跳。
- `⚡️ 注入大脑协议 (⌘I)`：一键将 Agent 指令协议填入输入框并激活。
- `自动闭环: 开/暂停`：支持一键暂停自动执行或恢复闭环。

### 2. 原生 macOS 体验
- **超轻量**：仅约 500KB 原生编译二进制，启动速度秒开，无 Electron 内存臃肿。
- **快捷键支持**：
  - `⌘ I`：注入 Agent 闭环协议
  - `⌘ N`：新建聊天会话
  - `⌘ R` / `⌘ ⇧ R`：刷新 / 强制刷新
  - `⌘ W`：隐藏窗口（后台保持会话状态）
  - `⌘ Q`：退出应用
- **外链隔离**：聊天中的外部链接自动分发至系统默认浏览器打开。

### 3. 安全防护与稳定性
- **执行防死锁**：单条命令最大超时时间 180 秒，超时自动中断并上报。
- **输出截断保护**：超长终端输出自动保留首尾各 4000 字符，避免撑爆模型上下文。
- **流式输出防误触**：严格语法检测与 1.8 秒流式输出防抖，杜绝未写完的命令提前触发。

---

## 🚀 快速开始

### 1. 系统要求
- macOS 12.0 (Monterey) 或更高版本（支持 Apple Silicon 与 Intel 架构）。
- 已安装 Xcode 命令行工具：
  ```bash
  xcode-select --install
  ```

### 2. 编译与安装
克隆仓库后直接运行根目录构建脚本：
```bash
git clone https://github.com/moxiuren/deepseek-mac.git
cd deepseek-mac
./build.sh
```
构建成功后，`DeepSeek.app` 会自动安装到系统的 `/Applications`（应用程序）目录。

### 3. 可选：配置代码执行器 (`agy-run`)
若希望 DeepSeek 能调用本地极速大模型写代码，推荐配置别名包装脚本 `~/.local/bin/agy-run`（基于 Antigravity CLI 或任意自定义 CLI）：
```bash
mkdir -p ~/.local/bin
cat << 'EOF' > ~/.local/bin/agy-run
#!/bin/bash
exec agy --model gemini-3.8-flash-low --disable-slash-commands -p "$@"
EOF
chmod +x ~/.local/bin/agy-run
```

---

## 🛠️ 工作流演示

1. 打开应用，正常登录 DeepSeek 账号；
2. 点击右上角 **`⚡️ 注入大脑协议`**（或按 `⌘ I`），发送激活消息；
3. 向 DeepSeek 提出你的任务，例如：
   > *"帮我分析当前目录下的代码文件，并写一个自动化测试脚本。"*
4. DeepSeek 会自动进入思考，并输出命令代码块；
5. App 自动在本地终端运行该命令，回传结果，DeepSeek 继续下一步，直到全部完成！

---

## 📄 License

[MIT License](LICENSE) © 2026 moxiuren
