// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeDownloadedModelSetup
{
    private static readonly JsonElement Catalog = Load();
    internal static string DefaultModel => Catalog.GetProperty("defaultModel").GetString()!;
    internal static IEnumerable<JsonElement> Models => Catalog.GetProperty("models").EnumerateArray();
    internal static bool IsModel(string? id) => Models.Any(model => model.GetProperty("id").GetString() == id);
    internal static JsonElement Model(string id) => Models.FirstOrDefault(model => model.GetProperty("id").GetString() == id) is var found && found.ValueKind == JsonValueKind.Object
        ? found : throw new NativeModelSetupException("Choose a model from the installed catalog.");
    internal static string Description(string id)
    {
        var model = Model(id);
        var size = DownloadBytes(id);
        return $"Setup downloads {size / 1_000_000_000d:0.0} GB for text chat and keeps about {RequiredFreeBytes(id) / 1_000_000_000d:0.0} GB free during setup. No API key or manual server setup is needed. Setup will load the model on the GPU and test a real response before reporting success.";
    }
    internal static long DownloadBytes(string id) => Model(id).GetProperty("weights").GetProperty("bytes").GetInt64();
    internal static long RequiredFreeBytes(string id) => DownloadBytes(id) + 1024L * 1024 * 1024;
    private static JsonElement Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Nvidia.NemoClaw.NativeLocalModels.json") ?? throw new NativeModelSetupException("The local model catalog is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }

    internal static void ValidateSelection(JsonElement preparation, string selected)
    {
        var model = Model(selected);
        if (!preparation.TryGetProperty("localModel", out var value) || value.ValueKind != JsonValueKind.Object)
            throw new NativeModelSetupException("The bundled inference runtime is unavailable.");
        var fields = new[] { "schemaVersion", "id", "model", "modelRevision", "weightsSha256", "weightsBytes", "packSha256", "runtimeId", "runtimeManifestSha256", "sourceRevision", "availability", "modelBytesRead" };
        var names = value.EnumerateObject().Select(item => item.Name).ToArray();
        if (names.Length != fields.Length || names.Distinct(StringComparer.Ordinal).Count() != fields.Length || names.Any(name => !fields.Contains(name, StringComparer.Ordinal)) ||
            value.GetProperty("schemaVersion").GetInt32() != 1 || value.GetProperty("id").GetString() != selected ||
            value.GetProperty("model").GetString() != selected || value.GetProperty("modelRevision").GetString() != model.GetProperty("revision").GetString() ||
            value.GetProperty("weightsSha256").GetString() != model.GetProperty("weights").GetProperty("sha256").GetString() ||
            value.GetProperty("weightsBytes").GetInt64() != model.GetProperty("weights").GetProperty("bytes").GetInt64() ||
            value.GetProperty("availability").GetString() != "download-on-setup" || value.GetProperty("modelBytesRead").GetInt64() != 0)
            throw new NativeModelSetupException("The selected model differs from the installed catalog.");
        foreach (var field in new[] { "packSha256", "runtimeId", "runtimeManifestSha256", "sourceRevision" })
        {
            var digest = value.GetProperty(field).GetString();
            if (digest is null || digest.Length != (field == "sourceRevision" ? 40 : 64) || digest.Any(character => !"0123456789abcdef".Contains(character)))
                throw new NativeModelSetupException("The local model is not bound to the installed runtime.");
        }
    }

    internal static Task DownloadAsync(string launcher, string selected, Action<NativeExpressProgress>? progress, CancellationToken cancellation) =>
        RunAsync(launcher, selected, "install", "downloaded", TimeSpan.FromHours(2), progress, cancellation);

    internal static Task EnsureReadyAsync(string launcher, string selected, Action<NativeExpressProgress>? progress, CancellationToken cancellation) =>
        RunAsync(launcher, selected, "ensure-ready", "ready", TimeSpan.FromMinutes(30), progress, cancellation);

    private static async Task RunAsync(string launcher, string selected, string action, string completionEvent, TimeSpan timeout, Action<NativeExpressProgress>? progress, CancellationToken cancellation)
    {
        _ = Model(selected);
        cancellation.ThrowIfCancellationRequested();
        using var process = new Process { StartInfo = new ProcessStartInfo {
            FileName = launcher, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(launcher)!,
        } };
        foreach (var argument in new[] { "--native-inference", action, "--model", selected }) process.StartInfo.ArgumentList.Add(argument);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        lifetime.CancelAfter(timeout);
        if (!process.Start()) throw new NativeModelSetupException("The model download helper could not start.");
        var completed = false;
        try
        {
            async Task Consume(StreamReader reader, bool output)
            {
                try
                {
                    var buffer = new char[512];
                    var line = new StringBuilder();
                    var errorBytes = 0;
                    int count;
                    while ((count = await reader.ReadAsync(buffer.AsMemory(), lifetime.Token)) != 0)
                    {
                        if (!output) { errorBytes += count; if (errorBytes > 16384) throw new NativeModelSetupException("The model helper exceeded its diagnostic limit."); continue; }
                        foreach (var character in buffer.AsSpan(0, count).ToArray())
                        {
                            if (character == '\r') continue;
                            if (character != '\n') { if (line.Length >= 4096) throw new NativeModelSetupException("The model helper returned an oversized progress message."); line.Append(character); continue; }
                            using var document = JsonDocument.Parse(line.ToString());
                            line.Clear();
                            var value = document.RootElement;
                            if (completed || value.GetProperty("schemaVersion").GetInt32() != 1) throw new NativeModelSetupException("The model helper returned invalid progress.");
                            var kind = value.GetProperty("event").GetString();
                            if (kind == completionEvent)
                            {
                                if (value.GetProperty("localModel").GetString() != selected) throw new NativeModelSetupException("The model helper completed a different selection.");
                                completed = true;
                            }
                            else if (kind == "progress")
                            {
                                var phase = value.GetProperty("phase").GetString();
                                if (phase is not ("checking" or "downloading" or "verifying" or "unpacking" or "loading" or "probing")) throw new NativeModelSetupException("The model helper returned an invalid setup phase.");
                                progress?.Invoke(new(phase, value.GetProperty("message").GetString() ?? "Preparing local model",
                                    value.TryGetProperty("completedBytes", out var done) ? done.GetInt64() : null,
                                    value.TryGetProperty("totalBytes", out var total) ? total.GetInt64() : null));
                            }
                            else throw new NativeModelSetupException("The model helper returned an unexpected result.");
                        }
                    }
                    if (line.Length != 0) throw new NativeModelSetupException("The model helper returned incomplete progress.");
                }
                catch { lifetime.Cancel(); throw; }
            }
            await Task.WhenAll(Consume(process.StandardOutput, true), Consume(process.StandardError, false), process.WaitForExitAsync(lifetime.Token));
            cancellation.ThrowIfCancellationRequested();
            if (process.ExitCode != 0 || !completed) throw new NativeModelSetupException(action == "install"
                ? "The model download did not finish. Check disk space and connectivity, then retry."
                : "The GPU readiness test did not finish. Check the NVIDIA driver and available memory, then retry.");
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            throw new NativeModelSetupException(action == "install"
                ? "The model download exceeded its time limit. Check connectivity, then retry."
                : "The GPU readiness test exceeded its time limit. Check the NVIDIA driver and available memory, then retry.");
        }
        finally
        {
            if (!process.HasExited)
            {
                try { await process.StandardInput.WriteLineAsync("cancel"); await process.StandardInput.FlushAsync(); }
                catch (IOException) { }
                using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                try { await process.WaitForExitAsync(grace.Token); }
                catch (OperationCanceledException) { process.Kill(entireProcessTree: true); using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5)); await process.WaitForExitAsync(cleanup.Token); }
            }
        }
    }
}
