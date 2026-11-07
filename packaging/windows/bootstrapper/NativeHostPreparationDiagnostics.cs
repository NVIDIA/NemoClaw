// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

internal sealed class NativePreparationFailure
{
    internal string Stage { get; }
    internal uint? Win32Error { get; }
    internal string HelperStderr { get; }
    private bool HasHelperDetail { get; }

    internal NativePreparationFailure(string stage, uint? win32Error, string helperStderr, bool hasHelperDetail = true)
    {
        this.Stage = stage;
        this.Win32Error = win32Error;
        this.HelperStderr = helperStderr;
        this.HasHelperDetail = hasHelperDetail;
    }

    internal string Summary
    {
        get
        {
            var step = this.Stage switch
            {
                "open-metadata-inspection-target" or "open-metadata-target" => "Checking system-drive access",
                "open-metadata-update-target" or "write-metadata-dacl" => "Updating system-drive access",
                "windows-directory" or "windows-volume" => "Locating the Windows system drive",
                "windows-filesystem" => "Checking the Windows filesystem",
                "read-descriptor" => "Reading system-drive access settings",
                _ => "Preparing Windows isolation",
            };
            var code = this.Win32Error is uint value
                ? this.HasHelperDetail ? $"Windows error {value}: {new Win32Exception(unchecked((int)value)).Message}" : $"Windows setup status {value}."
                : "Windows could not complete this preparation step.";
            return $"{step} failed.\n{code}\nStage: {this.Stage}.";
        }
    }

    internal string LogDetail => $"NemoClaw host preparation failed at {this.Stage}; {(this.HasHelperDetail ? "Win32" : "setup status")}={this.Win32Error?.ToString() ?? "unavailable"}; helper stderr: {this.HelperStderr}";
}

internal static class NativeHostPreparationDiagnostics
{
    private const int MaximumBytes = 8192;

    internal static string PathFor(string bundleLog, string attempt)
    {
        if (string.IsNullOrWhiteSpace(bundleLog) || !Path.IsPathFullyQualified(bundleLog) || !ValidAttempt(attempt)) return string.Empty;
        return bundleLog + ".host-preparation-" + attempt + ".json";
    }

    internal static NativePreparationFailure? Read(string bundleLog, string attempt)
    {
        var path = PathFor(bundleLog, attempt);
        if (path.Length == 0) return null;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (stream.Length is <= 0 or > MaximumBytes) return null;
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            return Parse(Encoding.UTF8.GetString(bytes), attempt);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    internal static NativePreparationFailure? Parse(string text, string attempt)
    {
        if (!ValidAttempt(attempt) || text.Length > MaximumBytes) return null;
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("schemaVersion", out var schema)
                || !schema.TryGetInt32(out var version) || version != 1
                || String(root, "classification") != "nemoclaw-host-preparation-diagnostic"
                || String(root, "operation") != "prepare-system-drive"
                || String(root, "attemptId") != attempt || String(root, "status") != "failed") return null;
            var stage = String(root, "stage");
            if (stage is null || stage.Length is < 1 or > 64 || stage.Any(c => !char.IsAsciiLetterLower(c) && !char.IsAsciiDigit(c) && c != '-')) return null;
            uint? code = null;
            if (!root.TryGetProperty("win32Error", out var error)) return null;
            if (error.ValueKind != JsonValueKind.Null)
            {
                if (!error.TryGetUInt32(out var value)) return null;
                code = value;
            }
            return new NativePreparationFailure(stage, code, Sanitize(String(root, "stderr") ?? string.Empty));
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    internal static NativePreparationFailure Fallback(int status)
    {
        var value = unchecked((uint)status);
        uint? code = value <= 65535 ? value : (value & 0xffff0000) == 0x80070000 ? value & 0xffff : null;
        return new NativePreparationFailure("system-drive-preparation", code, "No matching helper diagnostic was available; the Windows installer status is retained.", hasHelperDetail: false);
    }

    private static bool ValidAttempt(string value) => value.Length == 32 && value.All(c => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f');
    private static string? String(JsonElement root, string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string Sanitize(string value)
    {
        if (value.Length > 768 || value.Any(c => c < ' ' || c > '~' || c is '\\' or '/' or '=' or '@')
            || new[] { "password", "secret", "credential", "authorization", "bearer" }.Any(word => value.Contains(word, StringComparison.OrdinalIgnoreCase)))
            return "Helper details redacted; the stage and Windows code remain available.";
        return value;
    }
}
