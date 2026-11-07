// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Nvidia.NemoClaw.Bootstrapper;

internal static class NativeHostPreparation
{
    // The package build binds this assembly to the admitted MXC binary. Never
    // read an expected digest from a mutable sidecar or the process environment.
    internal static string ReadProbeSha256(IEnumerable<AssemblyMetadataAttribute> attributes)
    {
        var matches = attributes.Where(item => item.Key == "NemoClaw.MxcProbeSha256").ToArray();
        var value = matches.Length == 1 ? matches[0].Value : null;
        if (value is null || value.Length != 64 || value.Any(c => !(c is >= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new InvalidOperationException("The packaged MXC capability probe has no unambiguous compiled identity.");
        return value;
    }

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
        VerifyProbe(binary);
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
            if (!child.WaitForExit(0))
            {
                child.Kill(entireProcessTree: true);
                if (!await Task.Run(() => child.WaitForExit(5000))) throw new InvalidOperationException("The owned MXC capability probe did not stop.");
            }
        }
    }

    internal static void VerifyProbe(Stream binary)
    {
        var expected = ReadProbeSha256(typeof(NativeHostPreparation).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>());
        if (Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant() != expected)
            throw new InvalidOperationException("The packaged MXC capability probe differs from its pinned input.");
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
