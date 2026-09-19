// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace NemoClaw.InstalledIdle {
    // CI observer only. It has no termination, process-memory, ACL or file-write API.
    public sealed class Counter : IDisposable {
        [StructLayout(LayoutKind.Sequential)] private struct FileTime {
            public uint Low, High;
            public ulong Value { get { return ((ulong)High << 32) | Low; } }
        }
        [StructLayout(LayoutKind.Sequential)] private struct Io {
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int id);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(SafeProcessHandle handle, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessIoCounters(SafeProcessHandle handle, out Io counters);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(SafeProcessHandle handle, uint flags, StringBuilder name, ref int length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
        private readonly SafeProcessHandle handle;
        private readonly int processId;
        private readonly string role, image;
        private readonly ulong creation;

        public Counter(int id, string expectedImage, string expectedCreation, int tolerance100ns, string label) {
            if (id <= 0 || tolerance100ns < 0 || tolerance100ns > 10) throw new ArgumentException("Invalid process identity bound.");
            ulong expected;
            if (!UInt64.TryParse(expectedCreation, out expected) || expected == 0) throw new ArgumentException("Invalid creation identity.");
            processId = id; role = label;
            handle = OpenProcess(0x00101000, false, id); // limited query + synchronize, noninheritable
            try {
                if (handle.IsInvalid) throw new Win32Exception();
                int capacity = 32768;
                StringBuilder name = new StringBuilder(capacity);
                if (!QueryFullProcessImageName(handle, 0, name, ref capacity)) throw new Win32Exception();
                image = name.ToString();
                if (!String.Equals(System.IO.Path.GetFullPath(image), System.IO.Path.GetFullPath(expectedImage), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The held process image differs from its owned role.");
                FileTime created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception();
                creation = created.Value;
                ulong difference = creation > expected ? creation - expected : expected - creation;
                if (difference > (ulong)tolerance100ns) throw new InvalidOperationException("The process creation identity changed.");
                RequireAlive();
            } catch { handle.Dispose(); throw; }
        }
        private void RequireAlive() {
            uint result = WaitForSingleObject(handle, 0);
            if (result == 0xffffffff) throw new Win32Exception();
            if (result != 258) throw new InvalidOperationException("The exact held observation process exited.");
        }
        public object Snapshot() {
            RequireAlive();
            FileTime created, exited, kernel, user; Io io;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user) || !GetProcessIoCounters(handle, out io)) throw new Win32Exception();
            RequireAlive();
            if (created.Value != creation) throw new InvalidOperationException("The held process identity changed.");
            return new { role, processId, executable = image, creationFileTime = creation.ToString(),
                capturedTicks = Stopwatch.GetTimestamp().ToString(), kernel100ns = kernel.Value.ToString(), user100ns = user.Value.ToString(),
                readOperations = io.ReadOps.ToString(), writeOperations = io.WriteOps.ToString(), otherOperations = io.OtherOps.ToString(),
                readTransferBytes = io.ReadBytes.ToString(), writeTransferBytes = io.WriteBytes.ToString(), otherTransferBytes = io.OtherBytes.ToString() };
        }
        public void Dispose() { handle.Dispose(); }
    }
}
