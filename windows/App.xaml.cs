using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;

namespace DeepSeek
{
    public partial class App : Application
    {
        private static Mutex? _mutex;
        private const string MutexName = "DeepSeek_Windows_Agent_Client_Mutex_2026";

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
        public static readonly uint WM_SHOW_DEEPSEEK = RegisterWindowMessage("DEEPSEEK_AGENT_RESTORE_WINDOW_2026");

        protected override void OnStartup(StartupEventArgs e)
        {
            _mutex = new Mutex(true, MutexName, out bool isNewInstance);

            if (!isNewInstance)
            {
                // Broadcast wake-up message to the running instance
                PostMessage(HWND_BROADCAST, WM_SHOW_DEEPSEEK, IntPtr.Zero, IntPtr.Zero);
                Shutdown();
                return;
            }

            base.OnStartup(e);
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
