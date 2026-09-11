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
using Microsoft.Web.WebView2.Core;

namespace DeepSeek
{
    public partial class MainWindow : Window
    {
        private bool _isExecuting = false;

        public MainWindow()
        {
            InitializeComponent();
            Loaded += MainWindow_Loaded;
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            await InitializeWebViewAsync();
        }

        private async Task InitializeWebViewAsync()
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string userDataFolder = Path.Combine(localAppData, "DeepSeek", "WebView2");
                Directory.CreateDirectory(userDataFolder);

                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(env);

                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.Settings.IsBuiltInErrorPageEnabled = true;

                // Open external links in user's default browser
                webView.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;

                // Handle messages sent from agent_bridge.js
                webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;

                // Inject agent_bridge.js on document created (guarantees execution on all page loads)
                string bridgeScript = GetAgentBridgeScript();
                if (!string.IsNullOrEmpty(bridgeScript))
                {
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
                }

                // Navigate to DeepSeek
                webView.CoreWebView2.Navigate("https://chat.deepseek.com");
            }
            catch (Exception ex)
            {
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
                using var doc = JsonDocument.Parse(e.WebMessageAsString);
                var root = doc.RootElement;
                if (!root.TryGetProperty("action", out var actionProp)) return;
                string action = actionProp.GetString() ?? "";

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

        private async Task ExecuteLocalCommandAsync(string id, string command)
        {
            if (_isExecuting) return;
            _isExecuting = true;

            Console.WriteLine($"[Native Bridge] >>> EXECUTING COMMAND (ID: {id}):\n{command}");

            string output = "";
            int exitCode = -1;

            try
            {
                // Execute via powershell.exe using -EncodedCommand for 100% robust cross-platform scripting
                byte[] bytes = Encoding.Unicode.GetBytes(command);
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

        private async void MenuInjectPrompt_Click(object sender, RoutedEventArgs e)
        {
            if (webView.CoreWebView2 != null)
            {
                await webView.CoreWebView2.ExecuteScriptAsync("window.__agentBridge && window.__agentBridge.injectSystemPrompt();");
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

        private void MenuZoomIn_Click(object sender, RoutedEventArgs e)
        {
            if (webView.CoreWebView2 != null) webView.ZoomFactor += 0.1;
        }

        private void MenuZoomOut_Click(object sender, RoutedEventArgs e)
        {
            if (webView.CoreWebView2 != null && webView.ZoomFactor > 0.3) webView.ZoomFactor -= 0.1;
        }

        private void MenuZoomReset_Click(object sender, RoutedEventArgs e)
        {
            if (webView.CoreWebView2 != null) webView.ZoomFactor = 1.0;
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

        private void Window_KeyDown(object sender, KeyEventArgs e)
        {
            if (Keyboard.Modifiers == ModifierKeys.Control)
            {
                if (e.Key == Key.N) { MenuNewChat_Click(sender, e); e.Handled = true; }
                else if (e.Key == Key.I) { MenuInjectPrompt_Click(sender, e); e.Handled = true; }
                else if (e.Key == Key.R)
                {
                    if (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) MenuForceReload_Click(sender, e);
                    else MenuReload_Click(sender, e);
                    e.Handled = true;
                }
                else if (e.Key == Key.OemPlus || e.Key == Key.Add) { MenuZoomIn_Click(sender, e); e.Handled = true; }
                else if (e.Key == Key.OemMinus || e.Key == Key.Subtract) { MenuZoomOut_Click(sender, e); e.Handled = true; }
                else if (e.Key == Key.D0 || e.Key == Key.NumPad0) { MenuZoomReset_Click(sender, e); e.Handled = true; }
            }
        }
    }
}
