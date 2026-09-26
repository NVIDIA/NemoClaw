// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeHostPreparation
{
    // The same ARM64 MXC 0.8.0 executable shipped in the runtime payload.
    internal const string ProbeSha256 = "dde1c592270e9a659b01dccad70362da7b99fec114885fa4d625507aa775a503";

    internal static string ParseTier(string text)
    {
        if (text.Length > 8192) throw new InvalidOperationException("The MXC capability response exceeds its bound.");
        using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Select(p => p.Name).Distinct().Count() != root.EnumerateObject().Count())
            throw new InvalidOperationException("The MXC capability response is ambiguous.");
        var tier = root.GetProperty("tier").GetString();
        var augment = root.GetProperty("needsDaclAugmentation").GetBoolean();
        return (tier, augment) switch
        {
            ("base-container", false) => "base-container",
            ("appcontainer-dacl", true) => "appcontainer-dacl",
            _ => throw new InvalidOperationException("The MXC isolation tier is unsupported or inconsistent."),
        };
    }

    internal static bool SkipPackage(string package, string? tier, bool removing)
    {
        if (package is not ("MxcSystemDrivePreparation" or "MxcNullDevicePreparation")) return false;
        if (removing) return true;
        return tier switch
        {
            "base-container" => true,
            "appcontainer-dacl" => false,
            _ => throw new InvalidOperationException("Host preparation requires a successful MXC capability probe."),
        };
    }

    internal static async Task<string> ProbeAsync(string executable)
    {
        // Keep the verified file locked against replacement until the child exits.
        using var binary = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant() != ProbeSha256)
            throw new InvalidOperationException("The packaged MXC capability probe differs from its pinned input.");
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = Environment.SystemDirectory,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        info.ArgumentList.Add("--probe");
        info.Environment.Clear();
        foreach (var name in new[] { "SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA" })
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (value is not null) info.Environment[name] = value;
        }
        info.Environment["PATH"] = Environment.SystemDirectory;
        using var child = Process.Start(info) ?? throw new InvalidOperationException("The MXC capability probe did not start.");
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            child.StandardInput.Close();
            var stdout = ReadBoundedAsync(child.StandardOutput, deadline.Token);
            var stderr = ReadBoundedAsync(child.StandardError, deadline.Token);
            await Task.WhenAll(stdout, stderr, child.WaitForExitAsync(deadline.Token));
            if (child.ExitCode != 0) throw new InvalidOperationException("The MXC capability probe failed.");
            return ParseTier(await stdout);
        }
        finally
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                if (!child.WaitForExit(5000)) throw new InvalidOperationException("The owned MXC capability probe did not stop.");
            }
        }
    }

    internal static async Task<string> ReadBoundedAsync(StreamReader stream, CancellationToken token)
    {
        var buffer = new char[8193];
        var length = 0;
        while (length < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer.AsMemory(length), token);
            if (count == 0) return new string(buffer, 0, length);
            length += count;
        }
        throw new InvalidOperationException("The MXC capability output exceeds its bound.");
    }
}
