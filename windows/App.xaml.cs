using System;
using System.IO;
using System.Windows;

namespace DeepSeek
{
    public partial class App : Application
    {
        public static void Log(string msg)
        {
            try
            {
                string logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "deepseek_debug.log");
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

            base.OnStartup(e);
            Log("base.OnStartup done");
        }
    }
}
