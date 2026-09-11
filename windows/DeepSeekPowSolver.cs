using System;
using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace DeepSeek
{
    public class ChallengeData
    {
        [JsonPropertyName("algorithm")]
        public string Algorithm { get; set; } = "";

        [JsonPropertyName("challenge")]
        public string Challenge { get; set; } = "";

        [JsonPropertyName("salt")]
        public string Salt { get; set; } = "";

        [JsonPropertyName("difficulty")]
        public int Difficulty { get; set; }

        [JsonPropertyName("signature")]
        public string Signature { get; set; } = "";

        [JsonPropertyName("expire_at")]
        public long? ExpireAt { get; set; }

        [JsonPropertyName("expireAt")]
        public long? ExpireAtCamel { get; set; }

        [JsonPropertyName("target_path")]
        public string? TargetPath { get; set; }
    }

    public class SolvedPow
    {
        [JsonPropertyName("algorithm")]
        public string Algorithm { get; set; } = "";

        [JsonPropertyName("challenge")]
        public string Challenge { get; set; } = "";

        [JsonPropertyName("salt")]
        public string Salt { get; set; } = "";

        [JsonPropertyName("answer")]
        public int Answer { get; set; }

        [JsonPropertyName("signature")]
        public string Signature { get; set; } = "";

        [JsonPropertyName("target_path")]
        public string TargetPath { get; set; } = "";

        public string ToBase64Header()
        {
            string json = JsonSerializer.Serialize(this);
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
        }
    }

    /// <summary>
    /// Pure C# .NET 8 high-performance DeepSeekHashV1 (Keccak-f[1600] 23 rounds) PoW solver.
    /// Zero external dependencies, fully allocation-free in core loop, multi-threaded via chunked Partitioner.
    /// </summary>
    public static class DeepSeekPowSolver
    {
        private static readonly uint[] RC = new uint[48]
        {
            0, 1, 0, 32898, 0x80000000, 32906, 0x80000000, 0x80008000, 0, 32907, 0, 0x80000001,
            0x80000000, 0x80008081, 0x80000000, 32777, 0, 138, 0, 136, 0, 0x80008009, 0, 0x8000000a,
            0, 0x8000808b, 0x80000000, 139, 0x80000000, 32905, 0x80000000, 32771, 0x80000000, 32770,
            0x80000000, 128, 0, 32778, 0x80000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000,
            32896, 0, 0x80000001, 0x80000000, 0x80008008
        };

        private static readonly int[] V = new int[24]
        {
            10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
        };

        private static readonly uint[] W = new uint[24]
        {
            1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
        };

        public const int Rate = 136; // 200 - 256 / 4

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void CopyWord(ReadOnlySpan<uint> src, int srcIdx, Span<uint> dst, int dstIdx)
        {
            dst[2 * dstIdx] = src[2 * srcIdx];
            dst[2 * dstIdx + 1] = src[2 * srcIdx + 1];
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void KeccakTheta(Span<uint> a, Span<uint> c, Span<uint> d, Span<uint> wBuf)
        {
            for (int t = 0; t < 5; t++)
            {
                int n = 2 * t;
                int i = (t + 5) * 2;
                int o = (t + 10) * 2;
                int f = (t + 15) * 2;
                int s = (t + 20) * 2;
                c[n] = a[n] ^ a[i] ^ a[o] ^ a[f] ^ a[s];
                c[n + 1] = a[n + 1] ^ a[i + 1] ^ a[o + 1] ^ a[f + 1] ^ a[s + 1];
            }
            for (int t = 0; t < 5; t++)
            {
                CopyWord(c, (t + 1) % 5, wBuf, 0);
                uint o = wBuf[0];
                uint f = wBuf[1];
                wBuf[0] = (o << 1) | (f >> 31);
                wBuf[1] = (f << 1) | (o >> 31);
                d[2 * t] = c[((t + 4) % 5) * 2] ^ wBuf[0];
                d[2 * t + 1] = c[((t + 4) % 5) * 2 + 1] ^ wBuf[1];
                for (int r = 0; r < 25; r += 5)
                {
                    a[(r + t) * 2] ^= d[2 * t];
                    a[(r + t) * 2 + 1] ^= d[2 * t + 1];
                }
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void KeccakRhoPi(Span<uint> a, Span<uint> c, Span<uint> wBuf)
        {
            CopyWord(a, 1, wBuf, 0);
            for (int i = 0; i < 24; i++)
            {
                int t = V[i];
                uint shift = W[i];
                CopyWord(a, t, c, 0);
                uint o = wBuf[0];
                uint f = wBuf[1];
                int s;
                int aMod;
                int u;
                if (shift < 32)
                {
                    s = 0;
                    aMod = (int)shift;
                    u = 32 - (int)shift;
                }
                else
                {
                    s = 1;
                    aMod = (int)shift - 32;
                    u = 64 - (int)shift;
                }
                wBuf[s] = (o << aMod) | (f >> u);
                wBuf[(s + 1) % 2] = (f << aMod) | (o >> u);
                CopyWord(wBuf, 0, a, t);
                CopyWord(c, 0, wBuf, 0);
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void KeccakChi(Span<uint> a, Span<uint> c)
        {
            for (int t = 0; t < 25; t += 5)
            {
                for (int n = 0; n < 5; n++)
                {
                    CopyWord(a, t + n, c, n);
                }
                for (int n = 0; n < 5; n++)
                {
                    int i = (t + n) * 2;
                    int o = ((n + 1) % 5) * 2;
                    int f = ((n + 2) % 5) * 2;
                    a[i] ^= ~c[o] & c[f];
                    a[i + 1] ^= ~c[o + 1] & c[f + 1];
                }
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void KeccakIota(Span<uint> a, int round)
        {
            int n = 2 * round;
            a[0] ^= RC[n];
            a[1] ^= RC[n + 1];
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void KeccakF1600Rounds(Span<uint> state, Span<uint> c, Span<uint> d, Span<uint> wBuf)
        {
            // DeepSeek custom: rounds 1 to 23
            for (int i = 1; i < 24; i++)
            {
                KeccakTheta(state, c, d, wBuf);
                KeccakRhoPi(state, c, wBuf);
                KeccakChi(state, c);
                KeccakIota(state, i);
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void AbsorbBlock(ReadOnlySpan<byte> queue, Span<uint> state)
        {
            for (int r = 0; r < Rate; r += 8)
            {
                int n = r / 4;
                state[n] ^= ((uint)queue[r + 7] << 24)
                    | ((uint)queue[r + 6] << 16)
                    | ((uint)queue[r + 5] << 8)
                    | ((uint)queue[r + 4]);
                state[n + 1] ^= ((uint)queue[r + 3] << 24)
                    | ((uint)queue[r + 2] << 16)
                    | ((uint)queue[r + 1] << 8)
                    | ((uint)queue[r]);
            }
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static void SqueezeOut(ReadOnlySpan<uint> state, Span<byte> outBuf)
        {
            for (int r = 0; r < 32; r += 8)
            {
                int n = r / 4;
                outBuf[r] = (byte)state[n + 1];
                outBuf[r + 1] = (byte)(state[n + 1] >> 8);
                outBuf[r + 2] = (byte)(state[n + 1] >> 16);
                outBuf[r + 3] = (byte)(state[n + 1] >> 24);
                outBuf[r + 4] = (byte)state[n];
                outBuf[r + 5] = (byte)(state[n] >> 8);
                outBuf[r + 6] = (byte)(state[n] >> 16);
                outBuf[r + 7] = (byte)(state[n] >> 24);
            }
        }

        public static void ComputeHash(ReadOnlySpan<byte> input, Span<byte> output)
        {
            Span<uint> state = stackalloc uint[50];
            state.Clear();
            Span<uint> c = stackalloc uint[10];
            Span<uint> d = stackalloc uint[10];
            Span<uint> wBuf = stackalloc uint[2];
            Span<byte> queue = stackalloc byte[Rate];
            int queueOffset = 0;

            for (int i = 0; i < input.Length; i++)
            {
                queue[queueOffset++] = input[i];
                if (queueOffset >= Rate)
                {
                    AbsorbBlock(queue, state);
                    KeccakF1600Rounds(state, c, d, wBuf);
                    queueOffset = 0;
                }
            }

            queue.Slice(queueOffset).Clear();
            queue[queueOffset] |= 6;
            queue[Rate - 1] |= 128;

            AbsorbBlock(queue, state);
            KeccakF1600Rounds(state, c, d, wBuf);

            SqueezeOut(state, output);
        }

        public static string ComputeHashHex(string input)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(input);
            Span<byte> hash = stackalloc byte[32];
            ComputeHash(utf8, hash);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }

        /// <summary>
        /// Solves a DeepSeekHashV1 PoW challenge using ultra-fast chunked parallel search.
        /// </summary>
        public static SolvedPow Solve(ChallengeData data, string targetPath)
        {
            if (data.Algorithm != "DeepSeekHashV1")
            {
                throw new NotSupportedException($"Unsupported algorithm: {data.Algorithm}");
            }

            long expireAt = data.ExpireAt ?? data.ExpireAtCamel
                ?? throw new ArgumentException("Missing expire_at in PoW challenge");

            string prefix = $"{data.Salt}_{expireAt}_";
            byte[] prefixBytes = Encoding.UTF8.GetBytes(prefix);

            if (prefixBytes.Length + 10 >= Rate)
            {
                throw new NotSupportedException($"Prefix length {prefixBytes.Length} too long for single-block solver");
            }

            byte[] targetBytes = Convert.FromHexString(data.Challenge);
            if (targetBytes.Length != 32)
            {
                throw new ArgumentException("Challenge must be a 32-byte hex string (64 hex characters)");
            }

            var sw = Stopwatch.StartNew();
            int foundAnswer = -1;
            int difficulty = data.Difficulty;

            // Chunked parallel partitioner reduces thread scheduling overhead
            var partitioner = Partitioner.Create(0, difficulty, 512);
            var parallelOptions = new ParallelOptions
            {
                MaxDegreeOfParallelism = Environment.ProcessorCount
            };

            Parallel.ForEach(partitioner, parallelOptions, (range, loopState) =>
            {
                Span<uint> hashState = stackalloc uint[50];
                Span<uint> c = stackalloc uint[10];
                Span<uint> d = stackalloc uint[10];
                Span<uint> wBuf = stackalloc uint[2];
                Span<byte> queue = stackalloc byte[Rate];
                Span<byte> nonceSpan = stackalloc byte[16];
                Span<byte> outBuf = stackalloc byte[32];

                // Template queue initialized once per partition
                queue.Clear();
                prefixBytes.CopyTo(queue);
                queue[Rate - 1] = 128;
                int prefixLen = prefixBytes.Length;

                for (int i = range.Item1; i < range.Item2; i++)
                {
                    if (Volatile.Read(ref foundAnswer) != -1)
                    {
                        loopState.Stop();
                        return;
                    }

                    if (!Utf8Formatter.TryFormat(i, nonceSpan, out int written))
                    {
                        continue;
                    }

                    nonceSpan.Slice(0, written).CopyTo(queue.Slice(prefixLen));
                    int padOffset = prefixLen + written;
                    queue[padOffset] = 6;
                    // Clean tail up to Rate - 1 (Rate - 1 is already 128)
                    queue.Slice(padOffset + 1, Rate - 1 - (padOffset + 1)).Clear();

                    hashState.Clear();
                    AbsorbBlock(queue, hashState);
                    KeccakF1600Rounds(hashState, c, d, wBuf);
                    SqueezeOut(hashState, outBuf);

                    if (outBuf.SequenceEqual(targetBytes))
                    {
                        Interlocked.CompareExchange(ref foundAnswer, i, -1);
                        loopState.Stop();
                        return;
                    }

                    // Reset pad byte for next iteration
                    queue[padOffset] = 0;
                }
            });

            sw.Stop();

            if (foundAnswer == -1)
            {
                throw new InvalidOperationException($"PoW failed: no answer found in 0..{difficulty} (elapsed: {sw.ElapsedMilliseconds}ms)");
            }

            App.Log($"[PoW] Solved answer={foundAnswer} in {sw.ElapsedMilliseconds}ms (difficulty={difficulty}, threads={Environment.ProcessorCount})");

            return new SolvedPow
            {
                Algorithm = data.Algorithm,
                Challenge = data.Challenge,
                Salt = data.Salt,
                Answer = foundAnswer,
                Signature = data.Signature,
                TargetPath = targetPath
            };
        }

        /// <summary>
        /// Self-test with known test vectors.
        /// </summary>
        public static bool SelfTest()
        {
            try
            {
                // Vector 1: prefix + "0"
                string h1 = ComputeHashHex("3c1b67cba98a8235c00d_1788633061248_0");
                if (h1 != "a77d69cad11ee53b776e0b5fb61ba36074e67eaaa1b6644ef5006deb6be55453")
                {
                    return false;
                }

                // Vector 2: Live captured 2026-09-12 01:39:50 challenge
                var liveChallenge = new ChallengeData
                {
                    Algorithm = "DeepSeekHashV1",
                    Challenge = "a8f7edfeb5c161a8cada44aaf10163272931267ebbd5ac5a085da51c084961d2",
                    Salt = "94ca9d35e51f15b7677a",
                    Difficulty = 144000,
                    Signature = "68440d49b655ed5b500474e79a84f9d8a07e5cda67f8114e75433b87cb84adf8",
                    ExpireAt = 1789148689858
                };
                var solved = Solve(liveChallenge, "/api/v0/chat/completion");
                return solved.Answer == 80804;
            }
            catch (Exception ex)
            {
                App.Log($"[PoW] SelfTest failed: {ex.Message}");
                return false;
            }
        }
    }
}
