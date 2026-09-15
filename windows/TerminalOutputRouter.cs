#nullable enable
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace DeepSeek
{
    public static class TerminalOutputRouter
    {
        public const int MaxDirectTextLength = 16000;
        public const int HeadKeepChars = 7500;
        public const int TailKeepChars = 7500;
        public const long MaxUploadBytes = 5 * 1024 * 1024; // 5MB

        public sealed class RoutingResult
        {
            public bool IsAttachment { get; set; }
            public string OutputText { get; set; } = "";
            public string? Filename { get; set; }
            public string? MimeType { get; set; }
            public string? Base64Data { get; set; }
            public string? Prompt { get; set; }
            public string? LocalOversizedPath { get; set; }
        }

        public static RoutingResult Route(string output, string baseDir)
        {
            if (string.IsNullOrWhiteSpace(output))
            {
                return new RoutingResult { OutputText = "(命令执行完毕，无终端文字输出)" };
            }

            // 1. 显式附件分支处理
            var match = Regex.Match(output, @"\[\[AGENT_ATTACH_FILE:(.+?)\]\]");
            if (match.Success)
            {
                string inner = match.Groups[1].Value.Trim();
                string filePath = inner;
                string prompt = "";

                int colonIdx = -1;
                if (inner.Length > 2 && inner[1] == ':' && (inner[2] == '\\' || inner[2] == '/'))
                {
                    colonIdx = inner.IndexOf(':', 2);
                }
                else
                {
                    colonIdx = inner.IndexOf(':');
                }

                if (colonIdx >= 0)
                {
                    filePath = inner.Substring(0, colonIdx).Trim();
                    prompt = inner.Substring(colonIdx + 1).Trim();
                }

                filePath = Environment.ExpandEnvironmentVariables(filePath);

                if (File.Exists(filePath))
                {
                    var fileInfo = new FileInfo(filePath);
                    if (fileInfo.Length <= MaxUploadBytes)
                    {
                        byte[] fileBytes = File.ReadAllBytes(filePath);
                        return new RoutingResult
                        {
                            IsAttachment = true,
                            OutputText = output,
                            Filename = Path.GetFileName(filePath),
                            MimeType = GetMimeType(Path.GetExtension(filePath)),
                            Base64Data = Convert.ToBase64String(fileBytes),
                            Prompt = prompt
                        };
                    }

                    // 超出 5MB 拦截，坚决不全量读取 byte[]
                    return HandleOversizedFile(filePath, fileInfo, prompt, output, baseDir);
                }
            }

            // 2. 纯文本通道：绝不隐式自动转附件
            if (output.Length <= MaxDirectTextLength)
            {
                return new RoutingResult { IsAttachment = false, OutputText = output };
            }

            // 3. 纯文本超限截断与落盘
            return HandleOversizedText(output, baseDir);
        }

        public static RoutingResult HandleOversizedText(string output, string baseDir)
        {
            string outDir = Path.Combine(baseDir, "oversized_outputs");
            Directory.CreateDirectory(outDir);
            string localPath = Path.Combine(outDir, $"agent_output_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}.txt");
            File.WriteAllText(localPath, output, Encoding.UTF8);

            int omitted = output.Length - (HeadKeepChars + TailKeepChars);
            string head = output.Substring(0, HeadKeepChars);
            string tail = output.Substring(output.Length - TailKeepChars);
            string foldMark = $"\n\n...[终端输出过长，已折叠中间 {omitted} 字符，完整内容见本地缓存]...\n\n";

            string summary = head + foldMark + tail;
            string note = $"[输出过大通知]: 完整输出已安全保存至：\n{localPath}\n若需分析请用命令行读取或过滤。";

            return new RoutingResult
            {
                IsAttachment = false,
                OutputText = summary,
                Prompt = note,
                LocalOversizedPath = localPath
            };
        }

        public static RoutingResult HandleOversizedFile(string filePath, FileInfo fileInfo, string prompt, string originalOutput, string baseDir)
        {
            double mb = Math.Round(fileInfo.Length / 1048576.0, 2);
            string ext = Path.GetExtension(filePath).ToLowerInvariant();
            bool isText = IsTextExtension(ext);

            string note = $"[附件超限提示]: 目标文件 {Path.GetFileName(filePath)} 大小为 {mb} MB，超过了 5MB 上传上限，未走网页附件上传；完整文件保留在原路径：\n{filePath}\n";
            if (!string.IsNullOrEmpty(prompt)) note = prompt + "\n\n" + note;

            if (!isText)
            {
                // 二进制文件坚决不调用 ReadAllTextAsync
                return new RoutingResult
                {
                    IsAttachment = false,
                    OutputText = originalOutput + $"\n\n(该文件为二进制类型 [{ext}]，无法作为文本展开)",
                    Prompt = note
                };
            }

            // 文本文件且超限，读取首尾切片
            string fullText = File.ReadAllText(filePath, Encoding.UTF8);
            var textRes = HandleOversizedText(fullText, baseDir);
            textRes.Prompt = note + "\n" + textRes.Prompt;
            return textRes;
        }

        public static bool IsTextExtension(string ext) => ext switch
        {
            ".txt" or ".log" or ".json" or ".xml" or ".csv" or ".md" or ".cs" or ".js" or ".ts" or ".py" or ".ps1" or ".html" or ".css" or ".yaml" or ".yml" => true,
            _ => false
        };

        public static string GetMimeType(string ext) => ext.ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".pdf" => "application/pdf",
            _ => "text/plain"
        };
    }
}
