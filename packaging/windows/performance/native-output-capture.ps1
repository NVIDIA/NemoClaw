# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Compile before timed work. Drain both pipes continuously while retaining only a
# bounded prefix. Snapshotting does not wait for EOF, including on tool timeout.
if (-not ('NemoClaw.Performance.BoundedOutput' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace NemoClaw.Performance {
    public static class TraceFileMetadata {
        [StructLayout(LayoutKind.Sequential)] private struct Info {
            public uint Attributes, CreatedLow, CreatedHigh, AccessLow, AccessHigh,
                WrittenLow, WrittenHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileSizeEx(SafeFileHandle file, out long size);
        public static object Read(string path) {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) {
                using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    return new { bytes = file.Length, attributes = (int)File.GetAttributes(path), method = "portable opened-file length; not Windows API proof" };
            }
            // Metadata-only, all share modes, no reparse traversal. Reading the
            // directory entry's cached size is insufficient for an active ETL.
            using (SafeFileHandle file = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x200000, IntPtr.Zero)) {
                if (file.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                Info info; long size;
                if (!GetFileInformationByHandle(file, out info) || !GetFileSizeEx(file, out size))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if ((info.Attributes & (0x400u | 0x10u)) != 0 || size < 0)
                    throw new IOException("Trace accounting requires an ordinary opened file.");
                return new { bytes = size, attributes = (int)info.Attributes, method = "GetFileSizeEx via FILE_READ_ATTRIBUTES handle" };
            }
        }
    }
    public sealed class BoundedOutput : IDisposable {
        private sealed class Channel {
            internal readonly object Gate = new object();
            internal readonly MemoryStream Bytes = new MemoryStream();
            internal readonly Stream Source;
            internal long Total;
            internal bool Failed;
            internal Channel(Stream source) { Source = source; }
            internal void Drain() {
                byte[] buffer = new byte[8192];
                try {
                    int count;
                    while ((count = Source.Read(buffer, 0, buffer.Length)) != 0) {
                        lock (Gate) {
                            Total += count;
                            int keep = (int)Math.Min(count, 1048576 - Bytes.Length);
                            if (keep > 0) Bytes.Write(buffer, 0, keep);
                        }
                    }
                } catch (IOException) { lock (Gate) { Failed = true; } }
                catch (ObjectDisposedException) { lock (Gate) { Failed = true; } }
            }
            internal byte[] Raw() { lock (Gate) { return Bytes.ToArray(); } }
            internal object Info() { lock (Gate) { return new { totalBytes = Total, retainedBytes = Bytes.Length, truncated = Total > Bytes.Length, readFailed = Failed }; } }
        }
        private readonly Channel stdout, stderr;
        private readonly Task outTask, errTask;
        public BoundedOutput(Process process) {
            stdout = new Channel(process.StandardOutput.BaseStream);
            stderr = new Channel(process.StandardError.BaseStream);
            outTask = Task.Factory.StartNew(stdout.Drain, TaskCreationOptions.LongRunning);
            errTask = Task.Factory.StartNew(stderr.Drain, TaskCreationOptions.LongRunning);
        }
        public bool Finish(int milliseconds) { return Task.WaitAll(new Task[] { outTask, errTask }, milliseconds); }
        public object Save(string path) {
            byte[] outBytes = stdout.Raw(), errBytes = stderr.Raw();
            File.WriteAllBytes(path + ".stdout.bin", outBytes);
            File.WriteAllBytes(path + ".stderr.bin", errBytes);
            File.WriteAllText(path, "[stdout]\n" + Encoding.UTF8.GetString(outBytes) + "\n[stderr]\n" + Encoding.UTF8.GetString(errBytes), new UTF8Encoding(false));
            return new { stdout = stdout.Info(), stderr = stderr.Info(), outputClosed = outTask.IsCompleted && errTask.IsCompleted, maximumBytesPerChannel = 1048576 };
        }
        public void Dispose() { try { stdout.Source.Dispose(); } finally { stderr.Source.Dispose(); } }
    }
}
'@
}
