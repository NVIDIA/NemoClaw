// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;

namespace Nvidia.NemoClaw.HostPrerequisiteControls;

[SupportedOSPlatform("windows")]
internal static class LargeTreeMeasurement
{
    internal static void Run(string evidence)
    {
        var root = Path.Combine(evidence, "fixtures");
        var intervals = new List<object>();
        var changed = new List<object>();
        var cleanupErrors = new List<string>();
        Exception? primary = null;
        var entryCount = 0;
        var removed = false;
        var complete = false;
        var processId = Environment.ProcessId;
        var threadId = GetCurrentThreadId();
        try
        {
            // Creation and descriptor hashing precede capture. "Cold" below
            // means the two explicit ACEs are absent, not an empty disk cache.
            for (var directory = 0; directory < 32; directory++)
            {
                var child = Path.Combine(root, $"directory-{directory:d2}");
                Directory.CreateDirectory(child);
                for (var file = 0; file < 64; file++)
                    File.WriteAllText(Path.Combine(child, $"file-{file:d2}.txt"), "owned measurement\n");
            }
            var before = ReadTree(root);
            entryCount = before.Count;
            if (entryCount != 2080) throw new IOException("The owned measurement tree has an unexpected entry count.");
            using var owner = DirectoryAcl.Open(root, DirectoryAcl.MaximumAllowed);
            Console.WriteLine(JsonSerializer.Serialize(new { phase = "ready", processId, threadId, root, entryCount }));
            Console.Out.Flush();
            WaitForCommand("capture-ready");
            var cold = Measure("cold-metadata", owner.Prepare, intervals);
            var warm = Measure("warm-no-op", owner.Prepare, intervals);
            var enumerated = Measure("explicit-enumeration-control", () => Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories).Count(), intervals);
            if (!cold.WroteDacl || warm.WroteDacl || owner.SetCalls != 1 || warm.BeforeSha256 != cold.AfterSha256 || enumerated != entryCount)
                throw new IOException("The metadata/no-op/enumeration controls did not execute as expected.");
            File.WriteAllText(Path.Combine(evidence, "measurement-intervals.json"), JsonSerializer.Serialize(new { processId, threadId, intervals }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
            Console.WriteLine("capture-complete");
            Console.Out.Flush();
            WaitForCommand("capture-stopped");
            var after = ReadTree(root);
            if (after.Count != before.Count) throw new IOException("The descendant count changed during metadata preparation.");
            foreach (var row in before)
            {
                if (!after.TryGetValue(row.Key, out var current)) throw new IOException("An owned descendant disappeared.");
                if (row.Value.Sha256 != current.Sha256)
                    changed.Add(new { path = row.Key, before = row.Value.Details(), after = current.Details() });
            }
            if (changed.Count != 0) throw new IOException("The intended metadata operation changed a descendant descriptor.");
            complete = true;
        }
        catch (Exception error) { primary = error; }
        finally
        {
            try { if (Directory.Exists(root)) Directory.Delete(root, true); removed = !Directory.Exists(root); }
            catch (Exception error) { cleanupErrors.Add(error.Message); primary ??= error; }
            var receipt = new { schemaVersion = 1, classification = "owned-large-tree-metadata-measurement",
                controllerSource = Environment.GetEnvironmentVariable("GITHUB_SHA"), processId, threadId, entryCount,
                status = primary is null && complete && removed ? "pass" : "failed", intervals, changedDescendants = changed,
                fixturesRemoved = removed, cleanupErrors, error = primary?.ToString(),
                noDirectoryTraversalProven = false, systemDriveTouched = false, productionActivated = false,
                coldDefinition = "required explicit metadata ACEs absent; prior fixture creation and descriptor reads warm filesystem caches",
                ioCounterScope = "all process I/O operations/bytes; not an enumeration or scanner attribution" };
            try { File.WriteAllText(Path.Combine(evidence, "large-tree-measurement.json"), JsonSerializer.Serialize(receipt, new JsonSerializerOptions { WriteIndented = true }) + "\n"); }
            catch (Exception error) { primary ??= error; }
        }
        if (primary is not null) throw primary;
    }

    private static Dictionary<string, DirectoryAcl.Snapshot> ReadTree(string root)
    {
        var result = new Dictionary<string, DirectoryAcl.Snapshot>(StringComparer.Ordinal);
        foreach (var path in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            using var item = DirectoryAcl.Open(path, DirectoryAcl.OrdinaryAclAccess, requireDirectory: false);
            result.Add(Path.GetRelativePath(root, path), item.Read());
        }
        return result;
    }

    private static T Measure<T>(string name, Func<T> action, List<object> intervals)
    {
        using var process = Process.GetCurrentProcess();
        if (!GetProcessIoCounters(process.Handle, out var before)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var cpuBefore = process.TotalProcessorTime;
        var begin = PreciseUtcNow();
        var timer = Stopwatch.StartNew();
        var result = action();
        var elapsed = timer.Elapsed.TotalMilliseconds;
        var end = PreciseUtcNow();
        process.Refresh();
        var cpu = (process.TotalProcessorTime - cpuBefore).TotalMilliseconds;
        if (!GetProcessIoCounters(process.Handle, out var after)) throw new Win32Exception(Marshal.GetLastWin32Error());
        intervals.Add(new { name, beginUtc = begin.ToString("O"), endUtc = end.ToString("O"), elapsedMilliseconds = elapsed,
            cpuMilliseconds = cpu, processId = Environment.ProcessId, threadId = GetCurrentThreadId(), result,
            io = new { readOperations = after.ReadOperations - before.ReadOperations, writeOperations = after.WriteOperations - before.WriteOperations,
                otherOperations = after.OtherOperations - before.OtherOperations, readBytes = after.ReadBytes - before.ReadBytes,
                writeBytes = after.WriteBytes - before.WriteBytes, otherBytes = after.OtherBytes - before.OtherBytes } });
        return result;
    }

    private static void WaitForCommand(string expected)
    {
        var value = Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60)).GetAwaiter().GetResult();
        if (value != expected) throw new IOException("The owned capture controller closed or sent an unexpected command.");
    }

    private static DateTime PreciseUtcNow()
    {
        GetSystemTimePreciseAsFileTime(out var value);
        return DateTime.FromFileTimeUtc(value);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern void GetSystemTimePreciseAsFileTime(out long value);
}
