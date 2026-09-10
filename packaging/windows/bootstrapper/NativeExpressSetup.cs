// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed record NativeExpressProgress(string Phase, string Message, long? CompletedBytes, long? TotalBytes);
internal sealed record NativeExpressEligibility(bool IsDevice, bool Eligible, string Message);

internal sealed class NativeModelSetupException : InvalidOperationException
{
    internal NativeModelSetupException(string message) : base(ForDisplay(message)) { }

    private static string ForDisplay(string message)
    {
        var bounded = string.Concat(message.Where(value => !char.IsControl(value) || value is '\n' or '\t').Take(2048));
        bounded = Regex.Replace(bounded, @"\b(?:bearer\s+|(?:api[-_ ]?key|credential|token|password|secret)[""']?\s*[:=]\s*[""']?)[^\s""',;}]+", "[redacted]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        bounded = Regex.Replace(bounded, @"\b(?:nvapi-|sk-or-|sk-|xoxb-|xapp-|gh[pousr]_|hf_)[A-Za-z0-9_-]+", "[redacted]", RegexOptions.CultureInvariant);
        return Regex.Replace(bounded, @"[A-Za-z0-9_+/=-]{32,}", "[redacted]", RegexOptions.CultureInvariant);
    }
}

internal static class NativeExpressSetup
{
    internal static string? FailureDetail(Exception error) => error is NativeModelSetupException
        ? $"On-device model setup did not finish. {error.Message}" : null;
    private static readonly JsonElement Manifest = LoadManifest();
    internal static string Id => Manifest.GetProperty("id").GetString()!;
    internal static string Model => Manifest.GetProperty("model").GetString()!;
    internal static string DisplayName => Manifest.GetProperty("displayName").GetString()!;
    internal static long ModelBytes => Manifest.GetProperty("weights").GetProperty("bytes").GetInt64();
    internal static long DownloadBytes => ModelBytes + Manifest.GetProperty("runtime").GetProperty("bytes").GetInt64() + Manifest.GetProperty("cuda").GetProperty("bytes").GetInt64();
    internal static string DownloadDescription => $"{ModelBytes / 1_000_000_000d:0.0} GB model · {DownloadBytes / 1_000_000_000d:0.0} GB total download";

    private static JsonElement LoadManifest()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Nvidia.NemoClaw.NativeInferenceManifest.json") ?? throw new NativeModelSetupException("The native model catalog is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    internal static async Task<NativeExpressEligibility> CheckPreliminaryEligibilityAsync()
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.OSArchitecture != Architecture.Arm64)
            return new(false, false, "N1X Express requires native Windows ARM64.");
        using var registry = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var bios = registry.OpenSubKey(@"HARDWARE\DESCRIPTION\System\BIOS");
        var product = (bios?.GetValue("SystemProductName") as string ?? string.Empty).Trim();
        if (!product.Contains(Manifest.GetProperty("productName").GetString()!, StringComparison.OrdinalIgnoreCase))
            return new(false, false, "N1X Express requires the supported RTX Spark N1X device.");
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        var minimumMemory = (ulong)Manifest.GetProperty("memoryBytes").GetInt64();
        if (!GlobalMemoryStatusEx(ref memory) || memory.TotalPhysical < minimumMemory || memory.AvailablePhysical < minimumMemory)
            return new(true, false, $"Free at least {minimumMemory / 1_000_000_000d:0.0} GB of memory to use N1X Express.");
        var candidates = new[]
        {
            Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
        };
        var diagnostic = candidates.FirstOrDefault(File.Exists);
        if (diagnostic is null) return new(true, false, "Install the NVIDIA driver to enable N1X Express.");
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = diagnostic,
                Arguments = "--query-gpu=name --format=csv,noheader",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            },
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var started = false;
        try
        {
            started = process.Start();
            if (!started) return new(true, false, "The NVIDIA driver check could not start.");
            var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            await Task.WhenAll(process.WaitForExitAsync(timeout.Token), stdout, stderr);
            if (process.ExitCode != 0 || string.IsNullOrWhiteSpace(stdout.Result) || stdout.Result.Length > 4096 || stderr.Result.Length > 4096)
                return new(true, false, "The NVIDIA driver needs attention before local inference.");
            return new(true, true, "Use the prebuilt on-device model. Its service starts when you launch the agent.");
        }
        catch (Exception) { return new(true, false, "The NVIDIA driver check did not complete. You can use hosted inference."); }
        finally { if (started && !process.HasExited) process.Kill(entireProcessTree: true); }
    }

    internal static void ValidatePrebuiltSelection(JsonElement preparation, string selected)
    {
        if (selected != Id || !preparation.TryGetProperty("localModel", out var pack) || pack.ValueKind != JsonValueKind.Object)
            throw new NativeModelSetupException("The selected prebuilt model is not available in this distribution.");
        var fields = new[] { "schemaVersion", "id", "model", "modelRevision", "weightsSha256", "weightsBytes", "packSha256", "runtimeId", "runtimeManifestSha256", "sourceRevision", "availability", "modelBytesRead" };
        var names = pack.EnumerateObject().Select(value => value.Name).ToArray();
        if (names.Length != fields.Length || names.Distinct(StringComparer.Ordinal).Count() != fields.Length || names.Any(name => !fields.Contains(name, StringComparer.Ordinal)) ||
            pack.GetProperty("schemaVersion").GetInt32() != 1 || pack.GetProperty("id").GetString() != Id ||
            pack.GetProperty("model").GetString() != Model || pack.GetProperty("modelRevision").GetString() != Manifest.GetProperty("modelRevision").GetString() ||
            pack.GetProperty("weightsSha256").GetString() != Manifest.GetProperty("weights").GetProperty("sha256").GetString() ||
            pack.GetProperty("weightsBytes").GetInt64() != ModelBytes || pack.GetProperty("availability").GetString() != "prebuilt" || pack.GetProperty("modelBytesRead").GetInt64() != 0)
            throw new NativeModelSetupException("The prebuilt model does not match this distribution's catalog.");
        foreach (var name in new[] { "packSha256", "runtimeId", "runtimeManifestSha256", "sourceRevision" })
        {
            var value = pack.GetProperty(name).GetString();
            if (value is null || value.Length != (name == "sourceRevision" ? 40 : 64) || value.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
                throw new NativeModelSetupException("The prebuilt model is not bound to its installed runtime.");
        }
    }
}
