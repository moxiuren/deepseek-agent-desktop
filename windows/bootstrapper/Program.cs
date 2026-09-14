// DeepSeek Agent portable bootstrapper (terminal exe).
// Any Windows 10 1607+/11 x64 machine: checks/installs .NET 8 Desktop Runtime +
// WebView2 Runtime, downloads the app payload zip from the GitHub release,
// extracts to %LOCALAPPDATA%\DeepSeek-Agent, creates shortcuts, launches.
// Console output is ASCII-safe (legacy consoles lack Emoji/CJK-mixed glyphs).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace DeepSeekBootstrap
{
    internal static class Program
    {
        // ---- release wiring (bump per app release) ----
        private const string AppVersion = "1.0.7";
        private const string AppTag = "v1.0.7";
        private const string AssetName = "DeepSeek-Agent-win-x64-trial-v1.0.7.zip";
        private const string RepoSlug = "moxiuren/deepseek-agent-desktop";
        // ---- prereq sources (mirror windows/installer/DeepSeek-Agent.iss) ----
        private const string DotNetUrl = "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe";
        private const string WebView2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        private const string Wv2ClientKey = @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }
            string tag = AppTag;
            string asset = AssetName;
            bool noLaunch = false;
            bool checkOnly = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--tag" && i + 1 < args.Length) tag = args[++i];
                else if (args[i] == "--asset" && i + 1 < args.Length) asset = args[++i];
                else if (args[i] == "--no-launch") noLaunch = true;
                else if (args[i] == "--check-only") checkOnly = true;
                else if (args[i] == "--help" || args[i] == "-h" || args[i] == "/?")
                {
                    Console.WriteLine("DeepSeek Agent bootstrapper 1.0.0 (for app v" + AppVersion + ")");
                    Console.WriteLine("Usage: DeepSeek-Agent-Bootstrap.exe [--tag vX.Y.Z] [--asset file.zip] [--no-launch] [--check-only]");
                    return 0;
                }
            }

            if (checkOnly)
            {
                Console.WriteLine("os64=" + Environment.Is64BitOperatingSystem
                    + " dotnet8=" + IsDotNet8DesktopInstalled()
                    + " webview2=" + IsWebView2Installed());
                return 0;
            }

            Console.WriteLine("== DeepSeek Agent bootstrap (app v" + AppVersion + ") ==");
            if (!Environment.Is64BitOperatingSystem)
            {
                Console.WriteLine("[FAIL] x64 Windows required (ARM/x86 not supported by this package).");
                return 2;
            }

            string appDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeek-Agent");
            string tmpDir = Path.Combine(Path.GetTempPath(), "dsx-bootstrap-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(tmpDir);

            // 1. .NET 8 Desktop Runtime
            if (!IsDotNet8DesktopInstalled())
            {
                Console.WriteLine("[1/5] .NET 8 Desktop Runtime missing -> downloading (~60MB)...");
                string f = Path.Combine(tmpDir, "windowsdesktop-runtime.exe");
                if (!DownloadFile(DotNetUrl, f)) return FailManual(
                    "dotnet 8 download failed. Install manually: https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe");
                Console.WriteLine("[1/5] installing (quiet, ~1 min, UAC prompt expected)...");
                if (!RunWait(f, "/install /quiet /norestart")) return FailManual(
                    "dotnet 8 install failed. Install manually: https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe");
                if (!IsDotNet8DesktopInstalled()) return FailManual(
                    "dotnet 8 still not detected. Install manually: https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe");
            }
            else Console.WriteLine("[1/5] .NET 8 Desktop Runtime: present, skip.");

            // 2. WebView2 Runtime
            if (!IsWebView2Installed())
            {
                Console.WriteLine("[2/5] WebView2 Runtime missing -> downloading (~2MB bootstrapper)...");
                string f = Path.Combine(tmpDir, "MicrosoftEdgeWebView2RuntimeInstallerX64.exe");
                if (!DownloadFile(WebView2Url, f)) return FailManual(
                    "WebView2 download failed. Install manually: https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                Console.WriteLine("[2/5] installing (silent, needs internet)...");
                if (!RunWait(f, "/silent /install")) return FailManual(
                    "WebView2 install failed. Install manually: https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                if (!IsWebView2Installed()) return FailManual(
                    "WebView2 still not detected. Install manually: https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            }
            else Console.WriteLine("[2/5] WebView2 Runtime: present, skip.");

            // 3. kill running app + WebView2 orphans (best effort; files are locked otherwise)
            try
            {
                foreach (var p in Process.GetProcessesByName("DeepSeek")) { try { p.Kill(); } catch { } }
            }
            catch { }
            try
            {
                System.Threading.Thread.Sleep(2000);
                foreach (var p in Process.GetProcessesByName("msedgewebview2")) { try { p.Kill(); } catch { } }
                System.Threading.Thread.Sleep(1000);
            }
            catch { }

            // 4. download app payload from this repo's release
            string url = "https://github.com/" + RepoSlug + "/releases/download/" + tag + "/" + asset;
            Console.WriteLine("[3/5] downloading app payload (~28MB)...");
            Console.WriteLine("      " + url);
            string zip = Path.Combine(tmpDir, asset);
            if (!DownloadFile(url, zip))
            {
                Console.WriteLine("[FAIL] payload download failed. Check network or release page:");
                Console.WriteLine("       https://github.com/" + RepoSlug + "/releases/tag/" + tag);
                return 3;
            }
            Console.WriteLine("[4/5] extracting to " + appDir + " ...");
            try
            {
                Directory.CreateDirectory(appDir);
                ZipFile.ExtractToDirectory(zip, appDir, overwriteFiles: true);
            }
            catch (Exception ex)
            {
                Console.WriteLine("[FAIL] extract failed: " + ex.Message);
                return 4;
            }

            // 5. default plugins -> user docs only for MISSING files (never clobber hot copies)
            try
            {
                string srcPlug = Path.Combine(appDir, "plugins");
                string dstPlug = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "DeepSeek-Agent", "plugins");
                if (Directory.Exists(srcPlug))
                {
                    Directory.CreateDirectory(dstPlug);
                    foreach (var f in Directory.GetFiles(srcPlug))
                    {
                        string dst = Path.Combine(dstPlug, Path.GetFileName(f));
                        if (!File.Exists(dst)) File.Copy(f, dst);
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[WARN] plugin seed skipped: " + ex.Message); }

            // 6. shortcuts
            string exe = Path.Combine(appDir, "DeepSeek.exe");
            if (!File.Exists(exe)) { Console.WriteLine("[FAIL] DeepSeek.exe missing after extract."); return 5; }
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                CreateShortcut(Path.Combine(desktop, "DeepSeek Agent.lnk"), exe, appDir);
                string programs = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    @"Microsoft\Windows\Start Menu\Programs");
                CreateShortcut(Path.Combine(programs, "DeepSeek Agent.lnk"), exe, appDir);
                Console.WriteLine("[5/5] shortcuts created (Desktop + Start Menu).");
            }
            catch (Exception ex) { Console.WriteLine("[WARN] shortcut failed (non-fatal): " + ex.Message); }

            Console.WriteLine("[OK] installed app v" + AppVersion + " -> " + appDir);
            try { Directory.Delete(tmpDir, true); } catch { }
            if (!noLaunch)
            {
                Console.WriteLine("Launching DeepSeek Agent...");
                try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }); }
                catch (Exception ex) { Console.WriteLine("[WARN] launch failed (app is installed, start manually): " + ex.Message); }
            }
            return 0;
        }

        private static int FailManual(string msg)
        {
            Console.WriteLine("[FAIL] " + msg);
            return 2;
        }

        private static bool IsDotNet8DesktopInstalled()
        {
            // Layer 1+2: registry subkeys AND value names (proper installer layout).
            // NOTE: VS/zip layouts leave this key empty -> filesystem + CLI fallbacks below.
            try
            {
                using var key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
                    .OpenSubKey(@"SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App");
                if (key != null)
                {
                    foreach (var n in key.GetSubKeyNames())
                        if (n.StartsWith("8.", StringComparison.Ordinal)) return true;
                    foreach (var n in key.GetValueNames())
                        if (n.StartsWith("8.", StringComparison.Ordinal)) return true;
                }
            }
            catch { }
            // Layer 3: shared-framework folders (covers VS installer / zip layouts).
            try
            {
                string[] roots = new[]
                {
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet"),
                    Environment.GetEnvironmentVariable("DOTNET_ROOT") ?? ""
                };
                foreach (var r in roots)
                {
                    if (string.IsNullOrEmpty(r)) continue;
                    string d = Path.Combine(r, "shared", "Microsoft.WindowsDesktop.App");
                    if (!Directory.Exists(d)) continue;
                    foreach (var v in Directory.GetDirectories(d))
                        if (Path.GetFileName(v).StartsWith("8.", StringComparison.Ordinal)) return true;
                }
            }
            catch { }
            // Layer 4: dotnet CLI (slow, last resort).
            try
            {
                using var p = Process.Start(new ProcessStartInfo("dotnet", "--list-runtimes")
                {
                    UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true
                });
                if (p == null) return false;
                string output = p.StandardOutput.ReadToEnd();
                p.WaitForExit(15000);
                foreach (var line in output.Split('\n'))
                {
                    string t = line.Trim();
                    if (t.StartsWith("Microsoft.WindowsDesktop.App 8.", StringComparison.Ordinal)) return true;
                }
            }
            catch { }
            return false;
        }

        private static bool IsWebView2Installed()
        {
            try
            {
                using var key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64)
                    .OpenSubKey(Wv2ClientKey);
                if (key == null) return false;
                var v = key.GetValue("pv") as string;
                return !string.IsNullOrEmpty(v);
            }
            catch { return false; }
        }

        private static bool RunWait(string exe, string args)
        {
            try
            {
                using var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false });
                if (p == null) return false;
                p.WaitForExit();
                return p.ExitCode == 0;
            }
            catch { return false; }
        }

        private static bool DownloadFile(string url, string dest)
        {
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    using var http = new HttpClient();
                    http.Timeout = TimeSpan.FromMinutes(20);
                    using var resp = http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).GetAwaiter().GetResult();
                    resp.EnsureSuccessStatusCode();
                    long total = resp.Content.Headers.ContentLength ?? -1;
                    using var src = resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult();
                    using var dst = File.Create(dest);
                    byte[] buf = new byte[81920];
                    long done = 0;
                    int lastPct = -1, n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        dst.Write(buf, 0, n);
                        done += n;
                        if (total > 0)
                        {
                            int pct = (int)(done * 100 / total);
                            if (pct != lastPct && pct % 5 == 0) { lastPct = pct; Console.Write("\r      {0}% ({1:N0}/{2:N0} bytes)", pct, done, total); }
                        }
                    }
                    Console.WriteLine();
                    if (total > 0 && done != total) throw new IOException("short read");
                    // zip integrity probe for the payload
                    if (dest.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                    {
                        using var za = ZipFile.OpenRead(dest);
                        int entries = 0;
                        foreach (var e in za.Entries) entries++;
                        if (entries == 0) throw new IOException("empty zip");
                    }
                    return true;
                }
                catch (Exception ex)
                {
                    Console.WriteLine();
                    Console.WriteLine("[WARN] download attempt " + attempt + "/3 failed: " + ex.Message);
                    try { if (File.Exists(dest)) File.Delete(dest); } catch { }
                    System.Threading.Thread.Sleep(2000 * attempt);
                }
            }
            return false;
        }

        private static void CreateShortcut(string lnk, string target, string workDir)
        {
            // Late-bound WScript.Shell: no interop assembly needed.
            Type? t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) throw new InvalidOperationException("WScript.Shell unavailable");
            object shell = Activator.CreateInstance(t)!;
            object sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnk })!;
            try
            {
                sc.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { target });
                sc.GetType().InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { workDir });
                sc.GetType().InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, sc, new object[] { target + ",0" });
                sc.GetType().InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, sc, null);
            }
            finally { try { System.Runtime.InteropServices.Marshal.ReleaseComObject(sc); } catch { } }
        }
    }
}
