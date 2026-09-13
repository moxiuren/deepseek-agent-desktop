using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace DeepSeek
{
    /// <summary>
    /// DSX built-in plugin host (native).
    /// Replaces the external CDP-based PowerShell host: no DEEPSEEK_DEBUG_PORT,
    /// no debug port, no separate process. Runtime is registered at document
    /// creation (auto-restores after any navigation); this host loads plugins
    /// from the plugin dir, hot-reloads on file mtime change, unloads on delete,
    /// and re-syncs the full set whenever the page context is lost (reload).
    /// Contract identical to the standalone DSX system (plugin-loader.js).
    /// </summary>
    public sealed class PluginHost : IDisposable
    {
        private const int PollMs = 1500;
        private const int HealthCheckMs = 3000;

        private readonly Func<string, Task<string>> _eval;
        private readonly string _pluginDir;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly Dictionary<string, long> _mtimes = new Dictionary<string, long>();
        private Task? _loop;
        private bool _started;
        private bool _disposed;

        public PluginHost(Func<string, Task<string>> evaluate, string pluginDir)
        {
            _eval = evaluate ?? throw new ArgumentNullException(nameof(evaluate));
            _pluginDir = pluginDir ?? throw new ArgumentNullException(nameof(pluginDir));
        }

        /// <summary>Default plugin dir: %USERPROFILE%\Documents\DeepSeek-Agent\plugins (env DSX_PLUGIN_DIR overrides).</summary>
        public static string ResolvePluginDir(string? overrideDir = null)
        {
            if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir.Trim();
            var env = Environment.GetEnvironmentVariable("DSX_PLUGIN_DIR");
            if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(docs, "DeepSeek-Agent", "plugins");
        }

        public void Start()
        {
            if (_started || _disposed) return;
            _started = true;
            try { Directory.CreateDirectory(_pluginDir); } catch (Exception ex) { App.Log($"[DSX] plugin dir create failed: {ex.Message}"); }
            _loop = Task.Run(() => LoopAsync(_cts.Token));
        }

        private async Task LoopAsync(CancellationToken ct)
        {
            App.Log($"[DSX] built-in host started, pluginDir={_pluginDir}, poll={PollMs}ms");
            DateTime healthSince = DateTime.UtcNow;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if ((DateTime.UtcNow - healthSince).TotalMilliseconds >= HealthCheckMs)
                    {
                        healthSince = DateTime.UtcNow;
                        bool ready = await IsRuntimeReadyAsync(ct);
                        if (!ready)
                        {
                            App.Log("[DSX] runtime missing (page reload?), waiting for doc-created auto-install...");
                            await Task.Delay(PollMs, ct);
                            continue;
                        }
                    }

                    var current = ScanDir();
                    if (current == null)
                    {
                        // Plugin dir missing/empty: treat as "everything removed".
                        foreach (var path in new List<string>(_mtimes.Keys))
                        {
                            await UnloadAsync(Path.GetFileNameWithoutExtension(path));
                            _mtimes.Remove(path);
                        }
                        await Task.Delay(PollMs, ct);
                        continue;
                    }

                    foreach (var kv in current)
                    {
                        if (!_mtimes.TryGetValue(kv.Key, out long old) || old != kv.Value)
                        {
                            App.Log($"[DSX] changed: {Path.GetFileName(kv.Key)}");
                            await LoadPluginAsync(kv.Key);
                            _mtimes[kv.Key] = kv.Value;
                        }
                    }

                    foreach (var path in new List<string>(_mtimes.Keys))
                    {
                        if (!current.ContainsKey(path))
                        {
                            string name = Path.GetFileNameWithoutExtension(path);
                            App.Log($"[DSX] removed: {name}");
                            await UnloadAsync(name);
                            _mtimes.Remove(path);
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    App.Log($"[DSX] poll error: {ex.Message}");
                }
                await Task.Delay(PollMs, ct);
            }
        }

        private Dictionary<string, long>? ScanDir()
        {
            if (!Directory.Exists(_pluginDir)) return null;
            var map = new Dictionary<string, long>();
            foreach (var f in Directory.GetFiles(_pluginDir, "*.js"))
            {
                try { map[f] = File.GetLastWriteTimeUtc(f).Ticks; } catch { }
            }
            return map;
        }

        public async Task<bool> IsRuntimeReadyAsync(CancellationToken ct = default)
        {
            try
            {
                string val = (await _eval("window.__DSX && window.__DSX.__ready ? 'ready' : 'missing'")).Trim().Trim('"');
                if (val == "ready") return true;
                if (val == "missing")
                {
                    // The runtime is registered at document-created; wait for next navigation/creation.
                    return false;
                }
                return false;
            }
            catch (Exception ex)
            {
                App.Log($"[DSX] runtime check failed: {ex.Message}");
                return false;
            }
        }

        public async Task<bool> LoadPluginAsync(string file)
        {
            string src;
            try { src = File.ReadAllText(file, Encoding.UTF8); }
            catch (Exception ex)
            {
                App.Log($"[DSX] read failed {Path.GetFileName(file)}: {ex.Message}");
                return false;
            }
            if (string.IsNullOrWhiteSpace(src)) return false;
            string name = Path.GetFileNameWithoutExtension(file);
            var meta = new { name = name, version = "1.0.0", file = file, builtin = true };
            string metaB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(meta)));
            string srcB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(src));
            string js = "window.__DSX.load(JSON.parse(decodeURIComponent(escape(atob('" + metaB64 + "')))), decodeURIComponent(escape(atob('" + srcB64 + "'))))";
            try
            {
                string r = (await _eval(js)).Trim();
                bool ok = string.Equals(r, "true", StringComparison.OrdinalIgnoreCase)
                          || (r.StartsWith("{\"ok\":true", StringComparison.OrdinalIgnoreCase));
                App.Log($"[DSX] load {name} -> {(ok ? "OK" : r)}");
                return ok;
            }
            catch (Exception ex)
            {
                App.Log($"[DSX] load {name} failed: {ex.Message}");
                return false;
            }
        }

        public async Task<bool> UnloadAsync(string name)
        {
            try
            {
                string safe = JsonSerializer.Serialize(name);
                string js = "window.__DSX ? window.__DSX.unload(" + safe + ") : false";
                string r = (await _eval(js)).Trim();
                return string.Equals(r, "true", StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception ex)
            {
                App.Log($"[DSX] unload {name} failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>Diagnostics: { ready, list: [{name,version}], errors: [...] } or null when unavailable.</summary>
        public async Task<JsonElement?> StatusAsync()
        {
            const string js = "window.__DSX ? JSON.stringify({ready:true,list:window.__DSX.list(),errors:window.__DSX.errors()}) : JSON.stringify({ready:false,list:[],errors:[]})";
            try
            {
                string r = (await _eval(js)).Trim();
                return JsonDocument.Parse(r).RootElement;
            }
            catch (Exception ex)
            {
                App.Log($"[DSX] status failed: {ex.Message}");
                return null;
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _cts.Cancel(); } catch { }
            try
            {
                if (_loop != null && !_loop.IsCompleted) { _loop.Wait(1000); }
            }
            catch { }
            _cts.Dispose();
        }
    }
}