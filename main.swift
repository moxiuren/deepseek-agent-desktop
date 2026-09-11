import AppKit
import WebKit

class DeepSeekAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var workDirectory: String = {
        let projectsDir = (NSHomeDirectory() as NSString).appendingPathComponent("Documents/Projects")
        if FileManager.default.fileExists(atPath: projectsDir) {
            return projectsDir
        }
        return NSHomeDirectory()
    }()
    var isExecuting: Bool = false
    var dumpTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        setupWindow()
        setupWebView()
        setupDumpTimer()
        loadDeepSeek()
    }

    private func setupWindow() {
        let initialRect = NSRect(x: 100, y: 100, width: 1240, height: 860)
        window = NSWindow(
            contentRect: initialRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.title = "DeepSeek"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 900, height: 600)
        window.setFrameAutosaveName("DeepSeekMainWindow")
        window.delegate = self

        if !window.setFrameUsingName("DeepSeekMainWindow") {
            window.center()
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        
        // Enable Developer Extras / Web Inspector
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        // Register Native Script Message Handler
        config.userContentController.add(self, name: "agentBridge")

        // Load Injected Agent Bridge JS
        let bridgeJS = getAgentBridgeScript()
        if !bridgeJS.isEmpty {
            let userScript = WKUserScript(source: bridgeJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            config.userContentController.addUserScript(userScript)
        }

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

        window.contentView?.addSubview(webView)
    }

    private func setupDumpTimer() {
        dumpTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if FileManager.default.fileExists(atPath: "/tmp/dump_chat.trigger") {
                try? FileManager.default.removeItem(atPath: "/tmp/dump_chat.trigger")
                let js = "window.__agentBridge ? window.__agentBridge.dumpConversation() : '';"
                self.webView.evaluateJavaScript(js) { (res, err) in
                    if let text = res as? String, !text.isEmpty {
                        try? text.write(toFile: "/tmp/deepseek_conversation.txt", atomically: true, encoding: .utf8)
                        print("[Native Bridge] Successfully dumped conversation to /tmp/deepseek_conversation.txt")
                        fflush(stdout)
                    }
                }
            }
        }
    }

    private func loadDeepSeek() {
        if let url = URL(string: "https://chat.deepseek.com/") {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }

    // MARK: - Script Message Handler (JS -> Swift Bridge)
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "agentBridge",
              let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else {
            return
        }

        switch action {
        case "execute":
            let command = dict["command"] as? String ?? ""
            let id = dict["id"] as? String ?? UUID().uuidString
            handleCommandExecution(command: command, id: id)

        case "getWorkDir":
            let js = "window.__agentBridge && window.__agentBridge.setWorkDir(`\(workDirectory)`);"
            webView.evaluateJavaScript(js, completionHandler: nil)

        case "setWorkDir":
            if let dir = dict["dir"] as? String, !dir.isEmpty {
                self.workDirectory = dir
                print("[Native Bridge] Working directory set to: \(dir)")
                fflush(stdout)
            }

        case "log":
            if let msg = dict["message"] as? String {
                print("[WebJS] \(msg)")
                fflush(stdout)
            }

        default:
            break
        }
    }

    // MARK: - Native Command Execution
    private func handleCommandExecution(command: String, id: String) {
        guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        isExecuting = true
        print("[Native Bridge] >>> EXECUTING COMMAND (ID: \(id)):\n\(command)")
        fflush(stdout)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-l", "-c", command]

            var env = ProcessInfo.processInfo.environment
            let homeDir = NSHomeDirectory()
            let userName = NSUserName()
            let customPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(homeDir)/.local/bin"
            env["PATH"] = "\(customPath):\(env["PATH"] ?? "")"
            env["HOME"] = homeDir
            env["USER"] = userName
            env["TERM"] = "xterm-256color"
            env["LANG"] = "en_US.UTF-8"
            process.environment = env

            let workDirURL = URL(fileURLWithPath: self.workDirectory)
            if FileManager.default.fileExists(atPath: workDirURL.path) {
                process.currentDirectoryURL = workDirURL
            } else {
                process.currentDirectoryURL = URL(fileURLWithPath: homeDir)
            }

            let outputPipe = Pipe()
            let errorPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = errorPipe

            do {
                try process.run()
                
                let timeoutSeconds = 180.0
                let startTime = Date()
                while process.isRunning {
                    if Date().timeIntervalSince(startTime) > timeoutSeconds {
                        process.terminate()
                        break
                    }
                    usleep(100000) // 100ms
                }

                let outData = outputPipe.fileHandleForReading.readDataToEndOfFile()
                let errData = errorPipe.fileHandleForReading.readDataToEndOfFile()
                let outStr = String(data: outData, encoding: .utf8) ?? ""
                let errStr = String(data: errData, encoding: .utf8) ?? ""
                let exitCode = process.terminationStatus

                var result = ""
                if !outStr.isEmpty {
                    result += outStr
                }
                if !errStr.isEmpty {
                    if !result.isEmpty { result += "\n" }
                    result += "[STDERR]:\n" + errStr
                }
                if result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    result = "(命令执行完毕，无终端文字输出)"
                }

                let maxChars = 8000
                if result.count > maxChars {
                    let prefix = result.prefix(4000)
                    let suffix = result.suffix(4000)
                    result = "\(prefix)\n\n...[输出过长，已折叠中间 \(result.count - maxChars) 字符]...\n\n\(suffix)"
                }

                print("[Native Bridge] <<< COMMAND FINISHED (Exit: \(exitCode), Length: \(result.count))")
                fflush(stdout)

                DispatchQueue.main.async {
                    self.isExecuting = false
                    self.feedResultBackToWeb(id: id, exitCode: exitCode, output: result)
                }
            } catch {
                print("[Native Bridge] !!! EXECUTION FAILED: \(error)")
                fflush(stdout)
                DispatchQueue.main.async {
                    self.isExecuting = false
                    self.feedResultBackToWeb(id: id, exitCode: -1, output: "执行失败: \(error.localizedDescription)")
                }
            }
        }
    }

    private func feedResultBackToWeb(id: String, exitCode: Int32, output: String) {
        let jsonOutput: [String: Any] = [
            "id": id,
            "exitCode": exitCode,
            "output": output
        ]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: jsonOutput, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return
        }

        let js = "window.__agentBridge && window.__agentBridge.onCommandResult(\(jsonString));"
        webView.evaluateJavaScript(js) { (res, err) in
            if let err = err {
                print("[Native Bridge] Feed result JS error: \(err)")
            } else {
                print("[Native Bridge] Fed result to chat successfully.")
            }
            fflush(stdout)
        }
    }

    // MARK: - Window Management
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    // MARK: - Navigation Policy
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        let host = url.host?.lowercased() ?? ""
        let isDeepSeek = host.hasSuffix("deepseek.com") || host.hasSuffix("volces.com")
        let isAuthService = host.contains("google.com") || host.contains("qq.com") || host.contains("wechat.com") || host.contains("apple.com") || host.contains("microsoft.com") || host.contains("github.com")

        if navigationAction.navigationType == .linkActivated {
            if isDeepSeek || isAuthService {
                decisionHandler(.allow)
            } else {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            }
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    // MARK: - Download Delegate
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloadsDir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        var destination = downloadsDir.appendingPathComponent(suggestedFilename)

        var counter = 1
        let baseName = destination.deletingPathExtension().lastPathComponent
        let ext = destination.pathExtension
        while FileManager.default.fileExists(atPath: destination.path) {
            let newName = "\(baseName) (\(counter)).\(ext)"
            destination = downloadsDir.appendingPathComponent(newName)
            counter += 1
        }
        completionHandler(destination)
    }

    // MARK: - UI Delegate
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { result in
            if result == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: - Menu Setup
    private func setupMenu() {
        let mainMenu = NSMenu()

        // 1. App Menu
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "DeepSeek")
        appMenu.addItem(withTitle: "关于 DeepSeek", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏 DeepSeek", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 DeepSeek", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // 2. File Menu
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        let newChat = NSMenuItem(title: "新建会话", action: #selector(newChatAction), keyEquivalent: "n")
        newChat.target = self
        fileMenu.addItem(newChat)
        let injectPrompt = NSMenuItem(title: "注入 Agent 大脑协议", action: #selector(injectPromptAction), keyEquivalent: "i")
        injectPrompt.target = self
        fileMenu.addItem(injectPrompt)
        fileMenu.addItem(NSMenuItem.separator())
        let closeWindow = NSMenuItem(title: "关闭窗口", action: #selector(closeWindowAction), keyEquivalent: "w")
        closeWindow.target = self
        fileMenu.addItem(closeWindow)
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // 3. Edit Menu
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // 4. View Menu
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "视图")
        let reload = NSMenuItem(title: "刷新", action: #selector(reloadAction), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)

        let forceReload = NSMenuItem(title: "强制刷新", action: #selector(forceReloadAction), keyEquivalent: "r")
        forceReload.keyEquivalentModifierMask = [.command, .shift]
        forceReload.target = self
        viewMenu.addItem(forceReload)

        viewMenu.addItem(NSMenuItem.separator())
        let zoomIn = NSMenuItem(title: "放大", action: #selector(zoomInAction), keyEquivalent: "=")
        zoomIn.target = self
        viewMenu.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "缩小", action: #selector(zoomOutAction), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(zoomOut)
        let zoomReset = NSMenuItem(title: "实际大小", action: #selector(zoomResetAction), keyEquivalent: "0")
        zoomReset.target = self
        viewMenu.addItem(zoomReset)

        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(withTitle: "切换全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // 5. History Menu
        let historyMenuItem = NSMenuItem()
        let historyMenu = NSMenu(title: "历史")
        let goBack = NSMenuItem(title: "后退", action: #selector(goBackAction), keyEquivalent: "[")
        goBack.target = self
        historyMenu.addItem(goBack)
        let goForward = NSMenuItem(title: "前进", action: #selector(goForwardAction), keyEquivalent: "]")
        goForward.target = self
        historyMenu.addItem(goForward)
        historyMenuItem.submenu = historyMenu
        mainMenu.addItem(historyMenuItem)

        // 6. Window Menu
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Actions
    @objc func newChatAction() {
        if let url = URL(string: "https://chat.deepseek.com/") {
            webView.load(URLRequest(url: url))
        }
    }

    @objc func injectPromptAction() {
        let js = "window.__agentBridge && window.__agentBridge.injectSystemPrompt();"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    @objc func closeWindowAction() {
        window.orderOut(nil)
    }

    @objc func reloadAction() {
        webView.reload()
    }

    @objc func forceReloadAction() {
        webView.reloadFromOrigin()
    }

    @objc func zoomInAction() {
        webView.pageZoom += 0.1
    }

    @objc func zoomOutAction() {
        if webView.pageZoom > 0.4 {
            webView.pageZoom -= 0.1
        }
    }

    @objc func zoomResetAction() {
        webView.pageZoom = 1.0
    }

    @objc func goBackAction() {
        if webView.canGoBack {
            webView.goBack()
        }
    }

    @objc func goForwardAction() {
        if webView.canGoForward {
            webView.goForward()
        }
    }

    // MARK: - Injected Script Loader
    private func getAgentBridgeScript() -> String {
        if let url = Bundle.main.url(forResource: "agent_bridge", withExtension: "js"),
           let content = try? String(contentsOf: url, encoding: .utf8) {
            return content
        }
        let currentDirScript = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("agent_bridge.js")
        if let content = try? String(contentsOf: currentDirScript, encoding: .utf8) {
            return content
        }
        return ""
    }
}

// Entrypoint
let app = NSApplication.shared
let delegate = DeepSeekAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
