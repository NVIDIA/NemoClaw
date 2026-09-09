// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed record NativeExpressProgress(string Phase, string Message, long? CompletedBytes, long? TotalBytes);
internal sealed record NativeExpressEligibility(bool IsDevice, bool Eligible, string Message);

internal static class NativeExpressSetup
{
    private static readonly JsonElement Manifest = LoadManifest();
    internal static string Id => Manifest.GetProperty("id").GetString()!;
    internal static string Model => Manifest.GetProperty("model").GetString()!;
    internal static string DisplayName => Manifest.GetProperty("displayName").GetString()!;
    internal static long ModelBytes => Manifest.GetProperty("weights").GetProperty("bytes").GetInt64();
    internal static long DownloadBytes => ModelBytes + Manifest.GetProperty("runtime").GetProperty("bytes").GetInt64() + Manifest.GetProperty("cuda").GetProperty("bytes").GetInt64();
    internal static string DownloadDescription => $"{ModelBytes / 1_000_000_000d:0.0} GB model · {DownloadBytes / 1_000_000_000d:0.0} GB total download";

    private static JsonElement LoadManifest()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Nvidia.NemoClaw.NativeInferenceManifest.json") ?? throw new InvalidOperationException("The native model catalog is missing.");
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
        var drive = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!);
        if (drive.AvailableFreeSpace < Manifest.GetProperty("storageBytes").GetInt64())
            return new(true, false, $"N1X Express needs {Manifest.GetProperty("storageBytes").GetInt64() / 1_000_000_000d:0.0} GB of free system-drive space.");
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
            return new(true, true, DownloadDescription + ". Text and tool use; final device checks run after installation.");
        }
        catch (Exception) { return new(true, false, "The NVIDIA driver check did not complete. You can use hosted inference."); }
        finally { if (started && !process.HasExited) process.Kill(entireProcessTree: true); }
    }

    internal static async Task<NativeSetupConfiguration> PrepareAsync(NativeSetupConfiguration configuration, string launcher, Action<NativeExpressProgress>? progress, CancellationToken cancellation)
    {
        if (configuration.LocalModel != Id) throw new InvalidOperationException("The selected local model does not match the bundled catalog.");
        progress?.Invoke(new("hardware", "Checking this device for N1X Express.", null, null));
        var catalog = await RunAsync(launcher, "catalog", progress, cancellation);
        if (!catalog.TryGetProperty("eligible", out var eligible) || !eligible.GetBoolean())
        {
            var reasons = catalog.TryGetProperty("reasons", out var list) ? string.Join(" ", list.EnumerateArray().Select(value => value.GetString())) : "This device did not pass local inference checks.";
            throw new InvalidOperationException(reasons);
        }
        if (!catalog.GetProperty("models").EnumerateArray().Any(model => model.GetProperty("id").GetString() == Id && model.GetProperty("downloadBytes").GetInt64() == DownloadBytes))
            throw new InvalidOperationException("The installed local model catalog changed. Run Repair before continuing.");
        await RunAsync(launcher, "install", progress, cancellation);
        var ready = await RunAsync(launcher, "ensure-ready", progress, cancellation);
        if (ready.GetProperty("event").GetString() != "ready" || ready.GetProperty("localModel").GetString() != Id || ready.GetProperty("model").GetString() != Model ||
            !Uri.TryCreate(ready.GetProperty("endpoint").GetString(), UriKind.Absolute, out var endpoint) || !endpoint.IsLoopback || endpoint.Scheme != "http" || ready.TryGetProperty("credential", out _))
            throw new InvalidOperationException("The local model did not return an authenticated ready endpoint.");
        return configuration with { Endpoint = endpoint.AbsoluteUri.TrimEnd('/'), Model = Model, CredentialStored = false };
    }

    private static async Task<JsonElement> RunAsync(string launcher, string operation, Action<NativeExpressProgress>? progress, CancellationToken cancellation)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo { FileName = launcher, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true } };
        process.StartInfo.ArgumentList.Add("--native-inference"); process.StartInfo.ArgumentList.Add(operation);
        if (!process.Start()) throw new InvalidOperationException("The native model helper could not start.");
        using var timeout = new CancellationTokenSource(operation == "install" ? TimeSpan.FromHours(4) : TimeSpan.FromMilliseconds(Manifest.GetProperty("readinessTimeoutMs").GetInt64() + 60000));
        using var cancel = cancellation.Register(() =>
        {
            try { process.StandardInput.WriteLine("cancel"); process.StandardInput.Flush(); }
            catch (Exception) { }
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
        });
        JsonElement result = default;
        string? error = null;
        async Task ReadLines(StreamReader reader, bool isError)
        {
            while (await reader.ReadLineAsync(timeout.Token) is string line)
            {
                if (line.Length > 65536) throw new InvalidOperationException("Native model progress exceeded its limit.");
                using var document = JsonDocument.Parse(line);
                var value = document.RootElement;
                if (value.GetProperty("schemaVersion").GetInt32() != 1) throw new InvalidOperationException("Native model progress has an unsupported version.");
                var kind = value.GetProperty("event").GetString();
                if (isError || kind == "error") { error = value.GetProperty("message").GetString(); continue; }
                if (kind == "progress")
                {
                    progress?.Invoke(new(value.GetProperty("phase").GetString()!, value.GetProperty("message").GetString()!, value.TryGetProperty("completedBytes", out var completed) ? completed.GetInt64() : null, value.TryGetProperty("totalBytes", out var total) ? total.GetInt64() : null));
                }
                else result = value.Clone();
            }
        }
        try
        {
            await Task.WhenAll(ReadLines(process.StandardOutput, false), ReadLines(process.StandardError, true), process.WaitForExitAsync(timeout.Token));
            cancellation.ThrowIfCancellationRequested();
            if (process.ExitCode != 0 || error is not null || result.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException(error ?? "Native model setup did not complete.");
            return result;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                await process.WaitForExitAsync(stop.Token);
            }
        }
    }
}
