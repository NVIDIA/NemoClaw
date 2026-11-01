// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace Nvidia.NemoClaw.Bootstrapper;

// The job is unnamed and non-inheritable. JOB_LIST assigns the process at
// creation, before it can launch a supervisor. No PID-based ownership inference.
internal static class NativeGatewayProcess
{
    internal static int RunInstalled(string[] arguments)
    {
        if (arguments.Length < 4 || arguments[0] != "--gateway-process") return 2;
        return Run(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "bin", "openshell-gateway.exe")),
            arguments[4..], arguments[1], arguments[2], arguments[3]);
    }

    internal static int Run(string executable, string[] arguments, string stopPath, string receiptPath, string nonce)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        bool attributesInitialized = false;
        IntPtr jobValue = IntPtr.Zero;
        IntPtr handleValue = IntPtr.Zero;
        var handles = new List<IntPtr>();
        ProcessInformation process = default;
        try
        {
            if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(stopPath) ||
                !Path.IsPathFullyQualified(receiptPath) || nonce.Length != 48 ||
                nonce.Any(character => !"0123456789abcdef".Contains(character)) ||
                !StringComparer.OrdinalIgnoreCase.Equals(Path.GetDirectoryName(stopPath), Path.GetDirectoryName(receiptPath)) ||
                StringComparer.OrdinalIgnoreCase.Equals(stopPath, receiptPath) ||
                !Directory.Exists(Path.GetDirectoryName(stopPath)) || File.Exists(receiptPath) ||
                File.Exists(receiptPath + ".started") || File.Exists(receiptPath + ".started.pending"))
                return 2;

            job = CreateJobObjectW(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new ExtendedLimitInformation();
            limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway grants.
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()));

            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            Check(size != UIntPtr.Zero && size.ToUInt64() <= 64 * 1024);
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
            attributesInitialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x2000d, jobValue, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));

            var startup = new StartupInformationEx();
            startup.Startup.cb = Marshal.SizeOf<StartupInformationEx>();
            startup.Startup.flags = 0x100; // STARTF_USESTDHANDLES.
            startup.AttributeList = attributes;
            foreach (int standard in new[] { -10, -11, -12 })
            {
                IntPtr source = GetStdHandle(standard);
                Check(source != IntPtr.Zero && source != new IntPtr(-1));
                Check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out IntPtr copy, 0, true, 2));
                handles.Add(copy);
            }
            startup.Startup.Input = handles[0];
            startup.Startup.Output = handles[1];
            startup.Startup.Error = handles[2];
            handleValue = Marshal.AllocHGlobal(3 * IntPtr.Size);
            for (int index = 0; index < handles.Count; index++) Marshal.WriteIntPtr(handleValue, index * IntPtr.Size, handles[index]);
            Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x20002, handleValue, (UIntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            Check(command.Length < 32767);
            // Preserve an existing real console, but do not create a visible
            // console when the launcher deliberately started us without one.
            uint creationFlags = 0x80000u | (GetConsoleWindow() == IntPtr.Zero ? 0x08000000u : 0u);
            Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, creationFlags,
                IntPtr.Zero, null, ref startup, out process));
            using (var output = new FileStream(receiptPath + ".started.pending", FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(output, new { schemaVersion = 1, nonce, gatewayProcessId = process.ProcessId });
            File.Move(receiptPath + ".started.pending", receiptPath + ".started");
            CloseHandle(process.Thread);
            process.Thread = IntPtr.Zero;
            // Parent-side copies must not keep output pipes open during drain.
            foreach (IntPtr handle in handles) CloseHandle(handle);
            handles.Clear();

            bool requested = false;
            while (true)
            {
                uint wait = WaitForSingleObject(process.Process, 50);
                if (wait == 0) break;
                Check(wait == 258);
                if (File.Exists(stopPath))
                {
                    var info = new FileInfo(stopPath);
                    Check(info.Length == 48 && File.ReadAllText(stopPath) == nonce);
                    requested = true;
                    break;
                }
            }
            uint exitCode = 0;
            if (!requested) Check(GetExitCodeProcess(process.Process, out exitCode));
            Check(TerminateJobObject(job, 0));
            Check(WaitForSingleObject(process.Process, 5000) == 0);
            CloseHandle(process.Process);
            process.Process = IntPtr.Zero;
            var deadline = Stopwatch.StartNew();
            while (true)
            {
                Check(QueryInformationJobObject(job, 1, out AccountingInformation accounting,
                    (uint)Marshal.SizeOf<AccountingInformation>(), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) break;
                Check(deadline.ElapsedMilliseconds < 5000);
                Thread.Sleep(25);
            }
            // Only a completely drained job can produce this receipt. A killed
            // helper produces no receipt, so the launcher retains private state.
            using (var output = new FileStream(receiptPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(output, new { schemaVersion = 1, nonce, activeProcesses = 0, stopped = true, requested, gatewayExitCode = exitCode });
            return unchecked((int)exitCode);
        }
        catch
        {
            // No paths, gateway arguments, credentials, or exception data in logs.
            return 2;
        }
        finally
        {
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (job != IntPtr.Zero) CloseHandle(job);
            foreach (IntPtr handle in handles) CloseHandle(handle);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleValue != IntPtr.Zero) Marshal.FreeHGlobal(handleValue);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
        }
    }

    internal static string Quote(string argument)
    {
        if (argument.Contains('\0')) throw new ArgumentException("Invalid gateway argument.");
        var output = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { backslashes++; continue; }
            output.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            output.Append(character);
            backslashes = 0;
        }
        return output.Append('\\', backslashes * 2).Append('"').ToString();
    }

    private static void Check(bool condition) { if (!condition) throw new InvalidOperationException("Gateway ownership operation failed."); }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct AccountingInformation
    {
        public long UserTime, KernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
        public uint PageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInformation
    {
        public int cb;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInformationEx { public StartupInformation Startup; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimitInformation information, uint length);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out AccountingInformation information, uint length, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string? directory, ref StartupInformationEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
}
