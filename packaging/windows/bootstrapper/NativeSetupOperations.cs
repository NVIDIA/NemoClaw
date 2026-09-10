// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeSetupOperations
{
    internal static async Task SaveAsync(NativeSetupConfiguration configuration, SecureString password, NativeServiceCredentials? serviceCredentials = null, Action<NativeExpressProgress>? progress = null, CancellationToken cancellation = default)
    {
        var launcher = InstalledLauncher();
        if (!NativeMaintenance.SupportsDataRemoval())
            throw new InvalidOperationException("Install this preview before configuring its native agent settings.");
        cancellation.ThrowIfCancellationRequested();
        var configurationBytes = Encoding.UTF8.GetBytes(configuration.Serialize());
        var requiredServices = configuration.Options.RequiredServices();
        var suppliedServices = serviceCredentials?.Keys.ToArray() ?? Array.Empty<string>();
        if (!requiredServices.Order(StringComparer.Ordinal).SequenceEqual(suppliedServices.Order(StringComparer.Ordinal)))
            throw new InvalidOperationException("Integration keys no longer match the selected options.");
        var serviceBytes = new Dictionary<string, byte[]>();
        byte[]? credential = null;
        try
        {
            credential = configuration.ReadCredential(password);
            foreach (var service in requiredServices)
                serviceBytes[service] = NativeSetupConfiguration.ReadServiceCredential(service, serviceCredentials![service]);
            // Validate the complete metadata and every binding before replacing any credential.
            var preparation = await RunSetupHelperAsync(launcher, new[] { "--configure-native", "--prepare-all" }, configurationBytes, captureOutput: true);
            var bindings = ReadBindings(preparation, requiredServices, configuration.LocalModel);
            var binding = bindings.Inference;
            var serviceBindings = bindings.Services;
            if (binding is not null)
                await RunSetupHelperAsync(launcher, new[] { credential.Length == 0 ? "--credential-delete" : "--credential-write", configuration.Inference, "--binding", binding }, credential);
            foreach (var service in requiredServices)
                await RunSetupHelperAsync(launcher, new[] { "--credential-write", service, "--binding", serviceBindings[service] }, serviceBytes[service]);
            await RunSetupHelperAsync(launcher, new[] { "--configure-native" }, configurationBytes);
            NativeDesktopIntegration.Ensure(configuration.Agent, launcher);
        }
        finally
        {
            if (credential is not null) CryptographicOperations.ZeroMemory(credential);
            foreach (var bytes in serviceBytes.Values) CryptographicOperations.ZeroMemory(bytes);
        }
    }

    internal static void Launch(string agent)
    {
        if (agent is not ("openclaw" or "hermes" or "langchain-deepagents-code" or "pi" or "nemocua")) throw new InvalidOperationException("The selected agent is invalid.");
        var launcher = InstalledLauncher();
        Process.Start(new ProcessStartInfo
        {
            FileName = launcher,
            Arguments = $"--configured --agent {agent}",
            UseShellExecute = true,
            WorkingDirectory = Path.GetDirectoryName(launcher)!,
        })?.Dispose();
    }

    private static async Task<string> RunSetupHelperAsync(string launcher, string[] arguments, byte[] input, bool captureOutput = false)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = launcher,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            StandardInputEncoding = new UTF8Encoding(false),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(launcher)!,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = startInfo };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        if (!process.Start()) throw new InvalidOperationException("The native setup helper could not start.");
        try
        {
            var stdout = ReadBoundedOutputAsync(process.StandardOutput, timeout.Token, captureOutput);
            var stderr = ReadBoundedOutputAsync(process.StandardError, timeout.Token);
            await Task.WhenAll(WriteHelperInputAsync(process.StandardInput, input, timeout.Token), process.WaitForExitAsync(timeout.Token), stdout, stderr);
            if (process.ExitCode != 0 || (!captureOutput && stdout.Result.Count != 0))
            {
                throw new InvalidOperationException("The native setup helper rejected the configuration.");
            }
            return captureOutput ? stdout.Result.Value : string.Empty;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(cleanup.Token);
            }
        }
    }

    internal static (string? Inference, Dictionary<string, string> Services) ReadBindings(string value, IReadOnlyCollection<string> requiredServices, string? localModel = null)
    {
        using var document = JsonDocument.Parse(value);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != (localModel is null ? 3 : 4) ||
            !root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || schema.GetInt32() != 1 ||
            !root.TryGetProperty("inference", out var inference) ||
            !root.TryGetProperty("services", out var services) || services.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The native setup helper returned invalid credential bindings.");
        var bindings = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var entry in services.EnumerateObject())
        {
            if (!requiredServices.Contains(entry.Name, StringComparer.Ordinal) || !bindings.TryAdd(entry.Name, ReadBinding(entry.Value)))
                throw new InvalidOperationException("The native setup helper returned unexpected integration bindings.");
        }
        if (bindings.Count != requiredServices.Count)
            throw new InvalidOperationException("The native setup helper omitted integration bindings.");
        if (localModel is not null)
        {
            if (inference.ValueKind != JsonValueKind.Null) throw new InvalidOperationException("The local model must not request an external credential binding.");
            NativeExpressSetup.ValidatePrebuiltSelection(root, localModel);
            return (null, bindings);
        }
        return (ReadBinding(inference), bindings);
    }

    private static string ReadBinding(JsonElement value)
    {
        var binding = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        if (binding is null || binding.Length != 64 || binding.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidOperationException("The native setup helper returned an invalid credential binding.");
        return binding;
    }

    private static async Task WriteHelperInputAsync(StreamWriter writer, byte[] input, CancellationToken cancellation)
    {
        try { await writer.BaseStream.WriteAsync(input, cancellation); }
        finally { writer.Close(); }
    }

    private static async Task<(int Count, string Value)> ReadBoundedOutputAsync(StreamReader reader, CancellationToken cancellation, bool capture = false)
    {
        var buffer = new char[512];
        var value = capture ? new StringBuilder() : null;
        var total = 0;
        int count;
        try
        {
            while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
            {
                total += count;
                if (total > 4096) throw new InvalidOperationException("The native setup helper exceeded its output bound.");
                value?.Append(buffer, 0, count);
                Array.Clear(buffer);
            }
            return (total, value?.ToString() ?? string.Empty);
        }
        finally { Array.Clear(buffer); }
    }

    internal static string InstalledLauncher()
    {
        if (Environment.GetCommandLineArgs().Skip(1).FirstOrDefault() is "--onboard" or "--installer" or "--web-session")
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The native interface executable is unavailable.");
            var uiRoot = Path.GetDirectoryName(executable)!;
            if (!string.Equals(Path.GetFileName(uiRoot), "native-ui", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("The native interface is outside its installed location.");
            }
            var installRoot = Directory.GetParent(uiRoot)?.FullName ?? throw new InvalidOperationException("The native installation directory is unavailable.");
            return Path.Combine(installRoot, "bin", "NemoClaw.exe");
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA", "NemoClaw", "bin", "NemoClaw.exe");
    }

}
