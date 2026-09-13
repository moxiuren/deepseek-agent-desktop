using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Reflection;
using System.Runtime.InteropServices;
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
    // Pass-through cmdlet for live streaming: forwards each pipeline object's
    // text to the tool card immediately, then passes the object downstream
    // untouched (Out-String still does the final formatted rendering).
    // Needed because Format*/Out-String buffer until upstream completes.
    [Cmdlet("Write", "LiveStream")]
    public sealed class LiveStreamCmdlet : Cmdlet
    {
        public static Action<string>? Sink;

        [Parameter(ValueFromPipeline = true)]
        public PSObject? InputObject { get; set; }

        protected override void ProcessRecord()
        {
            var o = InputObject;
            try { Sink?.Invoke(o?.ToString() ?? ""); } catch { }
            WriteObject(o);
        }
    }

    public partial class MainWindow : Window
    {
        // Serialize native executions: concurrent dispatches QUEUE on this gate
        // instead of being silently dropped (a drop leaves the planner waiting
        // forever and misattributes later results).
        private readonly SemaphoreSlim _execGate = new(1, 1);
        private long _lastDropTimestamp = 0;
        private long _lastInjectTicks = 0;

        // DSX built-in plugin host (native; no CDP / no debug port / no external process)
        private PluginHost? _pluginHost;

        // Persistent runspace: kills per-command powershell.exe spawn (~200-500ms each).
        // Session persists across commands (cwd, variables, $env:), commands stay serialized via _execGate.
        private Runspace? _runspace;
        private readonly object _poolLock = new();
        private readonly DeepSeekApiClient _apiClient = new();

        private Runspace GetRunspace()
        {
            lock (_poolLock)
            {
                if (_runspace != null &&
                    _runspace.RunspaceStateInfo.State != RunspaceState.Opened)
                {
                    try { _runspace.Dispose(); } catch {}
                    _runspace = null;
                }
                if (_runspace != null) return _runspace;

                string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                string projectsDir = Path.Combine(userProfile, "Documents", "Projects");
                string workingDir = Directory.Exists(projectsDir) ? projectsDir : userProfile;
                string localBin = Path.Combine(userProfile, ".local", "bin");
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string programsBin = Path.Combine(appData, "Programs");

                var iss = InitialSessionState.CreateDefault();
                iss.ExecutionPolicy = Microsoft.PowerShell.ExecutionPolicy.Bypass;
                iss.Commands.Add(new SessionStateCmdletEntry("Write-LiveStream", typeof(LiveStreamCmdlet), null));
                var rs = RunspaceFactory.CreateRunspace(iss);
                rs.Open();

                // One-time session setup (persists for all later commands)
                try
                {
                    using var init = System.Management.Automation.PowerShell.Create();
                    init.Runspace = rs;
                    Func<string, string> q = s => "'" + s.Replace("'", "''") + "'";
                    init.AddScript($"Set-Location -LiteralPath {q(workingDir)}; $env:PATH = {q(localBin)} + ';' + {q(programsBin)} + ';' + $env:PATH");
                    init.Invoke();
                    init.Streams.ClearStreams();
                }
                catch (Exception ex)
                {
                    App.Log($"[Runspace] init script warning: {ex.Message}");
                }

                App.Log($"[Runspace] persistent runspace opened (cwd={workingDir})");
                _runspace = rs;
                return rs;
            }
        }

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

            // Low-level keyboard hook: WebView2's native child window bypasses the
            // WPF dispatcher pump, so ComponentDispatcher never sees keys pressed
            // while the page has focus. WH_KEYBOARD_LL sees them system-wide; we
            // only act when OUR window is foreground, everyone else unaffected.
            _llHookProc = LowLevelKeyboardProc;
            _llHookId = SetWindowsHookEx(WH_KEYBOARD_LL, _llHookProc, GetModuleHandle(null), 0);
            App.Log($"LL keyboard hook installed: {_llHookId != IntPtr.Zero}");

            Loaded += MainWindow_Loaded;
            Closed += (s, e) =>
            {
                try { if (_llHookId != IntPtr.Zero) { UnhookWindowsHookEx(_llHookId); _llHookId = IntPtr.Zero; } } catch {}
                try { lock (_poolLock) { _runspace?.Dispose(); _runspace = null; } } catch {}
                try { _apiClient.Dispose(); } catch {}
            };
            App.Log("MainWindow.ctor exit");
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool ChangeWindowMessageFilterEx(IntPtr hWnd, uint msg, uint action, IntPtr pChangeFilterStruct);

        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN_LL = 0x0100;
        private const int WM_SYSKEYDOWN_LL = 0x0104;
        private const int VK_CONTROL_LL = 0x11;
        private const int VK_I_LL = 0x49;

        private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetModuleHandle(string? lpModuleName);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        private HookProc? _llHookProc;
        private IntPtr _llHookId = IntPtr.Zero;

        private IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN_LL || wParam == (IntPtr)WM_SYSKEYDOWN_LL))
                {
                    int vk = Marshal.ReadInt32(lParam);
                    if (vk == VK_I_LL && (GetAsyncKeyState(VK_CONTROL_LL) & 0x8000) != 0)
                    {
                        var mine = new WindowInteropHelper(this).Handle;
                        if (mine != IntPtr.Zero && GetForegroundWindow() == mine)
                        {
                            App.Log("[Hotkey] Ctrl+I intercepted (llhook)");
                            Dispatcher.BeginInvoke(new Action(() => MenuInjectPrompt_Click(this, new RoutedEventArgs())));
                            return (IntPtr)1;
                        }
                    }
                }
            }
            catch {}
            return CallNextHookEx(_llHookId, nCode, wParam, lParam);
        }

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

                // Inject api_sniff.js FIRST (read-only fetch/XHR sniffer, must wrap before page scripts run)
                // Dev-only: skipped entirely unless diagnostics are enabled (env/file flag, see App).
                if (App.DiagnosticsEnabled)
                {
                    string sniffScript = GetApiSniffScript();
                    if (!string.IsNullOrEmpty(sniffScript))
                    {
                        await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(sniffScript);
                        App.Log($"api_sniff.js script registered ({sniffScript.Length} chars)");
                    }
                    else
                    {
                        App.Log("[WARN] api_sniff.js not found, sniffer disabled");
                    }
                }
                else
                {
                    App.Log("api_sniff skipped (diagnostics off)");
                }

                // Inject agent_bridge.js on document created (guarantees execution on all page loads)
                string bridgeScript = GetAgentBridgeScript();
                if (!string.IsNullOrEmpty(bridgeScript))
                {
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
                    App.Log($"agent_bridge.js script registered ({bridgeScript.Length} chars)");
                }

                // Inject DSX plugin runtime on document created (auto-restores after any navigation).
                // Plugins themselves are loaded by PluginHost once the DOM is ready (poll loop).
                string runtimeScript = GetPluginRuntimeScript();
                if (!string.IsNullOrEmpty(runtimeScript))
                {
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(runtimeScript);
                    App.Log($"DSX plugin runtime registered ({runtimeScript.Length} chars)");
                }

                // Start the DSX built-in plugin host (watches Documents\DeepSeek-Agent\plugins).
                try
                {
                    _pluginHost = new PluginHost(EvalInUi, PluginHost.ResolvePluginDir());
                    _pluginHost.Start();
                }
                catch (Exception ex)
                {
                    App.Log($"[DSX] plugin host start failed: {ex.Message}");
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

        private string GetApiSniffScript()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 1. Try file in the same directory as executable
            string localPath = Path.Combine(baseDir, "api_sniff.js");
            if (File.Exists(localPath))
            {
                try { return File.ReadAllText(localPath, Encoding.UTF8); } catch {}
            }

            // 2. Try repo root (development mode)
            string parentPath = Path.Combine(baseDir, "..", "..", "..", "..", "api_sniff.js");
            if (File.Exists(parentPath))
            {
                try { return File.ReadAllText(parentPath, Encoding.UTF8); } catch {}
            }

            return "";
        }

        /// <summary>Marshals CoreWebView2.ExecuteScriptAsync onto the UI thread (thread-affine).</summary>
        private Task<string> EvalInUi(string js)
        {
            try
            {
                return Dispatcher.InvokeAsync(() => webView.CoreWebView2.ExecuteScriptAsync(js)).Task.Unwrap();
            }
            catch (Exception ex)
            {
                App.Log($"[DSX] eval marshal failed: {ex.Message}");
                return Task.FromResult("");
            }
        }

        private string GetPluginRuntimeScript()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 1. Try runtime\plugin-loader.js next to executable (shipped with install)
            string localPath = Path.Combine(baseDir, "runtime", "plugin-loader.js");
            if (File.Exists(localPath))
            {
                try { return File.ReadAllText(localPath, Encoding.UTF8); } catch {}
            }

            // 2. Try repo runtime directory (development mode)
            string repoPath = Path.Combine(baseDir, "..", "..", "..", "..", "windows", "runtime", "plugin-loader.js");
            if (File.Exists(repoPath))
            {
                try { return File.ReadAllText(repoPath, Encoding.UTF8); } catch {}
            }

            // 3. Try the standalone DSX repo (legacy dev layout)
            string dsxPath = @"C:\Users\Admin\Documents\Projects\deepseek-agent-plugins\runtime\plugin-loader.js";
            if (File.Exists(dsxPath))
            {
                try { return File.ReadAllText(dsxPath, Encoding.UTF8); } catch {}
            }

            return "";
        }

        private async void CoreWebView2_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
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
                else if (action == "attachdiag")
                {
                    // Attachment-readiness signal diagnostics (dev only, dropped in trial builds)
                    if (!App.DiagnosticsEnabled) return;
                    var parts = new System.Collections.Generic.List<string>();
                    foreach (var prop in root.EnumerateObject())
                    {
                        if (prop.Name == "action") continue;
                        parts.Add($"{prop.Name}={prop.Value}");
                    }
                    App.Log($"[ATTACHDIAG] {string.Join(" ", parts)}");
                }
                else if (action == "crashwatch")
                {
                    // Site tamper/crash page forensics (always logged, even in trial builds)
                    string url = root.TryGetProperty("url", out var cu) ? (cu.GetString() ?? "") : "";
                    string lastAction = root.TryGetProperty("lastAction", out var la) ? (la.GetString() ?? "") : "";
                    string ours = root.TryGetProperty("ours", out var o) ? o.GetString() ?? "" : "";
                    App.Log($"[CRASHWATCH] whale page visible url={url} lastAction={lastAction} ours={ours}");
                }
                else if (action == "plugins")
                {
                    // DSX plugin host diagnostics (list loaded plugins / runtime errors)
                    if (_pluginHost == null)
                    {
                        App.Log("[DSX] plugin host not started");
                        return;
                    }
                    var st = await _pluginHost.StatusAsync();
                    App.Log($"[DSX] status={(st.HasValue ? st.Value.GetRawText() : "unavailable")}");
                }
                else if (action == "apisniff")
                {
                    // Read-only network sniffer records (local log only, never leaves the machine)
                    string side = root.TryGetProperty("side", out var s) ? s.GetString() ?? "" : "";
                    string method = root.TryGetProperty("method", out var m) ? m.GetString() ?? "" : "";
                    string url = root.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "";
                    string status = root.TryGetProperty("status", out var st) ? st.ToString() : "";
                    string ct = root.TryGetProperty("contentType", out var c) ? c.GetString() ?? "" : "";
                    string bodyKind = "", bodyPrev = "";
                    if (root.TryGetProperty("body", out var b) && b.ValueKind == JsonValueKind.Object)
                    {
                        if (b.TryGetProperty("kind", out var k)) bodyKind = k.GetString() ?? "";
                        if (b.TryGetProperty("preview", out var p)) bodyPrev = (p.GetString() ?? "").Replace("\r", " ").Replace("\n", " ");
                        else if (b.TryGetProperty("fields", out var f)) bodyPrev = string.Join(",", f.EnumerateArray().Select(x => x.GetString()));
                        else if (b.TryGetProperty("len", out var l)) bodyPrev = $"len={l}";
                    }
                    if (bodyPrev.Length > 1500 && (url.Contains("/api/v0/chat/completion") || url.Contains("/api/v0/file/upload_file")))
                        bodyPrev = bodyPrev.Substring(0, 12000) + "...[truncated]";
                    else if (bodyPrev.Length > 1500) bodyPrev = bodyPrev.Substring(0, 1500) + "...[truncated]";
                    string hnames = "";
                    if (root.TryGetProperty("headerNames", out var h) && h.ValueKind == JsonValueKind.Array)
                        hnames = string.Join(",", h.EnumerateArray().Select(x => x.GetString()));
                    string resBody = root.TryGetProperty("resBody", out var rb) ? ((rb.GetString() ?? "").Replace("\r", " ").Replace("\n", " ")) : "";
                    if (resBody.Length > 2000) resBody = resBody.Substring(0, 2000) + "...[truncated]";
                    App.Log($"[APISNIFF] {side} {method} {url} status={status} ct={ct} bodyKind={bodyKind} {bodyPrev} hnames=[{hnames}] resBody={resBody}");

                    // Track session/parent ids ONLY from real completion requests.
                    // Telemetry bodies carry unrelated message ids (e.g. 1) that are
                    // not valid parents and fork/break the thread server-side.
                    try
                    {
                        if (url.Contains("/api/v0/chat/completion") && root.TryGetProperty("body", out var bElem) && bElem.ValueKind == JsonValueKind.Object && bElem.TryGetProperty("preview", out var rawPrev))
                        {
                            string raw = rawPrev.GetString() ?? "";
                            if (raw.Contains("\"chat_session_id\""))
                            {
                                using var jd = JsonDocument.Parse(raw);
                                if (jd.RootElement.TryGetProperty("chat_session_id", out var sid))
                                    _apiClient.UpdateSessionState(sid.GetString(), null);
                                if (jd.RootElement.TryGetProperty("parent_message_id", out var pid) && pid.ValueKind == JsonValueKind.Number)
                                    _apiClient.UpdateSessionState(null, pid.GetInt32());
                            }
                        }
                    }
                    catch {}
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
            async Task RejectWriteAsync(string reason)
            {
                await Dispatcher.InvokeAsync(async () =>
                {
                    var payload = new { id = id, exitCode = 1, output = reason };
                    string json = JsonSerializer.Serialize(payload);
                    string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({json});";
                    await webView.CoreWebView2.ExecuteScriptAsync(js);
                });
            }

            // Depth defense: reject UI-residue paths and suspicious near-empty writes.
            // Rejections ALWAYS feed back (never silent) so the planner can adjust.
            if (path.Contains("CopyDownload"))
            {
                App.Log($"[write_file] 路径污染拦截: {path}");
                await RejectWriteAsync($"[拒绝写入] 路径疑似携带页面按钮残留文本: {path}。请检查 fence 标注后重试，或改用 local_cmd 写入。");
                return;
            }
            if ((content?.Length ?? 0) < 8 && !path.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
            {
                App.Log($"[write_file] 拒绝可疑空写入: {path} (content {content?.Length ?? 0} chars)");
                await RejectWriteAsync($"[拒绝写入] 内容过短({content?.Length ?? 0} 字符)且目标非 .txt：{path}。若确需写入请改用 local_cmd，或分步确认后重试。");
                return;
            }

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

                await File.WriteAllTextAsync(resolvedPath, content, new UTF8Encoding(false));

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

        private static string FormatErrorRecord(ErrorRecord e)
        {
            string msg = e.ErrorDetails?.Message ?? e.Exception?.Message ?? e.ToString();
            string at = e.InvocationInfo?.Line?.Trim() ?? "";
            if (!string.IsNullOrEmpty(at) && !msg.Contains(at))
                msg += $" (at: {at})";
            return msg;
        }

        // Scan discipline guard: unbounded recursive scans of huge roots take
        // minutes and always die at the 180s timeout. Reject with guidance so
        // the planner learns in one round. Escape hatch: #scan-ok comment.
        private static string? CheckScanDiscipline(string command, string userProfile)
        {
            string n = System.Text.RegularExpressions.Regex.Replace(
                command.ToLowerInvariant(), @"\s+", " ").Trim();
            if (n.Contains("#scan-ok")) return null;
            bool hasCmdlet = System.Text.RegularExpressions.Regex.IsMatch(n, @"\bget-childitem\b")
                || System.Text.RegularExpressions.Regex.IsMatch(n, @"(?:^|[;|&({\[])\s*(gci|dir|ls)\b");
            if (!hasCmdlet || !System.Text.RegularExpressions.Regex.IsMatch(n, @"-rec\w*")) return null;
            if (System.Text.RegularExpressions.Regex.IsMatch(n, @"-depth\s+\d+")) return null;

            string up = userProfile.ToLowerInvariant().TrimEnd('\\');
            string upRx = System.Text.RegularExpressions.Regex.Escape(up);
            bool hitsRoot =
                System.Text.RegularExpressions.Regex.IsMatch(n, upRx + @"(?=[""'\s]|$)") ||
                System.Text.RegularExpressions.Regex.IsMatch(n, @"[a-z]:\\(?=[""'\s]|$)") ||
                n.Contains("c:\\windows") || n.Contains("c:\\program files") ||
                n.Contains("$env:systemroot") || n.Contains("$env:windir") || n.Contains("$env:programfiles") ||
                n.Contains("~\"") || n.Contains("~'") || n.Contains("~ ") || n.EndsWith("~") ||
                n.Contains("$home\"") || n.Contains("$home'") || n.Contains("$home ") || n.EndsWith("$home") ||
                n.Contains("$env:userprofile\"") || n.Contains("$env:userprofile'") ||
                n.Contains("%userprofile%") ||
                n.Contains("hkcu:") || n.Contains("hklm:") || n.Contains("hkcr:") ||
                n.Contains("hku:") || n.Contains("hkcc:") || n.Contains("cert:") || n.Contains("wsman:");
            if (!hitsRoot) return null;

            string head = command.Length > 200 ? command.Substring(0, 200) + "..." : command;
            return "[本地安全护栏拦截，未执行] 无深度限制的大目录递归扫描通常跑几分钟且会被 180 秒超时砍掉。\n"
                + "规则：对用户目录根、盘符根、Windows/Program Files、注册表/证书区递归必须带 -Depth（建议≤3）；优先查 Desktop、Documents、Projects，禁扫 AppData。\n"
                + "改法示例：Get-ChildItem \"" + userProfile + "\\Documents\" -Recurse -Depth 3 -Filter \"*关键词*\" -ErrorAction SilentlyContinue\n"
                + "确需全量扫描时，在命令任意位置加注释 #scan-ok 豁免。\n"
                + "原命令：" + head;
        }

        private async Task ExecuteLocalCommandAsync(string id, string command)
        {
            // Scan discipline first: instant reject, never consumes queue slots.
            string userProfileDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string? disciplineMsg = CheckScanDiscipline(command, userProfileDir);
            if (disciplineMsg != null)
            {
                App.Log($"[ScanGuard] rejected: {command.Substring(0, Math.Min(120, command.Length))}");
                await Dispatcher.InvokeAsync(async () =>
                {
                    try
                    {
                        var payload = new { id = id, exitCode = 1, output = disciplineMsg };
                        string jsonString = JsonSerializer.Serialize(payload);
                        string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({jsonString});";
                        await webView.CoreWebView2.ExecuteScriptAsync(js);
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"[FeedResult Error]: {ex.Message}");
                    }
                });
                return;
            }

            bool gateTaken = false;
            try { gateTaken = await _execGate.WaitAsync(TimeSpan.FromSeconds(120)); } catch { gateTaken = false; }
            if (!gateTaken)
            {
                string qOut = "【本地执行排队超时（120 秒），上一条命令仍在运行，请稍后重试】";
                await Dispatcher.InvokeAsync(async () =>
                {
                    try
                    {
                        var payload = new { id = id, exitCode = 124, output = qOut };
                        string jsonString = JsonSerializer.Serialize(payload);
                        string js = $"window.__agentBridge && window.__agentBridge.onCommandResult({jsonString});";
                        await webView.CoreWebView2.ExecuteScriptAsync(js);
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"[FeedResult Error]: {ex.Message}");
                    }
                });
                return;
            }

            try
            {
                Console.WriteLine($"[Native Bridge] >>> EXECUTING COMMAND (ID: {id}):\n{command}");

                if (await TryHandleBuiltInCommandAsync(id, command))
                {
                    return;
                }

            string output = "";
            int exitCode = -1;

            try
            {
                // Persistent runspace execution: no powershell.exe spawn per command.
                // Out-String -Stream keeps console-like formatting; error stream mirrors old STDERR split.
                var runspace = GetRunspace();
                var outSb = new StringBuilder();
                var errSb = new StringBuilder();
                bool hadErrors = false;

                using var ps = System.Management.Automation.PowerShell.Create();
                ps.Runspace = runspace;
                ps.AddScript("$ProgressPreference='SilentlyContinue'; " + command);
                // Live tap BEFORE Out-String: Write-LiveStream forwards each object's
                // text immediately (Out-String would buffer until upstream completes).
                ps.AddCommand("Write-LiveStream");
                ps.AddCommand("Out-String").AddParameter("Width", 1024).AddParameter("Stream", true);

                // Live streaming: push each output/error line to the tool card as it
                // arrives (capped; the final result stays authoritative).
                int streamedChunks = 0;
                const int MaxStreamChunks = 1000;
                void StreamChunk(string chunk)
                {
                    if (string.IsNullOrEmpty(chunk)) return;
                    int n = Interlocked.Increment(ref streamedChunks);
                    if (n > MaxStreamChunks) return;
                    if (n == MaxStreamChunks)
                        chunk += "\n[实时流达到上限，后续输出完成后统一显示]";
                    string capturedId = id;
                    _ = Dispatcher.InvokeAsync(async () =>
                    {
                        for (int attempt = 0; attempt < 2; attempt++)
                        {
                            try
                            {
                                if (webView?.CoreWebView2 == null) return;
                                string payload = JsonSerializer.Serialize(new { id = capturedId, chunk = chunk });
                                await webView.CoreWebView2.ExecuteScriptAsync(
                                    $"window.__agentBridge && window.__agentBridge.onCommandStream({payload});");
                                return;
                            }
                            catch
                            {
                                if (attempt == 0) { try { await Task.Delay(300); } catch { } }
                            }
                        }
                    });
                }
                // Live tap sink (executions are serialized, one at a time).
                LiveStreamCmdlet.Sink = line => { if (!string.IsNullOrEmpty(line)) StreamChunk(line); };
                var outputCol = new PSDataCollection<PSObject>();
                outputCol.DataAdded += (sender, e) =>
                {
                    string? line = null;
                    try { line = ((PSDataCollection<PSObject>)sender)[e.Index]?.ToString(); } catch { return; }
                    if (!string.IsNullOrEmpty(line)) StreamChunk(line);
                };
                ps.Streams.Error.DataAdded += (sender, e) =>
                {
                    string msg;
                    try { msg = FormatErrorRecord(((PSDataCollection<ErrorRecord>)sender)[e.Index]); }
                    catch { return; }
                    StreamChunk("[STDERR] " + msg);
                };

                System.Collections.Generic.IList<PSObject>? results = null;
                Exception? invokeEx = null;
                var invokeTask = Task.Run(() =>
                {
                    IAsyncResult ar;
                    try { ar = ps.BeginInvoke<PSObject, PSObject>(null, outputCol); }
                    catch (Exception ex) { invokeEx = ex; results = outputCol; return; }
                    try
                    {
                        // Wait indefinitely here; the outer 180s timeout stops the pipeline.
                        // Stop() unblocks this and EndInvoke surfaces partial output.
                        ar.AsyncWaitHandle.WaitOne();
                        try { ps.EndInvoke(ar); }
                        catch (Exception ex) { invokeEx = ex; }
                    }
                    finally { results = outputCol; }
                });
                var finished = await Task.WhenAny(invokeTask, Task.Delay(TimeSpan.FromSeconds(180)));
                bool timedOut = finished != invokeTask;
                if (timedOut)
                {
                    try { ps.Stop(); } catch { }
                    try { await invokeTask.WaitAsync(TimeSpan.FromSeconds(10)); } catch { }
                    exitCode = 124;
                    // Keep partial output captured before the stop.
                    if (results != null)
                    {
                        foreach (var o in results)
                        {
                            if (o != null) outSb.AppendLine(o.ToString());
                        }
                    }
                    foreach (var e in ps.Streams.Error)
                    {
                        errSb.AppendLine(FormatErrorRecord(e));
                    }
                    errSb.AppendLine("【命令执行超时中断 (超过 180 秒)】");
                }
                else
                {
                    await invokeTask;
                    if (invokeEx != null)
                    {
                        hadErrors = true;
                        errSb.AppendLine(invokeEx.Message);
                    }
                    if (results != null)
                    {
                        foreach (var o in results)
                        {
                            if (o != null) outSb.AppendLine(o.ToString());
                        }
                    }
                    if (ps.HadErrors) hadErrors = true;
                    foreach (var e in ps.Streams.Error)
                    {
                        hadErrors = true;
                        errSb.AppendLine(FormatErrorRecord(e));
                    }
                    exitCode = hadErrors ? 1 : 0;
                }
                LiveStreamCmdlet.Sink = null;

                string outStr = outSb.ToString();
                string errStr = errSb.ToString();

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
                        if (fileBytes.Length <= MaxUploadBytes)
                        {
                            string b64 = Convert.ToBase64String(fileBytes);
                            string filename = Path.GetFileName(filePath);
                            string mime = GetMimeType(Path.GetExtension(filePath));

                            await FeedResultBackAsync(id, exitCode, output, isAttachment: true, filename: filename, mimeType: mime, base64Data: b64, prompt: prompt);
                        }
                        else
                        {
                            // Too big to upload: keep on local disk, reference by path.
                            string fullText = File.Exists(filePath) ? await File.ReadAllTextAsync(filePath, Encoding.UTF8) : "";
                            var (fbOut, fbPrompt, _) = await HandleOversizedOutputAsync(string.IsNullOrEmpty(fullText) ? output : fullText);
                            string note = prompt + "\n\n" + fbPrompt;
                            await FeedResultBackAsync(id, exitCode, fbOut, isAttachment: false, prompt: note);
                        }
                        return;
                    }
                }

                // 2. Check for oversized terminal output (> 6000 chars) -> auto package as attachment!
                if (output.Length > 6000)
                {
                    int bytesLen = Encoding.UTF8.GetByteCount(output);
                    if (bytesLen <= MaxUploadBytes)
                    {
                        string tempFile = Path.Combine(Path.GetTempPath(), $"agent_output_{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}.txt");
                        await File.WriteAllTextAsync(tempFile, output, Encoding.UTF8);
                        byte[] fileBytes = await File.ReadAllBytesAsync(tempFile);
                        string b64 = Convert.ToBase64String(fileBytes);
                        string filename = Path.GetFileName(tempFile);
                        string prompt = $"终端输出内容较长（共 {output.Length} 字符），已自动打包为附件 {filename} 供你直接阅读分析。";

                        await FeedResultBackAsync(id, exitCode, output, isAttachment: true, filename: filename, mimeType: "text/plain", base64Data: b64, prompt: prompt);
                    }
                    else
                    {
                        var (fbOut, fbPrompt, _) = await HandleOversizedOutputAsync(output);
                        await FeedResultBackAsync(id, exitCode, fbOut, isAttachment: false, prompt: fbPrompt);
                    }
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
                LiveStreamCmdlet.Sink = null;
                output = $"执行失败: {ex.Message}";
                App.Log($"[Execute] FAILED id={id} cmd-head={command.Substring(0, Math.Min(120, command.Length))} ex={ex}");
            }

            // Feed result back (direct API send if enabled, otherwise fallback to web input box)
            await FeedResultBackAsync(id, exitCode, output);
            }
            finally
            {
                LiveStreamCmdlet.Sink = null;
                if (gateTaken) { try { _execGate.Release(); } catch {} }
            }
        }

        // DeepSeek's frontend React ErrorBoundary crashes when rendering uploaded
        // attachments near ~10MB (shows the extension "whale" page). Cap uploads.
        private const int MaxUploadBytes = 5 * 1024 * 1024;

        // Shared helper: keeps huge payloads off the site (crashes its renderer) by
        // writing them to the local Projects dir and returning a head+tail summary.
        private async Task<(string FeedbackOutput, string Prompt, string? LocalPath)> HandleOversizedOutputAsync(string output)
        {
            string localDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Projects");
            Directory.CreateDirectory(localDir);
            string localPath = Path.Combine(localDir, $"agent_output_{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}.txt");
            await File.WriteAllTextAsync(localPath, output, Encoding.UTF8);
            double mb = Math.Round(Encoding.UTF8.GetByteCount(output) / 1048576.0, 1);
            string head = output.Substring(0, Math.Min(4000, output.Length));
            string tail = output.Length > 4000 ? output.Substring(output.Length - 4000) : "";
            string note = $"终端输出过大（共 {output.Length} 字符 / {mb} MB），为避免站点附件渲染崩溃，未走附件上传；完整内容已写入本地文件：\n{localPath}\n\n需要分析时请先用终端命令读取或过滤该文件（如 Get-Content -TotalCount 2000 或 Select-String），不要一次性整读。";
            string summary = tail.Length > 0
                ? head + "\n\n...[中间 " + (output.Length - 8000) + " 字符省略，完整内容见本地文件]...\n\n" + tail
                : head;
            return (summary, note, localPath);
        }

        private async Task FeedResultBackAsync(
            string id,
            int exitCode,
            string output,
            bool isAttachment = false,
            string? filename = null,
            string? mimeType = null,
            string? base64Data = null,
            string? prompt = null)
        {
            if (App.DirectSendEnabled)
            {
                try
                {
                    DirectResult? direct = await TryDirectSendAsync(id, exitCode, output, isAttachment, filename, mimeType, base64Data, prompt);
                    if (direct != null && direct.Ok)
                    {
                        // Chain the next turn on OUR OWN reply id (page sniffing goes stale in direct mode).
                        if (direct.ReplyMessageId.HasValue)
                            _apiClient.UpdateSessionState(direct.SessionId, direct.ReplyMessageId.Value);
                        App.Log($"[DirectSend] Command {id} sent out-of-band directly to model.");
                        await Dispatcher.InvokeAsync(async () =>
                        {
                            try
                            {
                                string notifyJs = $"window.__agentBridge && window.__agentBridge.onDirectSendSuccess && window.__agentBridge.onDirectSendSuccess('{id}');";
                                await webView.CoreWebView2.ExecuteScriptAsync(notifyJs);
                            }
                            catch { }
                            try
                            {
                                string reply = direct.ReplyText ?? "";
                                if (reply.Length > 60000) reply = reply.Substring(0, 60000) + "\n...[回执过长已截断]";
                                string payload = JsonSerializer.Serialize(new { text = reply });
                                await webView.CoreWebView2.ExecuteScriptAsync(
                                    $"window.__agentBridge && window.__agentBridge.onDirectReply && window.__agentBridge.onDirectReply({payload});");
                            }
                            catch (Exception ex2)
                            {
                                App.Log($"[DirectSend] onDirectReply failed: {ex2.Message}");
                            }
                        });
                        return;
                    }
                }
                catch (Exception ex)
                {
                    App.Log($"[DirectSend] Exception: {ex.Message}, falling back to input box");
                }
            }

            await Dispatcher.InvokeAsync(async () =>
            {
                try
                {
                    var payload = new
                    {
                        id = id,
                        exitCode = exitCode,
                        output = output,
                        isAttachment = isAttachment,
                        filename = filename,
                        mimeType = mimeType,
                        base64Data = base64Data,
                        prompt = prompt
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

        private async Task<DirectResult?> TryDirectSendAsync(
            string id,
            int exitCode,
            string output,
            bool isAttachment,
            string? filename,
            string? mimeType,
            string? base64Data,
            string? prompt)
        {
            if (webView?.CoreWebView2 == null) return null;

            string? token = await _apiClient.ExtractTokenAsync(webView.CoreWebView2);
            if (string.IsNullOrEmpty(token))
            {
                App.Log("[DirectSend] User token not available in localStorage");
                return null;
            }

            string sessionId = _apiClient.CurrentSessionId ?? "";
            if (string.IsNullOrEmpty(sessionId))
            {
                var match = System.Text.RegularExpressions.Regex.Match(webView.Source?.ToString() ?? "", @"/a/chat/s/([a-f0-9\-]+)");
                if (match.Success) sessionId = match.Groups[1].Value;
            }

            if (string.IsNullOrEmpty(sessionId))
            {
                App.Log("[DirectSend] Current chat session ID not found");
                return null;
            }

            // First message in a session has no parent (page sends null); mirror that.
            int? parentMsgId = _apiClient.LastMessageId;

            List<string>? refFileIds = null;
            if (isAttachment && !string.IsNullOrEmpty(base64Data))
            {
                byte[] fileBytes = Convert.FromBase64String(base64Data);
                string fileId = await _apiClient.UploadFileDirectAsync(fileBytes, filename ?? "attachment.bin", mimeType ?? "application/octet-stream", token);
                refFileIds = new List<string> { fileId };
            }

            string feedbackPrompt;
            if (isAttachment)
            {
                feedbackPrompt = $"[Tool Call 附件就绪]: {prompt ?? "相关数据已作为附件挂载。"}\n（附件: {filename}）\n\n请阅读并分析上述附件内容，继续进行下一步判断或直接给出回答。";
            }
            else
            {
                string note = string.IsNullOrEmpty(prompt) ? "" : prompt + "\n\n";
                feedbackPrompt = $"{note}[Tool Call Result (Exit: {exitCode})]:\n```\n{output}\n```\n请根据上述终端执行结果继续。若需继续执行请输出 ```local_cmd 代码块，若全部完成请给出最终解答。";
            }

            return await _apiClient.SendCompletionDirectAsync(sessionId, parentMsgId, feedbackPrompt, refFileIds, token);
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
            "installed:!!window.__agentBridge," +
            "url:location.href," +
            "rs:document.readyState," +
            "hudBtn:!!document.getElementById('agent-inject-btn')," +
            "scan:((window.__agentBridge && window.__agentBridge._debug && window.__agentBridge._debug.describeScan) ? window.__agentBridge._debug.describeScan() : null)," +
            "dsx:(window.__DSX ? {ready:window.__DSX.__ready,plugins:window.__DSX.list(),errors:window.__DSX.errors()} : null)," +
            "textareas:[...document.querySelectorAll('textarea')].map(t=>({id:t.id,cls:String(t.className).slice(0,50),ph:t.placeholder,dis:t.disabled}))," +
            "ces:[...document.querySelectorAll('[contenteditable]')].map(x=>({tag:x.tagName,cls:String(x.className).slice(0,50)}))" +
            "})";

        private async void MenuInjectPrompt_Click(object sender, RoutedEventArgs e)
        {
            // Debounce: llhook + dispatcher hook may both fire for one press.
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (nowMs - _lastInjectTicks < 1000)
            {
                App.Log("[Inject] debounced (double-fire)");
                return;
            }
            _lastInjectTicks = nowMs;
            App.Log("[Inject] hotkey received");
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
            // 纯净模式：无顶栏缩放按钮，无需更新显示（缩放仍生效并持久化）
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
