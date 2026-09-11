// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Nvidia.NemoClaw.Bootstrapper;

public static class HostPreparationDiagnosticControls
{
    public static int Main() => Run();

    public static int Run()
    {
        const string attempt = "0123456789abcdef0123456789abcdef";
        var payload = new Dictionary<string, object?>
        {
            ["schemaVersion"] = 1,
            ["classification"] = "nemoclaw-host-preparation-diagnostic",
            ["operation"] = "prepare-system-drive",
            ["attemptId"] = attempt,
            ["status"] = "failed",
            ["stage"] = "open-metadata-inspection-target",
            ["win32Error"] = 32,
            ["stderr"] = "NemoClaw system-drive metadata preparation failed: open-metadata-inspection-target: Win32 error 32",
        };
        var text = JsonSerializer.Serialize(payload);
        var failure = NativeHostPreparationDiagnostics.Parse(text, attempt) ?? throw new Exception("Early helper failure disappeared.");
        Require(failure.Win32Error == 32 && failure.Stage == "open-metadata-inspection-target", "Native error identity changed.");
        Require(failure.Summary.Contains("Windows error 32") && failure.Summary.Contains("Checking system-drive access"), "Setup did not explain the failed stage and code.");
        Require(failure.LogDetail.Contains("helper stderr:") && failure.LogDetail.Contains("Win32 error 32"), "Sanitized stderr was lost from the setup log.");
        Require(NativeHostPreparationDiagnostics.Parse(text, "ffffffffffffffffffffffffffffffff") is null, "A stale attempt was accepted.");
        payload["status"] = "succeeded";
        Require(NativeHostPreparationDiagnostics.Parse(JsonSerializer.Serialize(payload), attempt) is null, "Success was displayed as a failure.");
        payload["status"] = "failed";
        payload["stage"] = "C:\\Users\\private";
        Require(NativeHostPreparationDiagnostics.Parse(JsonSerializer.Serialize(payload), attempt) is null, "A path was accepted as a display stage.");
        payload["stage"] = "open-metadata-inspection-target";
        payload["stderr"] = "Authorization: Bearer private-value C:\\Users\\private";
        var redacted = NativeHostPreparationDiagnostics.Parse(JsonSerializer.Serialize(payload), attempt) ?? throw new Exception("Sanitization discarded the useful error code.");
        Require(!redacted.LogDetail.Contains("private-value") && !redacted.Summary.Contains("Users"), "A credential or user path reached setup diagnostics.");
        payload["stderr"] = "Metadata validation failed.";
        payload["win32Error"] = null;
        var validation = NativeHostPreparationDiagnostics.Parse(JsonSerializer.Serialize(payload), attempt) ?? throw new Exception("A validation failure was discarded.");
        Require(validation.Win32Error is null, "A native code was invented for a validation failure.");
        Require(NativeHostPreparationDiagnostics.Parse(new string('x', 8193), attempt) is null, "Unbounded helper data was accepted.");
        Require(NativeHostPreparationDiagnostics.Parse("{broken", attempt) is null, "Malformed helper data escaped the fallback.");
        var fallback = NativeHostPreparationDiagnostics.Fallback(unchecked((int)0x80070001));
        Require(fallback.Summary.Contains("Windows setup status 1") && !fallback.Summary.Contains("Windows error 1:"), "An installer exit code was misreported as a native diagnosis.");

        var directory = Path.Combine(Path.GetTempPath(), "nemoclaw-preparation-control-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var log = Path.Combine(directory, "setup.log");
            var path = NativeHostPreparationDiagnostics.PathFor(log, attempt);
            File.WriteAllText(path, text);
            Require(NativeHostPreparationDiagnostics.Read(log, attempt)?.Win32Error == 32, "The retained sidecar was not read.");
            File.WriteAllText(path, "incomplete");
            Require(NativeHostPreparationDiagnostics.Read(log, attempt) is null, "Incomplete persisted data bypassed fallback.");
        }
        finally { Directory.Delete(directory, recursive: true); }
        Console.WriteLine("13 helper/Setup diagnostic controls passed; real Windows Burn execution remains separate.");
        return 0;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
