// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace NemoClaw.InstalledConsole {
    // Test controller only. The caller verifies the installed guardian ancestry
    // before supplying its held runtime process; no foreground-window input is used.
    public sealed class Observer : IDisposable {
        [StructLayout(LayoutKind.Sequential)] struct Coord { public short x, y; }
        [StructLayout(LayoutKind.Sequential)] struct Rect { public short left, top, right, bottom; }
        [StructLayout(LayoutKind.Sequential)] struct BufferInfo {
            public Coord size, cursor;
            public ushort attributes;
            public Rect window;
            public Coord maximum;
        }
        [StructLayout(LayoutKind.Explicit, Size=20)] struct Key {
            [FieldOffset(0)] public ushort type;
            [FieldOffset(4)] public int down;
            [FieldOffset(8)] public ushort repeat;
            [FieldOffset(10)] public ushort virtualKey;
            [FieldOffset(12)] public ushort scan;
            [FieldOffset(14)] public ushort character;
            [FieldOffset(16)] public uint controls;
        }
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleMode(SafeFileHandle handle, out uint mode);
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint attributes, creationLow, creationHigh, accessLow, accessHigh,
                writeLow, writeHigh, volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
        }
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(SafeFileHandle handle, out BufferInfo info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool ReadConsoleOutputCharacterW(SafeFileHandle handle, StringBuilder text, uint count, Coord start, out uint read);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool WriteConsoleInputW(SafeFileHandle handle, Key[] records, uint count, out uint written);
        readonly Process target;
        SafeFileHandle input, output;
        bool attached, disposed;

        public Observer(Process process) {
            target = process;
            if (target.Handle == IntPtr.Zero) throw new InvalidOperationException("The owned terminal has no process handle.");
            if (target.HasExited) throw new InvalidOperationException("The owned terminal already exited.");
            // This controller is a separate, redirected child, never the user's shell.
            FreeConsole();
            try {
                if (!AttachConsole((uint)target.Id)) throw new Win32Exception(Marshal.GetLastWin32Error());
                attached = true;
                input = CreateFileW("CONIN$", 0xc0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                output = CreateFileW("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                if (input.IsInvalid || output.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                EnsureAlive();
            } catch { Dispose(); throw; }
        }

        void EnsureAlive() {
            if (disposed || target.HasExited) throw new InvalidOperationException("The owned terminal is no longer live.");
        }

        public bool RawInput {
            get {
                EnsureAlive();
                uint mode;
                if (!GetConsoleMode(input, out mode)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return (mode & 6) == 0; // LINE_INPUT and ECHO_INPUT are disabled by the real TUI.
            }
        }

        public string ReadScreen() {
            EnsureAlive();
            BufferInfo info;
            if (!GetConsoleScreenBufferInfo(output, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int width = info.size.x, rows = info.window.bottom - info.window.top + 1;
            if (width <= 0 || rows <= 0 || width > 1000 || rows > 200)
                throw new InvalidOperationException("The owned console dimensions exceed the observation bound.");
            var text = new StringBuilder(width * rows);
            uint read;
            if (!ReadConsoleOutputCharacterW(output, text, (uint)(width * rows), new Coord { x=0, y=info.window.top }, out read))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            EnsureAlive();
            return text.ToString();
        }

        public void Submit(string text) {
            EnsureAlive();
            if (text == null || text.Length == 0 || text.Length > 2048)
                throw new ArgumentException("The console input exceeds its bound.");
            foreach (char value in text)
                if (value < 32 || value > 126) throw new ArgumentException("Only printable test input is accepted.");
            if (!RawInput) throw new InvalidOperationException("The owned TUI is not accepting raw input.");
            var records = new Key[(text.Length + 1) * 2];
            for (int i=0; i<=text.Length; i++) {
                char value = i==text.Length ? '\r' : text[i];
                var key = new Key { type=1, down=1, repeat=1, character=value, virtualKey=(ushort)(value=='\r' ? 13 : 0) };
                records[i*2]=key;
                key.down=0;
                records[i*2+1]=key;
            }
            uint written;
            if (!WriteConsoleInputW(input, records, (uint)records.Length, out written) || written != records.Length)
                throw new InvalidOperationException("The owned console did not accept the complete input; do not retry it.");
        }

        // Read-only evidence. Hold every directory without delete sharing, then
        // open final files without following reparse points or accepting hard links.
        public static string[] ReadSessionFiles(string stateRoot) {
            string root = Path.GetFullPath(stateRoot);
            if (root.Length < 4 || root[1] != ':' || root[2] != '\\' || root.StartsWith("\\"))
                throw new ArgumentException("The session root must be a local absolute directory.");
            string encoded = "--" + root.TrimStart('/', '\\').Replace('/', '-').Replace('\\', '-').Replace(':', '-') + "--";
            string directory = Path.Combine(root, ".pi", "agent", "sessions", encoded);
            var held = new List<SafeFileHandle>();
            var documents = new List<string>();
            try {
                string current = Path.GetPathRoot(directory);
                var components = new List<string> { current };
                foreach (string segment in directory.Substring(current.Length).Split('\\')) {
                    current = Path.Combine(current, segment); components.Add(current);
                }
                foreach (string component in components) {
                    var handle = CreateFileW(component, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    if (handle.IsInvalid) {
                        int error = Marshal.GetLastWin32Error(); handle.Dispose();
                        if (error == 2 || error == 3) return new string[0];
                        throw new Win32Exception(error);
                    }
                    held.Add(handle);
                    FileInfo info;
                    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if ((info.attributes & 0x410) != 0x10) throw new IOException("Redirected session directory refused.");
                }
                int count = 0;
                foreach (string file in Directory.EnumerateFiles(directory)) {
                    if (++count > 8) throw new IOException("Session file count exceeded its bound.");
                    if (!file.EndsWith(".jsonl", StringComparison.Ordinal)) continue;
                    using (var handle = CreateFileW(file, 0x80000000, 3, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
                        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                        FileInfo info;
                        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        if ((info.attributes & 0x410) != 0 || info.links != 1 || info.sizeHigh != 0 || info.sizeLow > 1048576)
                            throw new IOException("Redirected, linked or oversized session file refused.");
                        using (var stream = new FileStream(handle, FileAccess.Read)) {
                            var bytes = new byte[1048577]; int read = 0, next;
                            while (read < bytes.Length && (next = stream.Read(bytes, read, bytes.Length-read)) > 0) read += next;
                            if (read > 1048576) throw new IOException("Growing session file exceeded its bound.");
                            documents.Add(Convert.ToBase64String(bytes, 0, read));
                        }
                    }
                }
                return documents.ToArray();
            } finally {
                for (int i=held.Count-1; i>=0; i--) held[i].Dispose();
            }
        }

        public void Dispose() {
            if (disposed) return;
            disposed=true;
            if (input != null) input.Dispose();
            if (output != null) output.Dispose();
            if (attached) { FreeConsole(); attached=false; }
        }
    }
}
