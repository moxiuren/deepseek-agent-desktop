using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace DeepSeek
{
    public partial class MainWindow : Window
    {
        private bool _isExecuting = false;
        private long _lastDropTimestamp = 0;

        public MainWindow()
        {
            App.Log("MainWindow.ctor enter");
            InitializeComponent();
            App.Log("MainWindow.ctor InitializeComponent done");

            // Ensure window boundaries never overflow primary screen working area
            try
            {
                var workArea = SystemParameters.WorkArea;
                if (workArea.Width > 0 && workArea.Height > 0)
                {
                    Width = Math.Min(1180, workArea.Width - 40);
                    Height = Math.Min(700, workArea.Height - 40);
                    Left = workArea.Left + (workArea.Width - Width) / 2;
                    Top = workArea.Top + (workArea.Height - Height) / 2;
                    App.Log($"Window size adjusted to: {Width}x{Height} at [{Left}, {Top}]");
                }
            }
            catch (Exception ex)
            {
                App.Log($"WorkArea adjust error: {ex.Message}");
            }

            try
            {
                string exePath = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName ?? "";
                if (File.Exists(exePath))
                {
                    using var icon = System.Drawing.Icon.ExtractAssociatedIcon(exePath);
                    if (icon != null)
                    {
                        Icon = System.Windows.Interop.Imaging.CreateBitmapSourceFromHIcon(
                            icon.Handle,
                            Int32Rect.Empty,
                            System.Windows.Media.Imaging.BitmapSizeOptions.FromEmptyOptions());
                    }
                }
            }
            catch (Exception ex)
            {
                App.Log($"Icon load error: {ex.Message}");
            }

            // Global shortcut handler that works even when WebView2 is focused
            ComponentDispatcher.ThreadPreprocessMessage += ComponentDispatcher_ThreadPreprocessMessage;

            Loaded += MainWindow_Loaded;
            App.Log("MainWindow.ctor exit");
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ChangeWindowMessageFilterEx(IntPtr hWnd, uint msg, uint action, IntPtr pChangeFilterStruct);

        private const uint MSGFLT_ALLOW = 1;
        private const int SW_RESTORE = 9;

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var handle = new WindowInteropHelper(this).Handle;
            try
            {
                ChangeWindowMessageFilterEx(handle, App.WM_SHOW_DEEPSEEK, MSGFLT_ALLOW, IntPtr.Zero);
            }
            catch {}
            var source = HwndSource.FromHwnd(handle);
            source?.AddHook(WndProc);
            App.Log("MainWindow.OnSourceInitialized done, WndProc hook registered");
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if ((uint)msg == App.WM_SHOW_DEEPSEEK)
            {
                App.Log("[SingleInstance] Received WM_SHOW_DEEPSEEK message, restoring and activating window.");
                Dispatcher.Invoke(() =>
                {
                    if (WindowState == WindowState.Minimized)
                    {
                        WindowState = WindowState.Normal;
                    }
                    var handle = new WindowInteropHelper(this).Handle;
                    ShowWindow(handle, SW_RESTORE);
                    SetForegroundWindow(handle);
                    Activate();
                    Topmost = true;
                    Topmost = false;
                    Focus();
                });
                handled = true;
            }
            return IntPtr.Zero;
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            App.Log("MainWindow_Loaded enter");
            await InitializeWebViewAsync();
            App.Log("MainWindow_Loaded exit");
        }

        private async Task InitializeWebViewAsync()
        {
            try
            {
                App.Log("InitializeWebViewAsync enter");
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string userDataFolder = Path.Combine(localAppData, "DeepSeek", "WebView2");
                Directory.CreateDirectory(userDataFolder);
                App.Log($"userDataFolder: {userDataFolder}");

                // Optional remote-debugging port (set DEEPSEEK_DEBUG_PORT to enable CDP introspection)
                var envOptions = new CoreWebView2EnvironmentOptions();
                string dbgPort = Environment.GetEnvironmentVariable("DEEPSEEK_DEBUG_PORT");
                if (!string.IsNullOrWhiteSpace(dbgPort))
                {
                    envOptions.AdditionalBrowserArguments = $"--remote-debugging-port={dbgPort} --remote-allow-origins=*";
                    App.Log($"[Debug] remote debugging enabled on port {dbgPort}");
                }
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, envOptions);
                App.Log("CoreWebView2Environment.CreateAsync done");

                // Retry if 0x800700AA occurs (e.g. if previous process was closed recently and lock is still releasing)
                for (int attempt = 1; attempt <= 3; attempt++)
                {
                    try
                    {
                        await webView.EnsureCoreWebView2Async(env);
                        break;
                    }
                    catch (System.Runtime.InteropServices.COMException comEx) when ((uint)comEx.ErrorCode == 0x800700AA && attempt < 3)
                    {
                        App.Log($"[WARN] EnsureCoreWebView2Async attempt {attempt} failed with 0x800700AA (Resource in use), retrying in 600ms...");
                        await Task.Delay(600);
                    }
                }
                App.Log("EnsureCoreWebView2Async done");

                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.Settings.IsBuiltInErrorPageEnabled = true;
                webView.CoreWebView2.Settings.IsZoomControlEnabled = true;

                // Load and apply saved zoom factor or optimal preset for screen
                double initialZoom = LoadSavedZoomFactor();
                webView.ZoomFactor = initialZoom;
                UpdateZoomDisplay(initialZoom);
                App.Log($"Applied initial zoom: {initialZoom}");

                webView.ZoomFactorChanged += (s, ev) =>
                {
                    Dispatcher.Invoke(() =>
                    {
                        UpdateZoomDisplay(webView.ZoomFactor);
                        SaveZoomFactor(webView.ZoomFactor);
                    });
                };

                // Open external links in user's default browser
                webView.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;

                // Handle messages sent from agent_bridge.js
                webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;

                // Inject agent_bridge.js on document created (guarantees execution on all page loads)
                string bridgeScript = GetAgentBridgeScript();
                if (!string.IsNullOrEmpty(bridgeScript))
                {
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
                    App.Log($"agent_bridge.js script registered ({bridgeScript.Length} chars)");
                }

                // Navigate to DeepSeek
                App.Log("Navigating to https://chat.deepseek.com ...");
                webView.CoreWebView2.Navigate("https://chat.deepseek.com");
                App.Log("Navigate called successfully");
            }
            catch (Exception ex)
            {
                App.Log($"[ERROR] InitializeWebViewAsync failed: {ex}");
                MessageBox.Show($"初始化 WebView2 失败: {ex.Message}\n请确保已安装 Microsoft Edge WebView2 运行时。", "DeepSeek 启动错误", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private string GetAgentBridgeScript()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 1. Try file in the same directory as executable
            string localPath = Path.Combine(baseDir, "agent_bridge.js");
            if (File.Exists(localPath))
            {
                try { return File.ReadAllText(localPath, Encoding.UTF8); } catch {}
            }

            // 2. Try parent repo directory (development mode)
            string parentPath = Path.Combine(baseDir, "..", "..", "..", "..", "agent_bridge.js");
            if (File.Exists(parentPath))
            {
                try { return File.ReadAllText(parentPath, Encoding.UTF8); } catch {}
            }

            // 3. Fallback to embedded resource
            try
            {
                var assembly = Assembly.GetExecutingAssembly();
                foreach (string name in assembly.GetManifestResourceNames())
                {
                    if (name.EndsWith("agent_bridge.js", StringComparison.OrdinalIgnoreCase))
                    {
                        using var stream = assembly.GetManifestResourceStream(name);
                        if (stream != null)
                        {
                            using var reader = new StreamReader(stream, Encoding.UTF8);
                            return reader.ReadToEnd();
                        }
                    }
                }
            }
            catch {}

            return "";
        }

        private void CoreWebView2_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                var root = doc.RootElement;
                if (!root.TryGetProperty("action", out var actionProp)) return;
                string action = actionProp.GetString() ?? "";

                // Diagnostic: record every bridge message except chatty js-log relays
                if (action != "log") App.Log($"[Bridge] <- action={action}");

                if (action == "log")
                {
                    string msg = root.TryGetProperty("message", out var msgProp) ? msgProp.GetString() ?? "" : "";
                    Trace.WriteLine($"[Agent JS Log] {msg}");
                }
                else if (action == "execute")
                {
                    string cmd = root.TryGetProperty("command", out var cmdProp) ? cmdProp.GetString() ?? "" : "";
                    string id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(cmd) && !string.IsNullOrEmpty(id))
                    {
                        _ = ExecuteLocalCommandAsync(id, cmd);
                    }
                }
                else if (action == "write_file")
                {
                    string path = root.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "";
                    string content = root.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
                    string id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";
                    if (!string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(id))
                    {
                        _ = HandleFileWriteAsync(id, path, content);
                    }
                }
                else if (action == "paths_dropped")
                {
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    if (now - _lastDropTimestamp < 400) return;
                    _lastDropTimestamp = now;

                    var droppedPaths = new System.Collections.Generic.List<string>();
                    if (e.AdditionalObjects != null)
                    {
                        foreach (var obj in e.AdditionalObjects)
                        {
                            if (obj is CoreWebView2FileSystemHandle handle)
                            {
                                if (!string.IsNullOrEmpty(handle.Path)) droppedPaths.Add(handle.Path);
                            }
                            else if (obj is CoreWebView2File file)
                            {
                                if (!string.IsNullOrEmpty(file.Path)) droppedPaths.Add(file.Path);
                            }
                        }
                    }
                    if (root.TryGetProperty("paths", out var pathsProp) && pathsProp.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in pathsProp.EnumerateArray())
                        {
                            string? p = item.GetString();
                            if (!string.IsNullOrEmpty(p)) droppedPaths.Add(p);
                        }
                    }

                    App.Log($"[paths_dropped] Received {droppedPaths.Count} paths from WebView2: {string.Join(", ", droppedPaths)}");
                    if (droppedPaths.Count > 0)
                    {
                        string formatted = FormatPathsForTerminal(droppedPaths);
                        _ = InsertTextToChatAsync(formatted);
                    }
                }
                else if (action == "test_clipboard_paste")
                {
                    TryHandleFileDropClipboardPaste();
                }
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[WebMessage Parse Error]: {ex.Message}");
            }
        }

        private async Task HandleFileWriteAsync(string id, string path, string content)
        {
            try
            {
                string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string projectsDir = Path.Combine(userProfile, "Documents", "Projects");
                string workingDir = Directory.Exists(projectsDir) ? projectsDir : userProfile;

                string resolvedPath = path;
                if (resolvedPath.StartsWith("~"))
                {
                    resolvedPath = Path.Combine(userProfile, resolvedPath.TrimStart('~', '/', '\\'));
                }
                else if (!Path.IsPathRooted(resolvedPath))
                {
                    resolvedPath = Path.Combine(workingDir, resolvedPath);
                }

                string dir = Path.GetDirectoryName(resolvedPath) ?? workingDir;
                Directory.CreateDirectory(dir);

                await File.WriteAllTextAsync(resolvedPath, content, Encoding.UTF8);

                await Dispatcher.InvokeAsync(async () =>
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = 0,
                        output = $"文件已成功直接落盘写入：{resolvedPath}（共 {Encoding.UTF8.GetByteCount(content)} 字节）。"
                    };
                    string json = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
            catch (Exception ex)
            {
                await Dispatcher.InvokeAsync(async () =>
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = 1,
                        output = $"文件写入失败: {ex.Message} (路径: {path})"
                    };
                    string json = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
        }

        private async Task<bool> TryHandleBuiltInCommandAsync(string id, string command)
        {
            string trimmed = command.Trim();
            if (trimmed.Equals("agent-screenshot", StringComparison.OrdinalIgnoreCase) ||
                trimmed.StartsWith("agent-screenshot ", StringComparison.OrdinalIgnoreCase))
            {
                await CaptureScreenAndAttachAsync(id);
                return true;
            }
            if (trimmed.StartsWith("agent-attach ", StringComparison.OrdinalIgnoreCase))
            {
                string rest = trimmed.Substring("agent-attach ".Length).Trim();
                await HandleAgentAttachCommandAsync(id, rest);
                return true;
            }
            return false;
        }

        private async Task CaptureScreenAndAttachAsync(string id)
        {
            try
            {
                int screenWidth = (int)SystemParameters.PrimaryScreenWidth;
                int screenHeight = (int)SystemParameters.PrimaryScreenHeight;

                using var bitmap = new System.Drawing.Bitmap(screenWidth, screenHeight);
                using (var g = System.Drawing.Graphics.FromImage(bitmap))
                {
                    g.CopyFromScreen(0, 0, 0, 0, new System.Drawing.Size(screenWidth, screenHeight));
                }

                string tempPath = Path.Combine(Path.GetTempPath(), $"deepseek_screenshot_{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}.png");
                bitmap.Save(tempPath, System.Drawing.Imaging.ImageFormat.Png);

                byte[] fileBytes = await File.ReadAllBytesAsync(tempPath);
                string b64 = Convert.ToBase64String(fileBytes);
                string filename = Path.GetFileName(tempPath);
                string prompt = "屏幕截图已捕获，请查看附件图片进行分析与判断。";

                await Dispatcher.InvokeAsync(async () =>
                {
                    var attachPayload = new
                    {
                        id = id,
                        exitCode = 0,
                        isAttachment = true,
                        filename = filename,
                        mimeType = "image/png",
                        base64Data = b64,
                        prompt = prompt
                    };
                    string json = JsonSerializer.Serialize(attachPayload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
            catch (Exception ex)
            {
                await Dispatcher.InvokeAsync(async () =>
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = 1,
                        output = $"[错误] 原生截屏失败: {ex.Message}"
                    };
                    string json = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
        }

        private async Task HandleAgentAttachCommandAsync(string id, string arguments)
        {
            try
            {
                string filePath = arguments;
                string prompt = "文件已作为附件挂载，请直接阅读分析。";

                if (filePath.StartsWith("\""))
                {
                    int nextQuote = filePath.IndexOf('\"', 1);
                    if (nextQuote > 0)
                    {
                        string p = filePath.Substring(1, nextQuote - 1);
                        string remaining = filePath.Substring(nextQuote + 1).Trim();
                        filePath = p;
                        if (!string.IsNullOrEmpty(remaining))
                        {
                            prompt = remaining.Trim('\"');
                        }
                    }
                }
                else
                {
                    string[] parts = filePath.Split(new[] { ' ' }, 2, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length > 0) filePath = parts[0];
                    if (parts.Length > 1) prompt = parts[1].Trim('\"');
                }

                string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string projectsDir = Path.Combine(userProfile, "Documents", "Projects");
                string workingDir = Directory.Exists(projectsDir) ? projectsDir : userProfile;

                string resolvedPath = Environment.ExpandEnvironmentVariables(filePath);
                if (resolvedPath.StartsWith("~"))
                {
                    resolvedPath = Path.Combine(userProfile, resolvedPath.TrimStart('~', '/', '\\'));
                }
                else if (!Path.IsPathRooted(resolvedPath))
                {
                    resolvedPath = Path.Combine(workingDir, resolvedPath);
                }

                if (!File.Exists(resolvedPath))
                {
                    throw new FileNotFoundException($"文件不存在: {resolvedPath}");
                }

                byte[] fileBytes = await File.ReadAllBytesAsync(resolvedPath);
                string b64 = Convert.ToBase64String(fileBytes);
                string filename = Path.GetFileName(resolvedPath);
                string mime = GetMimeType(Path.GetExtension(resolvedPath));

                await Dispatcher.InvokeAsync(async () =>
                {
                    var attachPayload = new
                    {
                        id = id,
                        exitCode = 0,
                        isAttachment = true,
                        filename = filename,
                        mimeType = mime,
                        base64Data = b64,
                        prompt = prompt
                    };
                    string json = JsonSerializer.Serialize(attachPayload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
            catch (Exception ex)
            {
                await Dispatcher.InvokeAsync(async () =>
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = 1,
                        output = $"[错误] 挂载附件失败: {ex.Message}"
                    };
                    string json = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }
        }

        /// <summary>
        /// PowerShell serialises its error stream as CLIXML whenever stderr is redirected
        /// (e.g. "#&lt; CLIXML &lt;Objs ...&gt;&lt;S S=\"Error\"&gt;real message&lt;/S&gt;&lt;/Objs&gt;").
        /// That XML then leaked verbatim into the command output the planner reads, burying the
        /// actual message. Unwrap it back to plain text. Note: $ProgressPreference suppression
        /// (applied in the command prefix) removes the progress Obj; error records still need this.
        /// </summary>
        private static string CleanPowerShellStderr(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return raw;
            const string marker = "#< CLIXML";
            string trimmed = raw.TrimStart();
            if (!trimmed.StartsWith(marker, StringComparison.Ordinal)) return raw;
            try
            {
                // NOTE: search for the root element AFTER the marker -- the marker itself
                // contains a '<' ("#<"), so a naive IndexOf('<') lands on that and the parse fails.
                int lt = raw.IndexOf("<Objs", StringComparison.Ordinal);
                if (lt < 0) return trimmed.Substring(marker.Length).Trim();
                var doc = new System.Xml.XmlDocument { XmlResolver = null };
                doc.LoadXml(raw.Substring(lt));

                var sb = new StringBuilder();
                var nodes = doc.SelectNodes("//*[local-name()='S']");
                if (nodes != null)
                {
                    foreach (System.Xml.XmlNode n in nodes) sb.Append(n.InnerText);
                }
                if (sb.Length == 0 && doc.DocumentElement != null) sb.Append(doc.DocumentElement.InnerText);

                string text = sb.ToString()
                    .Replace("_x000D_", "")
                    .Replace("_x000A_", "\n")
                    .Replace("_x0009_", "\t")
                    // CLIXML escapes a literal '_' as _x005F_, so this must be undone LAST:
                    // doing it first could synthesise a fresh _x000A_ that then decodes wrongly.
                    .Replace("_x005F_", "_")
                    .Replace("\r\n", "\n")
                    .Trim();
                return text;
            }
            catch
            {
                // Payload was not well-formed XML -- strip the marker and move on.
                return trimmed.Substring(marker.Length).Trim();
            }
        }

        private async Task ExecuteLocalCommandAsync(string id, string command)
        {
            if (_isExecuting) return;
            _isExecuting = true;

            Console.WriteLine($"[Native Bridge] >>> EXECUTING COMMAND (ID: {id}):\n{command}");

            if (await TryHandleBuiltInCommandAsync(id, command))
            {
                _isExecuting = false;
                return;
            }

            string output = "";
            int exitCode = -1;

            try
            {
                // Execute via powershell.exe using -EncodedCommand for 100% robust cross-platform scripting
                // NOTE: with redirected stderr PowerShell serialises its progress stream as CLIXML
                // (e.g. `<Objs Version="1.1.0.1" ...><Obj S="progress"`), which then leaked into the
                // command output the planner reads. Suppress the progress stream at the source.
                byte[] bytes = Encoding.Unicode.GetBytes("$ProgressPreference='SilentlyContinue'; " + command);
                string base64 = Convert.ToBase64String(bytes);

                var psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {base64}",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };

                string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string projectsDir = Path.Combine(userProfile, "Documents", "Projects");
                psi.WorkingDirectory = Directory.Exists(projectsDir) ? projectsDir : userProfile;

                string localBin = Path.Combine(userProfile, ".local", "bin");
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string programsBin = Path.Combine(appData, "Programs");
                string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.Environment["PATH"] = $"{localBin};{programsBin};{currentPath}";

                using var process = new Process { StartInfo = psi };
                var outSb = new StringBuilder();
                var errSb = new StringBuilder();

                process.OutputDataReceived += (s, e) => { if (e.Data != null) outSb.AppendLine(e.Data); };
                process.ErrorDataReceived += (s, e) => { if (e.Data != null) errSb.AppendLine(e.Data); };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();

                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(180));
                try
                {
                    await process.WaitForExitAsync(cts.Token);
                    exitCode = process.ExitCode;
                }
                catch (OperationCanceledException)
                {
                    try { process.Kill(true); } catch {}
                    exitCode = 124;
                    errSb.AppendLine("【命令执行超时中断 (超过 180 秒)】");
                }

                string outStr = outSb.ToString();
                string errStr = CleanPowerShellStderr(errSb.ToString());

                if (!string.IsNullOrEmpty(outStr)) output += outStr;
                if (!string.IsNullOrEmpty(errStr))
                {
                    if (!string.IsNullOrEmpty(output)) output += "\n";
                    output += "[STDERR]:\n" + errStr;
                }

                if (string.IsNullOrWhiteSpace(output))
                {
                    output = "(命令执行完毕，无终端文字输出)";
                }

                // 1. Check for explicit attach directive: [[AGENT_ATTACH_FILE:filepath:prompt]]
                var match = System.Text.RegularExpressions.Regex.Match(output, @"\[\[AGENT_ATTACH_FILE:(.+?)\]\]");
                if (match.Success)
                {
                    string inner = match.Groups[1].Value;
                    string[] parts = inner.Split(new[] { ':' }, 2);
                    string filePath = parts[0].Trim();
                    string prompt = parts.Length > 1 ? parts[1].Trim() : "";

                    filePath = Environment.ExpandEnvironmentVariables(filePath);
                    if (File.Exists(filePath))
                    {
                        byte[] fileBytes = await File.ReadAllBytesAsync(filePath);
                        string b64 = Convert.ToBase64String(fileBytes);
                        string filename = Path.GetFileName(filePath);
                        string mime = GetMimeType(Path.GetExtension(filePath));

                        await Dispatcher.InvokeAsync(async () =>
                        {
                            var attachPayload = new
                            {
                                id = id,
                                exitCode = exitCode,
                                isAttachment = true,
                                filename = filename,
                                mimeType = mime,
                                base64Data = b64,
                                prompt = prompt
                            };
                            string json = JsonSerializer.Serialize(attachPayload);
                            string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                            await webView.CoreWebView2.ExecuteScriptAsync(js);
                        });
                        return;
                    }
                }

                // 2. Check for oversized terminal output (> 6000 chars) -> auto package as attachment!
                if (output.Length > 6000)
                {
                    string tempFile = Path.Combine(Path.GetTempPath(), $"agent_output_{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}.txt");
                    await File.WriteAllTextAsync(tempFile, output, Encoding.UTF8);
                    byte[] fileBytes = await File.ReadAllBytesAsync(tempFile);
                    string b64 = Convert.ToBase64String(fileBytes);
                    string filename = Path.GetFileName(tempFile);
                    string prompt = $"终端输出内容较长（共 {output.Length} 字符），已自动打包为附件 {filename} 供你直接阅读分析。";

                    await Dispatcher.InvokeAsync(async () =>
                    {
                        var attachPayload = new
                        {
                            id = id,
                            exitCode = exitCode,
                            isAttachment = true,
                            filename = filename,
                            mimeType = "text/plain",
                            base64Data = b64,
                            prompt = prompt
                        };
                        string json = JsonSerializer.Serialize(attachPayload);
                        string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                        await webView.CoreWebView2.ExecuteScriptAsync(js);
                    });
                    return;
                }

                // Smart truncation: keep first 4000 and last 4000 characters
                int maxChars = 8000;
                if (output.Length > maxChars)
                {
                    string head = output.Substring(0, 4000);
                    string tail = output.Substring(output.Length - 4000);
                    output = $"{head}\n\n...[输出过长，已折叠中间 {output.Length - maxChars} 字符]...\n\n{tail}";
                }
            }
            catch (Exception ex)
            {
                exitCode = -1;
                output = $"执行失败: {ex.Message}";
            }
            finally
            {
                _isExecuting = false;
            }

            // Feed result back to WebView2
            await Dispatcher.InvokeAsync(async () =>
            {
                try
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = exitCode,
                        output = output
                    };
                    string jsonString = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({jsonString});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"[FeedResult Error]: {ex.Message}");
                }
            });
        }

        private static string GetMimeType(string ext)
        {
            return ext.ToLowerInvariant() switch
            {
                ".png" => "image/png",
                ".jpg" or ".jpeg" => "image/jpeg",
                ".webp" => "image/webp",
                ".gif" => "image/gif",
                ".svg" => "image/svg+xml",
                ".pdf" => "application/pdf",
                ".json" => "application/json",
                ".csv" => "text/csv",
                ".html" or ".htm" => "text/html",
                ".xml" => "application/xml",
                _ => "text/plain"
            };
        }

        private void CoreWebView2_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri))
            {
                Process.Start(new ProcessStartInfo(uri.ToString()) { UseShellExecute = true });
            }
        }

        private void MenuNewChat_Click(object sender, RoutedEventArgs e)
        {
            webView.CoreWebView2?.Navigate("https://chat.deepseek.com");
        }

        // JS probe: reports bridge install state and every candidate input element on the page
        private const string InjectProbeJs =
            "JSON.stringify({" +
            "hasBridge:!!window.__agentBridge," +
            "installed:!!window.__agentBridgeInstalled," +
            "url:location.href," +
            "rs:document.readyState," +
            "hudBtn:!!document.getElementById('agent-inject-btn')," +
            "textareas:[...document.querySelectorAll('textarea')].map(t=>({id:t.id,cls:String(t.className).slice(0,50),ph:t.placeholder,dis:t.disabled}))," +
            "ces:[...document.querySelectorAll('[contenteditable]')].map(x=>({tag:x.tagName,cls:String(x.className).slice(0,50)}))" +
            "})";

        private async void MenuInjectPrompt_Click(object sender, RoutedEventArgs e)
        {
            if (webView?.CoreWebView2 == null)
            {
                App.Log("[Inject] CoreWebView2 is null - window not ready");
                return;
            }
            try
            {
                string probe = await webView.CoreWebView2.ExecuteScriptAsync(InjectProbeJs);
                App.Log($"[Inject] PROBE {probe}");

                string res = await webView.CoreWebView2.ExecuteScriptAsync(
                    "window.__agentBridge && window.__agentBridge.injectSystemPrompt();");
                App.Log($"[Inject] injectSystemPrompt returned: {res}");

                string after = await webView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){var t=document.querySelector('textarea');return JSON.stringify({len: t?t.value.length:-1, head: t?t.value.slice(0,80):null});})()");
                App.Log($"[Inject] AFTER {after}");
            }
            catch (Exception ex)
            {
                App.Log($"[Inject] ERROR {ex}");
            }
        }

        private void MenuReload_Click(object sender, RoutedEventArgs e)
        {
            webView.CoreWebView2?.Reload();
        }

        private async void MenuForceReload_Click(object sender, RoutedEventArgs e)
        {
            if (webView.CoreWebView2 != null)
            {
                await webView.CoreWebView2.ExecuteScriptAsync("location.reload(true);");
            }
        }

        public void SetZoom(double factor)
        {
            factor = Math.Round(Math.Clamp(factor, 0.4, 2.5), 2);
            if (webView?.CoreWebView2 != null)
            {
                webView.ZoomFactor = factor;
            }
            UpdateZoomDisplay(factor);
            SaveZoomFactor(factor);
        }

        private void UpdateZoomDisplay(double factor)
        {
            if (btnZoomFactor != null)
            {
                btnZoomFactor.Content = $"{Math.Round(factor * 100)}%";
            }
        }

        private void MenuZoomIn_Click(object sender, RoutedEventArgs e)
        {
            double current = webView?.ZoomFactor ?? 1.0;
            SetZoom(current + 0.1);
        }

        private void MenuZoomOut_Click(object sender, RoutedEventArgs e)
        {
            double current = webView?.ZoomFactor ?? 1.0;
            SetZoom(current - 0.1);
        }

        private void MenuZoomReset_Click(object sender, RoutedEventArgs e)
        {
            SetZoom(1.0);
        }

        private void MenuZoomFit_Click(object sender, RoutedEventArgs e)
        {
            SetZoom(0.85);
        }

        private static string GetSettingsFilePath()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string folder = Path.Combine(appData, "DeepSeek");
            Directory.CreateDirectory(folder);
            return Path.Combine(folder, "client_settings.json");
        }

        private static double LoadSavedZoomFactor()
        {
            try
            {
                string file = GetSettingsFilePath();
                if (File.Exists(file))
                {
                    string json = File.ReadAllText(file);
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("zoomFactor", out var zProp) && zProp.TryGetDouble(out var z))
                    {
                        if (z >= 0.4 && z <= 2.5) return z;
                    }
                }
            }
            catch {}

            // Screen resolution heuristics: 1280x800 and 1366x768 screens benefit from 85% zoom
            if (SystemParameters.PrimaryScreenWidth <= 1366)
            {
                return 0.85;
            }
            return 1.0;
        }

        private static void SaveZoomFactor(double factor)
        {
            try
            {
                string file = GetSettingsFilePath();
                var dict = new System.Collections.Generic.Dictionary<string, object>
                {
                    ["zoomFactor"] = Math.Round(factor, 2)
                };
                File.WriteAllText(file, JsonSerializer.Serialize(dict));
            }
            catch {}
        }

        private void ComponentDispatcher_ThreadPreprocessMessage(ref MSG msg, ref bool handled)
        {
            const int WM_KEYDOWN = 0x0100;
            if (msg.message == WM_KEYDOWN)
            {
                bool ctrl = (Keyboard.Modifiers & ModifierKeys.Control) != 0;
                bool shift = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
                int vk = (int)msg.wParam;

                if (ctrl)
                {
                    // 'V' (0x56) - Terminal-style file path paste
                    if (vk == 0x56)
                    {
                        if (TryHandleFileDropClipboardPaste())
                        {
                            handled = true;
                            return;
                        }
                    }
                    // VK_OEM_MINUS (189) or VK_SUBTRACT (109)
                    else if (vk == 0xBD || vk == 0x6D)
                    {
                        MenuZoomOut_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                    // VK_OEM_PLUS (187) or VK_ADD (107)
                    else if (vk == 0xBB || vk == 0x6B)
                    {
                        MenuZoomIn_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                    // '0' (48) or VK_NUMPAD0 (96)
                    else if (vk == 0x30 || vk == 0x60)
                    {
                        MenuZoomReset_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                    // 'I' (73)
                    else if (vk == 0x49)
                    {
                        MenuInjectPrompt_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                    // 'N' (78)
                    else if (vk == 0x4E)
                    {
                        MenuNewChat_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                    // 'R' (82)
                    else if (vk == 0x52)
                    {
                        if (shift)
                            MenuForceReload_Click(this, new RoutedEventArgs());
                        else
                            MenuReload_Click(this, new RoutedEventArgs());
                        handled = true;
                    }
                }
                else if (shift && vk == 0x2D) // Shift + VK_INSERT
                {
                    if (TryHandleFileDropClipboardPaste())
                    {
                        handled = true;
                        return;
                    }
                }
            }
        }

        private void Window_PreviewDragOver(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                e.Effects = DragDropEffects.Copy;
                e.Handled = true;
            }
        }

        private async void Window_PreviewDrop(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (now - _lastDropTimestamp < 400)
                {
                    e.Handled = true;
                    return;
                }
                _lastDropTimestamp = now;

                string[]? files = e.Data.GetData(DataFormats.FileDrop) as string[];
                if (files != null && files.Length > 0)
                {
                    e.Handled = true;
                    App.Log($"[WPF Drop] Received {files.Length} files: {string.Join(", ", files)}");
                    string formatted = FormatPathsForTerminal(files);
                    await InsertTextToChatAsync(formatted);
                }
            }
        }

        public static string FormatPathsForTerminal(System.Collections.Generic.IEnumerable<string> paths)
        {
            var list = new System.Collections.Generic.List<string>();
            foreach (var p in paths)
            {
                if (string.IsNullOrWhiteSpace(p)) continue;
                string path = p.Trim();
                if (path.StartsWith("\"") && path.EndsWith("\"") && path.Length >= 2)
                {
                    path = path.Substring(1, path.Length - 2).Trim();
                }
                if (path.Contains(' '))
                {
                    list.Add($"\"{path}\"");
                }
                else
                {
                    list.Add(path);
                }
            }
            if (list.Count == 0) return "";
            return string.Join(" ", list) + " ";
        }

        public async Task<bool> InsertTextToChatAsync(string text)
        {
            if (string.IsNullOrEmpty(text) || webView?.CoreWebView2 == null) return false;

            try
            {
                string json = JsonSerializer.Serialize(text);
                string script = $"window.__agentBridge && window.__agentBridge.insertText ? window.__agentBridge.insertText({json}) : false;";
                string res = await webView.CoreWebView2.ExecuteScriptAsync(script);
                App.Log($"[InsertTextToChat] Inserted text length={text.Length}, result: {res}");
                return res == "true";
            }
            catch (Exception ex)
            {
                App.Log($"[InsertTextToChat] Error: {ex.Message}");
                return false;
            }
        }

        private bool TryHandleFileDropClipboardPaste()
        {
            try
            {
                if (Clipboard.ContainsFileDropList())
                {
                    var dropList = Clipboard.GetFileDropList();
                    if (dropList != null && dropList.Count > 0)
                    {
                        var paths = new System.Collections.Generic.List<string>();
                        foreach (string? p in dropList)
                        {
                            if (!string.IsNullOrWhiteSpace(p)) paths.Add(p);
                        }
                        if (paths.Count > 0)
                        {
                            App.Log($"[Clipboard Paste] File drop detected ({paths.Count} items): {string.Join(", ", paths)}");
                            string formatted = FormatPathsForTerminal(paths);
                            _ = InsertTextToChatAsync(formatted);
                            return true;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                App.Log($"[Clipboard Paste] Error checking clipboard: {ex.Message}");
            }
            return false;
        }

        private void MenuExit_Click(object sender, RoutedEventArgs e)
        {
            Close();
        }

        private void MenuAbout_Click(object sender, RoutedEventArgs e)
        {
            MessageBox.Show("DeepSeek for Windows (Agent Closed-Loop Edition)\n版本: 1.0.0\n基于 .NET 8 + Microsoft Edge WebView2", "关于 DeepSeek", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private void MenuGitHub_Click(object sender, RoutedEventArgs e)
        {
            Process.Start(new ProcessStartInfo("https://github.com/moxiuren/deepseek-mac") { UseShellExecute = true });
        }
    }
}
