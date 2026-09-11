using System;
using System.IO;
using System.Runtime.InteropServices;
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

        public static void Log(string msg)
        {
            try
            {
                string logPath;
                if (DiagnosticsEnabled)
                {
                    logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "deepseek_debug.log");
                }
                else
                {
                    logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "DeepSeek-Agent", "logs", "deepseek.log");
                    string? dir = Path.GetDirectoryName(logPath);
                    if (dir != null) Directory.CreateDirectory(dir);
                }
                File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] {msg}\r\n");
            }
            catch {}
        }

        protected override void OnStartup(StartupEventArgs e)
        {
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
