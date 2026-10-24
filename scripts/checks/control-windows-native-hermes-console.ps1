# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][int]$NativeNodeProcessId,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][ValidatePattern('^NEMOCLAW_INTERACTIVE_INPUT_[a-f0-9]{16}$')][string]$InputMarker,
    [Parameter(Mandatory)][ValidatePattern('^NEMOCLAW_INTERACTIVE_OUTPUT_[a-f0-9]{16}$')][string]$OutputMarker
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @([Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class NemoClawInteractiveConsole {
    [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X, Y; public Coord(short x, short y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct SmallRect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct BufferInfo { public Coord Size, Cursor; public ushort Attributes; public SmallRect Window; public Coord Maximum; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct KeyEvent {
        [MarshalAs(UnmanagedType.Bool)] public bool Down;
        public ushort Repeat, VirtualKey, ScanCode;
        public char Character;
        public uint ControlState;
    }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] private struct InputRecord {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public KeyEvent Key;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] private static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out BufferInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ReadConsoleOutputCharacterW(IntPtr handle, StringBuilder text, uint length, Coord start, out uint read);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool WriteConsoleInputW(IntPtr handle, InputRecord[] records, uint length, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleScreenBufferSize(IntPtr handle, Coord size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleWindowInfo(IntPtr handle, bool absolute, ref SmallRect window);
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetConsoleTitleW(string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern short VkKeyScanW(char character);
    [DllImport("user32.dll")] private static extern uint MapVirtualKeyW(uint code, uint map);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    private static IntPtr input, output;
    public static void Attach(int processId) {
        FreeConsole();
        if (!AttachConsole((uint)processId)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not attach to the owned native console.");
        input = GetStdHandle(-10); output = GetStdHandle(-11);
        uint mode;
        if (!GetConsoleMode(input, out mode) || !GetConsoleMode(output, out mode)) throw new InvalidOperationException("The owned process has no Windows console handles.");
        Snapshot();
    }
    public static void Detach() { FreeConsole(); }
    public static void MarkVisibleConsole() {
        if (!SetConsoleTitleW("NemoClaw Hermes Interactive Console")) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static BufferInfo Snapshot() {
        BufferInfo info;
        if (!GetConsoleScreenBufferInfo(output, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "The native console has no screen buffer.");
        return info;
    }
    public static uint InputMode() {
        uint mode;
        if (!GetConsoleMode(input, out mode)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return mode;
    }
    public static string ReadVisibleText() {
        BufferInfo info = Snapshot();
        int length = info.Size.X * (info.Window.Bottom - info.Window.Top + 1);
        if (length < 1 || length > 131072) throw new InvalidOperationException("Console viewport exceeds the proof bound.");
        var text = new StringBuilder(length); uint read;
        if (!ReadConsoleOutputCharacterW(output, text, (uint)length, new Coord(0, info.Window.Top), out read)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return text.ToString();
    }
    public static void TypeLine(string text) {
        if (text.Length > 256) throw new InvalidOperationException("Console proof input exceeds its bound.");
        var records = new List<InputRecord>();
        foreach (char character in text + "\r") {
            short mapped = VkKeyScanW(character);
            ushort key = character == '\r' ? (ushort)13 : (ushort)(mapped & 255);
            uint control = (mapped & 256) != 0 ? 16u : 0u;
            var press = new InputRecord { Type = 1, Key = new KeyEvent { Down = true, Repeat = 1, VirtualKey = key, ScanCode = (ushort)MapVirtualKeyW(key, 0), Character = character, ControlState = control } };
            records.Add(press); press.Key.Down = false; records.Add(press);
        }
        uint written;
        if (!WriteConsoleInputW(input, records.ToArray(), (uint)records.Count, out written) || written != records.Count) throw new Win32Exception(Marshal.GetLastWin32Error(), "Native console input was incomplete.");
    }
    public static BufferInfo Resize() {
        BufferInfo before = Snapshot();
        short columns = (short)Math.Max(60, Math.Min(100, before.Window.Right - before.Window.Left - 6));
        short rows = (short)Math.Max(15, Math.Min(28, before.Window.Bottom - before.Window.Top - 2));
        var rect = new SmallRect { Left = 0, Top = 0, Right = (short)(columns - 1), Bottom = (short)(rows - 1) };
        if (!SetConsoleWindowInfo(output, true, ref rect)) throw new Win32Exception(Marshal.GetLastWin32Error(), "The real console window could not resize.");
        if (!SetConsoleScreenBufferSize(output, new Coord(columns, before.Size.Y))) throw new Win32Exception(Marshal.GetLastWin32Error(), "The real console buffer could not resize.");
        BufferInfo after = Snapshot();
        if (after.Window.Right - after.Window.Left + 1 != columns || after.Window.Bottom - after.Window.Top + 1 != rows) throw new InvalidOperationException("The console did not retain the requested size.");
        return after;
    }
    private static IntPtr VisibleWindow() {
        IntPtr direct = GetConsoleWindow();
        if (direct != IntPtr.Zero && IsWindowVisible(direct)) return direct;
        IntPtr found = IntPtr.Zero; int matches = 0;
        EnumWindows(delegate(IntPtr window, IntPtr ignored) {
            var title = new StringBuilder(512); GetWindowText(window, title, title.Capacity);
            if (IsWindowVisible(window) && title.ToString().IndexOf("Hermes", StringComparison.OrdinalIgnoreCase) >= 0) { found = window; matches++; }
            return true;
        }, IntPtr.Zero);
        if (matches != 1) throw new InvalidOperationException("The real Hermes terminal window is missing or ambiguous.");
        return found;
    }
    public static void SaveFrame(string path) {
        IntPtr window = VisibleWindow(); SetForegroundWindow(window); Rect rect;
        if (!GetWindowRect(window, out rect)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width < 200 || height < 150 || width > 8192 || height > 8192) throw new InvalidOperationException("The Hermes terminal capture dimensions are invalid.");
        using (var bitmap = new Bitmap(width, height)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                IntPtr dc = graphics.GetHdc();
                try { if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("Real Hermes terminal capture failed."); }
                finally { graphics.ReleaseHdc(dc); }
            }
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@

$root = [IO.Path]::GetFullPath($ArtifactDirectory)
$resultPath = Join-Path $root 'console-control.json'
$exitCode = 1
try {
    [NemoClawInteractiveConsole]::Attach($NativeNodeProcessId)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $prompt = $false
    do {
        $screen = [NemoClawInteractiveConsole]::ReadVisibleText()
        if ($screen -match 'NoConsoleScreenBufferError|native terminal launch failed') { throw 'The real Hermes terminal failed before its prompt.' }
        $mode = [NemoClawInteractiveConsole]::InputMode()
        $prompt = $screen -match '(?i)hermes' -and ($mode -band 6) -eq 0
        if ($prompt) { break }
        Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt 120000)
    if (-not $prompt) { throw 'The real Hermes prompt did not enter native interactive input mode.' }
    [NemoClawInteractiveConsole]::MarkVisibleConsole()
    [IO.File]::WriteAllText((Join-Path $root 'hermes-prompt.txt'), $screen, [Text.UTF8Encoding]::new($false))
    [NemoClawInteractiveConsole]::SaveFrame((Join-Path $root 'hermes-prompt.png'))
    $before = [NemoClawInteractiveConsole]::Snapshot()
    $after = [NemoClawInteractiveConsole]::Resize()
    Start-Sleep -Milliseconds 500
    [NemoClawInteractiveConsole]::SaveFrame((Join-Path $root 'hermes-resized.png'))
    [NemoClawInteractiveConsole]::TypeLine("Please acknowledge this diagnostic token: $InputMarker")
    $clock.Restart()
    $responseObserved = $false
    do {
        $screen = [NemoClawInteractiveConsole]::ReadVisibleText()
        if ($screen.Contains($OutputMarker)) { $responseObserved = $true; break }
        if ($screen -match 'NoConsoleScreenBufferError|native terminal launch failed') { throw 'The real Hermes terminal failed while handling the message.' }
        Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt 120000)
    if (-not $responseObserved) { throw 'The provider response did not appear in the real Hermes terminal.' }
    [IO.File]::WriteAllText((Join-Path $root 'hermes-response.txt'), $screen, [Text.UTF8Encoding]::new($false))
    [NemoClawInteractiveConsole]::SaveFrame((Join-Path $root 'hermes-response.png'))
    [NemoClawInteractiveConsole]::TypeLine('/exit')
    $result = [pscustomobject]@{
        schemaVersion = 1
        classification = 'native-interactive-hermes-console'
        nodeProcessId = $NativeNodeProcessId
        visiblePrompt = $true
        interactiveInputMode = $mode
        inputMarker = $InputMarker
        outputMarker = $OutputMarker
        typedMessage = $true
        visibleProviderResponse = $true
        resizeApplied = $true
        beforeColumns = $before.Window.Right - $before.Window.Left + 1
        beforeRows = $before.Window.Bottom - $before.Window.Top + 1
        afterColumns = $after.Window.Right - $after.Window.Left + 1
        afterRows = $after.Window.Bottom - $after.Window.Top + 1
        exitCommandEntered = $true
    }
    [IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    $exitCode = 0
} catch {
    [IO.File]::WriteAllText((Join-Path $root 'console-control-failure.txt'), $_.Exception.Message, [Text.UTF8Encoding]::new($false))
    try { [NemoClawInteractiveConsole]::TypeLine('/exit') } catch { }
} finally {
    [NemoClawInteractiveConsole]::Detach()
}
exit $exitCode
