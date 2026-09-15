using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;

namespace DeepSeek
{
    public partial class App : Application
    {
        private static Mutex? _mutex;
        private const string MutexName = "Local\\DeepSeek_Windows_Agent_Client_Mutex_2026";

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
        public static readonly uint WM_SHOW_DEEPSEEK = RegisterWindowMessage("DEEPSEEK_AGENT_RESTORE_WINDOW_2026");

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const int SW_RESTORE = 9;

        // Diagnostics (sniffer + verbose desktop log) are OFF by default for
        // distributed builds. Enable on a dev machine by either:
        //   set DEEPSEEK_DIAG=1   (environment variable), or
        //   create empty file %LOCALAPPDATA%\DeepSeek-Agent\diag.enable
        public static readonly bool DiagnosticsEnabled = CheckDiagnostics();

        // Direct API Send (bypassing input box) is toggleable via:
        //   set DEEPSEEK_DIRECT_SEND=1  (environment variable), or
        //   create empty file %LOCALAPPDATA%\DeepSeek-Agent\direct_send.enable
        public static bool DirectSendEnabled => CheckDirectSend();

        private static bool CheckDiagnostics()
        {
            try
            {
                if (Environment.GetEnvironmentVariable("DEEPSEEK_DIAG") == "1") return true;
                string flag = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DeepSeek-Agent", "diag.enable");
                if (File.Exists(flag)) return true;
            }
            catch {}
            return false;
        }

        private static bool CheckDirectSend()
        {
            try
            {
                if (Environment.GetEnvironmentVariable("DEEPSEEK_DIRECT_SEND") == "1") return true;
                string flag = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DeepSeek-Agent", "direct_send.enable");
                if (File.Exists(flag)) return true;
            }
            catch {}
            return false;
        }

        private static readonly object _logLock = new object();
        private const long MaxLogSizeBytes = 5 * 1024 * 1024; // 5 MB

        // 静态单例路径定义，杜绝每次写入反复构建
        private static readonly string LogDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepSeek-Agent", "logs");
        private static readonly string LogFilePath = Path.Combine(LogDirectory, "deepseek.log");

        private static long _approximateLogSizeBytes = -1; // 内存字节计数器
        private static bool _directoryInitialized = false;

        public static void Log(string msg)
        {
            // 1. 静默降噪白名单：丢弃高频正常的 read_file 心跳
            if (msg.StartsWith("[read_file] OK:") && msg.Contains("Task-State.md"))
            {
                return;
            }

            lock (_logLock)
            {
                try
                {
                    // 2. 目录单例初始化
                    if (!_directoryInitialized)
                    {
                        if (!Directory.Exists(LogDirectory))
                        {
                            Directory.CreateDirectory(LogDirectory);
                        }
                        _directoryInitialized = true;
                    }

                    // 3. 内存字节计数初始化 (仅首次或重置时读取一次物理磁盘元数据)
                    if (_approximateLogSizeBytes < 0)
                    {
                        _approximateLogSizeBytes = File.Exists(LogFilePath) ? new FileInfo(LogFilePath).Length : 0;
                    }

                    // 4. 轮转检查
                    if (_approximateLogSizeBytes >= MaxLogSizeBytes)
                    {
                        RotateLogsSafe();
                    }

                    // 5. 格式化并落盘
                    string line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] {msg}\r\n";
                    File.AppendAllText(LogFilePath, line);
                    _approximateLogSizeBytes += Encoding.UTF8.GetByteCount(line);
                }
                catch (IOException ioEx)
                {
                    // 文件被外部占用或杀软锁定时降级，防止主进程闪退
                    Trace.WriteLine($"[App.Log IOException - File Locked]: {ioEx.Message}");
                    _approximateLogSizeBytes = -1; // 下次写入时校准
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"[App.Log Unexpected]: {ex.Message}");
                }
            }
        }

        private static void RotateLogsSafe()
        {
            try
            {
                string backup2 = Path.Combine(LogDirectory, "deepseek.log.2");
                string backup1 = Path.Combine(LogDirectory, "deepseek.log.1");

                if (File.Exists(backup2))
                {
                    File.Delete(backup2);
                }
                if (File.Exists(backup1))
                {
                    File.Move(backup1, backup2);
                }
                if (File.Exists(LogFilePath))
                {
                    File.Move(LogFilePath, backup1);
                }
                _approximateLogSizeBytes = 0;
            }
            catch (IOException ioEx)
            {
                // 发生占用时放弃轮转重命名，直接保持追加写入，绝不崩溃
                Trace.WriteLine($"[RotateLogsSafe In-Use Warning]: {ioEx.Message}");
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[RotateLogsSafe Error]: {ex.Message}");
            }
        }

        public static void CleanupLegacyDesktopLogSafe()
        {
            try
            {
                string desktopPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string legacyLog = Path.Combine(desktopPath, "deepseek_debug.log");
                if (File.Exists(legacyLog))
                {
                    var fi = new FileInfo(legacyLog);
                    if (fi.Length > 0)
                    {
                        File.Delete(legacyLog);
                        Log($"[Cleanup] Legacy desktop debug log cleaned: {legacyLog} ({fi.Length} bytes)");
                    }
                }
            }
            catch (IOException ioEx)
            {
                // 若被 VSCode/Notepad++ 占用，静默跳过，绝不阻断客户端正常启动
                Trace.WriteLine($"[CleanupLegacyDesktopLogSafe Occupied]: {ioEx.Message}");
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"[CleanupLegacyDesktopLogSafe Error]: {ex.Message}");
            }
        }

        protected override void OnStartup(StartupEventArgs e)
        {
            CleanupLegacyDesktopLogSafe();
            Log("=== App.OnStartup enter ===");

            AppDomain.CurrentDomain.UnhandledException += (s, args) =>
            {
                Log($"[CRITICAL] AppDomain UnhandledException: {args.ExceptionObject}");
                MessageBox.Show($"未捕获异常: {args.ExceptionObject}", "DeepSeek 启动崩溃", MessageBoxButton.OK, MessageBoxImage.Error);
            };

            DispatcherUnhandledException += (s, args) =>
            {
                Log($"[CRITICAL] DispatcherUnhandledException: {args.Exception}");
                MessageBox.Show($"界面未处理异常: {args.Exception.Message}", "DeepSeek 错误", MessageBoxButton.OK, MessageBoxImage.Error);
                args.Handled = true;
            };

            bool isNewInstance;
            try
            {
                _mutex = new Mutex(true, MutexName, out isNewInstance);
            }
            catch (Exception ex)
            {
                Log($"Mutex check exception: {ex.Message}");
                isNewInstance = true;
            }

            if (!isNewInstance)
            {
                Log("[SingleInstance] Another instance is already running. Broadcasting wake-up message and exiting immediately.");
                try
                {
                    var current = System.Diagnostics.Process.GetCurrentProcess();
                    foreach (var proc in System.Diagnostics.Process.GetProcessesByName(current.ProcessName))
                    {
                        if (proc.Id != current.Id && proc.MainWindowHandle != IntPtr.Zero)
                        {
                            ShowWindow(proc.MainWindowHandle, SW_RESTORE);
                            SetForegroundWindow(proc.MainWindowHandle);
                        }
                    }
                }
                catch {}

                PostMessage(HWND_BROADCAST, WM_SHOW_DEEPSEEK, IntPtr.Zero, IntPtr.Zero);
                Environment.Exit(0);
                return;
            }

            base.OnStartup(e);
            var mainWindow = new MainWindow();
            mainWindow.Show();
            Log("base.OnStartup done, MainWindow shown");
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try
            {
                _mutex?.ReleaseMutex();
                _mutex?.Dispose();
            }
            catch {}
            base.OnExit(e);
        }
    }
}
