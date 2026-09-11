using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace DeepSeek
{
    /// <summary>
    /// DeepSeek private web API client with automated PoW solving, token extraction,
    /// and out-of-band completion / attachment upload capabilities.
    /// </summary>
    public class DeepSeekApiClient : IDisposable
    {
        private readonly HttpClient _http;
        private string? _cachedToken;
        private string? _currentSessionId;
        private int? _lastMessageId;

        public const string BaseUrl = "https://chat.deepseek.com";
        public const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
        public const string ClientVersion = "2.5.0";

        public string? CurrentSessionId => _currentSessionId;
        public int? LastMessageId => _lastMessageId;
        public string? CachedToken => _cachedToken;

        public DeepSeekApiClient()
        {
            var handler = new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(10),
                AutomaticDecompression = System.Net.DecompressionMethods.All
            };

            _http = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(120)
            };
            _http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent);
        }

        public void UpdateSessionState(string? sessionId, int? messageId)
        {
            if (!string.IsNullOrEmpty(sessionId))
            {
                _currentSessionId = sessionId;
            }
            if (messageId.HasValue && messageId.Value > 0)
            {
                _lastMessageId = messageId.Value;
            }
        }

        /// <summary>
        /// Extracts the user's web token from localStorage in WebView2.
        /// </summary>
        public async Task<string?> ExtractTokenAsync(CoreWebView2 webView)
        {
            try
            {
                const string js = "(() => {" +
                    "try {" +
                    "  const raw = localStorage.getItem('userToken');" +
                    "  if (!raw) return '';" +
                    "  try {" +
                    "    const parsed = JSON.parse(raw);" +
                    "    return parsed.value || raw;" +
                    "  } catch (_) { return raw; }" +
                    "} catch (_) { return ''; }" +
                    "})();";

                string resultJson = await webView.ExecuteScriptAsync(js);
                if (!string.IsNullOrEmpty(resultJson))
                {
                    string token = JsonSerializer.Deserialize<string>(resultJson) ?? "";
                    token = token.Trim().Trim('"');
                    if (token.Length > 20 && !token.Equals("null", StringComparison.OrdinalIgnoreCase))
                    {
                        _cachedToken = token;
                        return token;
                    }
                }
            }
            catch (Exception ex)
            {
                App.Log($"[ApiClient] Failed to extract token from WebView2: {ex.Message}");
            }

            return _cachedToken;
        }

        /// <summary>
        /// Solves PoW for the specified target API path.
        /// </summary>
        public async Task<SolvedPow> FetchAndSolvePowAsync(string targetPath, string token)
        {
            string url = $"{BaseUrl}/api/v0/chat/create_pow_challenge";
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.Add("x-client-platform", "web");
            req.Headers.Add("x-client-version", ClientVersion);
            req.Headers.Add("x-client-locale", "zh_CN");
            req.Headers.Add("x-client-bundle-id", "com.deepseek.chat");

            string reqBody = JsonSerializer.Serialize(new { target_path = targetPath });
            req.Content = new StringContent(reqBody, Encoding.UTF8, "application/json");

            using var resp = await _http.SendAsync(req);
            resp.EnsureSuccessStatusCode();

            string resBody = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(resBody);
            var root = doc.RootElement;

            int code = root.GetProperty("code").GetInt32();
            if (code != 0)
            {
                string msg = root.TryGetProperty("msg", out var m) ? m.GetString() ?? "" : "";
                throw new InvalidOperationException($"PoW challenge error (code {code}): {msg}");
            }

            var challengeElem = root.GetProperty("data").GetProperty("biz_data").GetProperty("challenge");
            var challenge = JsonSerializer.Deserialize<ChallengeData>(challengeElem.GetRawText())
                ?? throw new InvalidOperationException("Failed to deserialize challenge data");

            return DeepSeekPowSolver.Solve(challenge, targetPath);
        }

        /// <summary>
        /// Uploads a file directly to DeepSeek's file storage API.
        /// </summary>
        public async Task<string> UploadFileDirectAsync(byte[] fileBytes, string filename, string mimeType, string token)
        {
            var solved = await FetchAndSolvePowAsync("/api/v0/file/upload_file", token);
            string powHeader = solved.ToBase64Header();

            string url = $"{BaseUrl}/api/v0/file/upload_file";
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.Add("x-client-platform", "web");
            req.Headers.Add("x-client-version", ClientVersion);
            req.Headers.Add("x-client-locale", "zh_CN");
            req.Headers.Add("x-client-bundle-id", "com.deepseek.chat");
            req.Headers.Add("x-ds-pow-response", powHeader);

            using var content = new MultipartFormDataContent();
            var fileContent = new ByteArrayContent(fileBytes);
            fileContent.Headers.ContentType = new MediaTypeHeaderValue(mimeType);
            content.Add(fileContent, "file", filename);
            req.Content = content;

            using var resp = await _http.SendAsync(req);
            resp.EnsureSuccessStatusCode();

            string resJson = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(resJson);
            var fileIdElem = doc.RootElement.GetProperty("data").GetProperty("biz_data").GetProperty("file_id");
            string fileId = fileIdElem.GetString()
                ?? throw new InvalidOperationException("Missing file_id in upload response");

            App.Log($"[ApiClient] Direct file upload success: {filename} -> {fileId}");
            return fileId;
        }

        /// <summary>
        /// Directly sends a chat completion to the DeepSeek server out-of-band.
        /// </summary>
        public async Task<bool> SendCompletionDirectAsync(
            string sessionId,
            int parentMessageId,
            string prompt,
            List<string>? refFileIds,
            string token,
            Action<string>? onChunk = null,
            CancellationToken ct = default)
        {
            var solved = await FetchAndSolvePowAsync("/api/v0/chat/completion", token);
            string powHeader = solved.ToBase64Header();

            string url = $"{BaseUrl}/api/v0/chat/completion";
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.Add("x-client-platform", "web");
            req.Headers.Add("x-client-version", ClientVersion);
            req.Headers.Add("x-client-locale", "zh_CN");
            req.Headers.Add("x-client-bundle-id", "com.deepseek.chat");
            req.Headers.Add("x-ds-pow-response", powHeader);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

            var payload = new
            {
                chat_session_id = sessionId,
                parent_message_id = parentMessageId,
                model_type = (string?)null,
                prompt = prompt,
                ref_file_ids = refFileIds ?? new List<string>(),
                thinking_enabled = true,
                search_enabled = true,
                action = (string?)null,
                preempt = false
            };

            string jsonBody = JsonSerializer.Serialize(payload);
            req.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");

            using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!resp.IsSuccessStatusCode)
            {
                string errText = await resp.Content.ReadAsStringAsync(ct);
                App.Log($"[ApiClient] Direct completion failed (status {resp.StatusCode}): {errText}");
                return false;
            }

            using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream, Encoding.UTF8);

            string? line;
            while ((line = await reader.ReadLineAsync(ct)) != null)
            {
                if (line.StartsWith("data: "))
                {
                    string data = line.Substring(6).Trim();
                    if (data == "[DONE]")
                    {
                        break;
                    }

                    if (!string.IsNullOrEmpty(data))
                    {
                        onChunk?.Invoke(data);
                    }
                }
            }

            App.Log($"[ApiClient] Direct completion streamed successfully for session {sessionId}");
            return true;
        }

        public void Dispose()
        {
            _http.Dispose();
        }
    }
}
