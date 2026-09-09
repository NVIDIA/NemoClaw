// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;
using System.IO;
using System.Security;
using System.Security.Cryptography;
using System.Text;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeSetupOperations
{
    internal static async Task SaveAsync(NativeSetupConfiguration configuration, SecureString password, NativeServiceCredentials? serviceCredentials = null, Action<NativeExpressProgress>? progress = null, CancellationToken cancellation = default)
    {
        var launcher = InstalledLauncher();
        if (!NativeMaintenance.SupportsDataRemoval())
            throw new InvalidOperationException("Install this preview before configuring its native agent settings.");
        if (configuration.LocalModel is not null)
        {
            configuration = await NativeExpressSetup.PrepareAsync(configuration, launcher, progress, cancellation);
            cancellation.ThrowIfCancellationRequested();
            progress?.Invoke(new("configuration", "The local model is ready. Saving agent settings.", null, null));
        }
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
            var binding = await RunSetupHelperAsync(launcher, new[] { "--configure-native", "--prepare" }, configurationBytes, expectsBinding: true);
            var serviceBindings = new Dictionary<string, string>();
            foreach (var service in requiredServices)
                serviceBindings[service] = await RunSetupHelperAsync(launcher, new[] { "--configure-native", "--prepare-service", service }, configurationBytes, expectsBinding: true);
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

    private static async Task<string> RunSetupHelperAsync(string launcher, string[] arguments, byte[] input, bool expectsBinding = false)
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
            var stdout = ReadBoundedOutputAsync(process.StandardOutput, timeout.Token, expectsBinding);
            var stderr = ReadBoundedOutputAsync(process.StandardError, timeout.Token);
            await Task.WhenAll(WriteHelperInputAsync(process.StandardInput, input, timeout.Token), process.WaitForExitAsync(timeout.Token), stdout, stderr);
            if (process.ExitCode != 0 || (!expectsBinding && stdout.Result.Count != 0))
            {
                throw new InvalidOperationException("The native setup helper rejected the configuration.");
            }
            if (!expectsBinding) return string.Empty;
            var binding = stdout.Result.Value.Trim();
            if (binding.Length != 64 || binding.Any(value => value is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            {
                throw new InvalidOperationException("The native setup helper returned an invalid credential binding.");
            }
            return binding;
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
