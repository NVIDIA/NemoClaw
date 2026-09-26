# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Dot-source before starting a measured process. This file only defines read-only
# observers; it does not start/stop processes, change ACLs or alter system policy.
if (-not ('NemoClaw.WindowsPerformance.ProcessObserver' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
namespace NemoClaw.WindowsPerformance {
    public sealed class FileGrowth : IDisposable {
        private readonly string root;
        private readonly FileSystemWatcher watcher;
        private readonly ConcurrentQueue<string> pending = new ConcurrentQueue<string>();
        private readonly Dictionary<string,long> lengths = new Dictionary<string,long>(StringComparer.OrdinalIgnoreCase);
        private long observedEvents;
        private int queued;
        private volatile bool incomplete;
        public FileGrowth(string path) {
            root = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string parent = root;
            while (!Directory.Exists(parent)) {
                parent = Path.GetDirectoryName(parent);
                if (String.IsNullOrEmpty(parent)) throw new IOException("The observed root has no existing parent.");
            }
            watcher = new FileSystemWatcher(parent);
            watcher.IncludeSubdirectories = true;
            watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Size | NotifyFilters.LastWrite;
            watcher.InternalBufferSize = 32768;
            watcher.Created += delegate(object sender, FileSystemEventArgs e) { Add(e.FullPath); };
            watcher.Changed += delegate(object sender, FileSystemEventArgs e) { Add(e.FullPath); };
            watcher.Deleted += delegate(object sender, FileSystemEventArgs e) { Add(e.FullPath); };
            watcher.Renamed += delegate(object sender, RenamedEventArgs e) { Add(e.OldFullPath); Add(e.FullPath); };
            watcher.Error += delegate { incomplete = true; };
            watcher.EnableRaisingEvents = true;
        }
        private void Add(string path) {
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return;
            Interlocked.Increment(ref observedEvents);
            if (Interlocked.Increment(ref queued) > 100000) { Interlocked.Decrement(ref queued); incomplete = true; return; }
            pending.Enqueue(path);
        }
        public object Capture() {
            HashSet<string> changed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string value;
            for (int i = 0; i < 2048 && pending.TryDequeue(out value); i++) { Interlocked.Decrement(ref queued); changed.Add(value); }
            foreach (string file in changed) {
                try {
                    FileInfo info = new FileInfo(file);
                    if (info.Exists && (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0) lengths[file] = info.Length;
                    else lengths.Remove(file);
                } catch (IOException) { incomplete = true; }
                catch (UnauthorizedAccessException) { incomplete = true; }
            }
            long bytes = 0; foreach (long size in lengths.Values) bytes += size;
            return new { root = root, events = Interlocked.Read(ref observedEvents), observedFiles = lengths.Count,
                observedFootprintBytes = bytes, queuedEvents = queued, incomplete = incomplete,
                initialInventoryTaken = false, bytesCopied = (long?)null };
        }
        public void Dispose() { watcher.EnableRaisingEvents = false; watcher.Dispose(); }
    }
    public sealed class ProcessObserver : IDisposable {
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
            public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
        private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);
        [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, WindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
        private readonly Process process;
        private readonly IntPtr handle;
        private readonly FileGrowth growth;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly string image;
        private readonly ulong creation;
        public ProcessObserver(Process ownedProcess, string watchRoot) {
            process = ownedProcess;
            handle = ownedProcess.Handle; // borrowed; the caller retains this handle through cleanup
            int capacity = 32768; StringBuilder name = new StringBuilder(capacity);
            if (!QueryFullProcessImageName(handle, 0, name, ref capacity)) throw new System.ComponentModel.Win32Exception();
            image = name.ToString();
            FileTime start, end, kernel, user;
            if (!GetProcessTimes(handle, out start, out end, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
            creation = start.Value;
            if (!String.IsNullOrEmpty(watchRoot)) growth = new FileGrowth(watchRoot);
        }
        private static object Window(IntPtr window) {
            StringBuilder title = new StringBuilder(512); StringBuilder kind = new StringBuilder(128);
            GetClassName(window, kind, kind.Capacity);
            if (kind.ToString().IndexOf("Edit", StringComparison.OrdinalIgnoreCase) < 0) GetWindowText(window, title, title.Capacity);
            return new { handle = window.ToInt64().ToString("x"), className = kind.ToString(), title = title.ToString(), visible = IsWindowVisible(window), enabled = IsWindowEnabled(window) };
        }
        public object Capture() {
            FileTime start, end, kernel, user; IoCounters io;
            if (!GetProcessTimes(handle, out start, out end, out kernel, out user) || !GetProcessIoCounters(handle, out io))
                throw new System.ComponentModel.Win32Exception();
            if (start.Value != creation) throw new InvalidOperationException("The held process identity changed.");
            List<object> windows = new List<object>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint id; GetWindowThreadProcessId(window, out id);
                if (id == process.Id && IsWindowVisible(window) && windows.Count < 8) {
                    List<object> controls = new List<object>();
                    EnumChildWindows(window, delegate(IntPtr child, IntPtr ignored) {
                        uint owner; GetWindowThreadProcessId(child, out owner);
                        if (owner == process.Id && controls.Count < 64) controls.Add(Window(child));
                        return controls.Count < 64;
                    }, IntPtr.Zero);
                    windows.Add(new { window = Window(window), controls = controls });
                }
                return true;
            }, IntPtr.Zero);
            return new { processId = process.Id, creationFileTime = creation.ToString(), executable = image,
                captureClockOrigin = "observer construction after process start", capturedMs = clock.Elapsed.TotalMilliseconds, cpuMs = (kernel.Value + user.Value) / 10000.0,
                readOperations = io.ReadOperations.ToString(), writeOperations = io.WriteOperations.ToString(),
                readTransferBytes = io.ReadBytes.ToString(), writeTransferBytes = io.WriteBytes.ToString(),
                otherOperations = io.OtherOperations.ToString(), ioScope = "all process I/O, not file-only",
                processScope = "exact held root process, not automatically descendants", windows = windows,
                fileGrowth = growth == null ? null : growth.Capture() };
        }
        public void Dispose() { if (growth != null) growth.Dispose(); } // never disposes the caller's process
    }
}
'@
}

function New-WindowsPerformanceObserver {
    [CmdletBinding()]
    param([Parameter(Mandatory)][Diagnostics.Process]$Process, [string]$WatchPath = '')
    if ($env:OS -cne 'Windows_NT') { throw 'Native process/window sampling requires Windows.' }
    return [NemoClaw.WindowsPerformance.ProcessObserver]::new($Process, $WatchPath)
}

function Write-WindowsPerformanceSample {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Observer, [Parameter(Mandatory)][string]$OutputPath)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $sample = $Observer.Capture()
    $sample = [pscustomobject]@{
        measurement = $sample
        observerCaptureMs = $clock.Elapsed.TotalMilliseconds
        observerProcessId = $PID
        observerCpuMs = (Get-Process -Id $PID).TotalProcessorTime.TotalMilliseconds
    }
    $line = ($sample | ConvertTo-Json -Depth 8 -Compress) + "`n"
    if ((Test-Path -LiteralPath $OutputPath) -and (Get-Item -LiteralPath $OutputPath).Length -gt 4MB) {
        throw 'The performance sample log reached its bounded capture size.'
    }
    [IO.File]::AppendAllText($OutputPath, $line, [Text.UTF8Encoding]::new($false))
    return $sample
}
