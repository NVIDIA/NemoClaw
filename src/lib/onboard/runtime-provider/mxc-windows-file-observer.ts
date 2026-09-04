// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { MxcOpenShellAttachmentError } from "./mxc-openshell-attachment";
import {
  MxcOpenShellObservationError,
  type MxcOpenShellFileDigestObserver,
  type MxcOpenShellObservationFailure,
} from "./mxc-openshell-observer";

const execFileAsync = promisify(execFile);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:\\/u;
const MAX_PATH_BYTES = 4096;
const OBSERVATION_TIMEOUT_MS = 30_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const OBSERVER_FAILURE_PREFIX = "NEMOCLAW_MXC_OBSERVER_ERROR:";

const STABLE_WINDOWS_FILE_DIGEST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    [Console]::Out.Write('NEMOCLAW_MXC_OBSERVER_ERROR:observer-unavailable')
    exit 0
}
try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class NemoClawStableFileObserver
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint Attributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information);

    private static SafeFileHandle Open(string fileName, uint access, uint flags)
    {
        SafeFileHandle handle = CreateFileW(
            fileName,
            access,
            // Excluding FILE_SHARE_WRITE and FILE_SHARE_DELETE pins every opened path component.
            FILE_SHARE_READ,
            IntPtr.Zero,
            OPEN_EXISTING,
            flags,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    private static BY_HANDLE_FILE_INFORMATION Information(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return information;
    }

    private static bool SameFile(
        BY_HANDLE_FILE_INFORMATION left,
        BY_HANDLE_FILE_INFORMATION right)
    {
        return left.VolumeSerialNumber == right.VolumeSerialNumber
            && left.FileIndexHigh == right.FileIndexHigh
            && left.FileIndexLow == right.FileIndexLow
            && left.FileSizeHigh == right.FileSizeHigh
            && left.FileSizeLow == right.FileSizeLow
            && left.LastWriteTime.High == right.LastWriteTime.High
            && left.LastWriteTime.Low == right.LastWriteTime.Low;
    }

    private static void RequireRegularFile(BY_HANDLE_FILE_INFORMATION information)
    {
        if ((information.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
            || (information.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        {
            throw new IOException("The observed object is not a regular file.");
        }
    }

    private static List<SafeFileHandle> PinAncestors(string fileName)
    {
        string root = Path.GetPathRoot(fileName);
        if (String.IsNullOrEmpty(root))
        {
            throw new IOException("The observed path has no local root.");
        }

        var handles = new List<SafeFileHandle>();
        string current = root;
        try
        {
            SafeFileHandle rootHandle = Open(
                current,
                FILE_READ_ATTRIBUTES,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
            BY_HANDLE_FILE_INFORMATION rootInformation = Information(rootHandle);
            if ((rootInformation.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
                || (rootInformation.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                rootHandle.Dispose();
                throw new IOException("The local root is not a plain directory.");
            }
            handles.Add(rootHandle);
            string relative = fileName.Substring(root.Length);
            string[] components = relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
            for (int index = 0; index < components.Length - 1; index++)
            {
                current = Path.Combine(current, components[index]);
                SafeFileHandle handle = Open(
                    current,
                    FILE_READ_ATTRIBUTES,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
                BY_HANDLE_FILE_INFORMATION information = Information(handle);
                if ((information.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
                    || (information.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                {
                    handle.Dispose();
                    throw new IOException("An ancestor is not a plain directory.");
                }
                handles.Add(handle);
            }
            return handles;
        }
        catch
        {
            foreach (SafeFileHandle handle in handles) handle.Dispose();
            throw;
        }
    }

    public static string ObserveSha256(string fileName)
    {
        string fullPath = Path.GetFullPath(fileName);
        List<SafeFileHandle> ancestors = PinAncestors(fullPath);
        try
        {
            using (SafeFileHandle primary = Open(
                fullPath,
                GENERIC_READ,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN))
            {
                BY_HANDLE_FILE_INFORMATION before = Information(primary);
                RequireRegularFile(before);
                byte[] digest;
                using (var stream = new FileStream(primary, FileAccess.Read, 1024 * 1024, false))
                using (SHA256 sha256 = SHA256.Create())
                {
                    digest = sha256.ComputeHash(stream);
                    BY_HANDLE_FILE_INFORMATION after = Information(primary);
                    RequireRegularFile(after);
                    if (!SameFile(before, after))
                    {
                        throw new IOException("The file changed during observation.");
                    }
                    using (SafeFileHandle reopened = Open(
                        fullPath,
                        GENERIC_READ,
                        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN))
                    {
                        BY_HANDLE_FILE_INFORMATION current = Information(reopened);
                        RequireRegularFile(current);
                        if (!SameFile(after, current))
                        {
                            throw new IOException("The path identity changed during observation.");
                        }
                    }
                }
                return BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            }
        }
        finally
        {
            foreach (SafeFileHandle handle in ancestors) handle.Dispose();
        }
    }
}
'@
}
catch {
    [Console]::Out.Write('NEMOCLAW_MXC_OBSERVER_ERROR:observer-unavailable')
    exit 0
}

$pathBytes = [Convert]::FromBase64String($env:NEMOCLAW_MXC_OBSERVER_PATH_B64)
$observedPath = [Text.Encoding]::UTF8.GetString($pathBytes)
try {
    [Console]::Out.Write([NemoClawStableFileObserver]::ObserveSha256($observedPath))
}
catch {
    [Console]::Out.Write('NEMOCLAW_MXC_OBSERVER_ERROR:observation-rejected')
}
`;

export interface MxcWindowsFileObserverCommand {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export type MxcWindowsFileObserverCommandRunner = (
  command: MxcWindowsFileObserverCommand,
) => Promise<string>;

export interface MxcWindowsFileObserverRuntime {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly runCommand: MxcWindowsFileObserverCommandRunner;
}

async function runCommand(command: MxcWindowsFileObserverCommand): Promise<string> {
  const result = await execFileAsync(command.executablePath, [...command.arguments], {
    encoding: "utf8",
    env: command.environment,
    maxBuffer: 64 * 1024,
    timeout: command.timeoutMs,
    windowsHide: true,
  });
  return result.stdout;
}

const DEFAULT_RUNTIME: MxcWindowsFileObserverRuntime = {
  platform: process.platform,
  environment: process.env,
  runCommand,
};

function canonicalLocalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !LOCAL_DRIVE_PATH_PATTERN.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcOpenShellAttachmentError(
      `${label} must be a canonical absolute local-drive Windows path`,
    );
  }
  return value;
}

function commandEnvironment(source: NodeJS.ProcessEnv, observedPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: WINDOWS_SYSTEM_ROOT,
    WINDIR: WINDOWS_SYSTEM_ROOT,
    NEMOCLAW_MXC_OBSERVER_PATH_B64: Buffer.from(observedPath, "utf8").toString("base64"),
  };
  if (source.TEMP) environment.TEMP = source.TEMP;
  if (source.TMP) environment.TMP = source.TMP;
  return environment;
}

function observationFailure(output: string): MxcOpenShellObservationFailure | undefined {
  if (!output.startsWith(OBSERVER_FAILURE_PREFIX)) return undefined;
  const failure = output.slice(OBSERVER_FAILURE_PREFIX.length);
  return failure === "observer-unavailable" || failure === "observation-rejected"
    ? failure
    : "invalid-output";
}

/**
 * Create the native Windows stable-file digest boundary for inactive MXC attachment.
 *
 * Windows PowerShell must permit FullLanguage and Add-Type. Hosts that block the required native
 * API observer fail closed as `observer-unavailable`; installation rejection remains distinct.
 */
export function createMxcWindowsOpenShellFileDigestObserver(
  runtime: MxcWindowsFileObserverRuntime = DEFAULT_RUNTIME,
): MxcOpenShellFileDigestObserver {
  return async (filePath) => {
    if (runtime.platform !== "win32") {
      throw new MxcOpenShellObservationError("unsupported-platform");
    }
    let observedPath: string;
    try {
      observedPath = canonicalLocalWindowsPath(filePath, "installation file path");
    } catch {
      throw new MxcOpenShellObservationError("invalid-path");
    }
    try {
      const powershellPath = path.win32.join(
        WINDOWS_SYSTEM_ROOT,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const encodedCommand = Buffer.from(STABLE_WINDOWS_FILE_DIGEST_SCRIPT, "utf16le").toString(
        "base64",
      );
      const output = (
        await runtime.runCommand({
          executablePath: powershellPath,
          arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "AllSigned",
            "-EncodedCommand",
            encodedCommand,
          ],
          environment: commandEnvironment(runtime.environment, observedPath),
          timeoutMs: OBSERVATION_TIMEOUT_MS,
        })
      ).trim();
      const failure = observationFailure(output);
      if (failure) throw new MxcOpenShellObservationError(failure);
      if (!SHA256_PATTERN.test(output)) throw new MxcOpenShellObservationError("invalid-output");
      return output;
    } catch (error) {
      if (error instanceof MxcOpenShellObservationError) throw error;
      throw new MxcOpenShellObservationError("observer-unavailable");
    }
  };
}
