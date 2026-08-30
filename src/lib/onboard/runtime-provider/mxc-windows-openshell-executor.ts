// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cloneAndDeepFreeze } from "../../core/immutable";
import {
  qualifyMxcOpenShellAttachment,
  resolveMxcOpenShellDistributionAuthority,
  type MxcOpenShellAttachmentReceipt,
  type MxcOpenShellDistributionAuthority,
} from "./mxc-openshell-attachment";
import { requireIssuedMxcOpenShellCreateRequest } from "./mxc-openshell-create-request";
import type {
  MxcOpenShellLiveCommand,
  MxcOpenShellLiveCommandResult,
  MxcOpenShellLiveFailureRecord,
  MxcOpenShellLiveHostBoundary,
} from "./mxc-openshell-live-operations";
import {
  observeMxcOpenShellAttachment,
  type MxcOpenShellAttachmentObservationRequest,
  type MxcOpenShellFileDigestObserver,
} from "./mxc-openshell-observer";
import { createMxcWindowsOpenShellFileDigestObserver } from "./mxc-windows-file-observer";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:\\/u;
const MAX_PATH_BYTES = 4096;
const MAX_ARTIFACT_ENTRIES = 100_000;
const MAX_PIN_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
const MAX_COMMAND_ARGUMENT_BYTES = 1024 * 1024;
const PIN_TIMEOUT_MS = 60_000;
const PIN_RELEASE_TIMEOUT_MS = 5_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";

type FileBinding = Readonly<{ path: string; sha256: string }>;

export interface MxcWindowsOpenShellArtifactTree {
  readonly directories: readonly string[];
  readonly files: readonly FileBinding[];
  readonly sha256: string;
}

export interface MxcWindowsOpenShellPinRequest {
  readonly directories: readonly string[];
  readonly files: readonly FileBinding[];
}

export interface MxcWindowsOpenShellPinLease {
  isActive(): boolean;
  waitForLoss(): Promise<void>;
  release(): Promise<void>;
}

export interface MxcWindowsOpenShellExecutorRuntime {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly observeFileDigest: MxcOpenShellFileDigestObserver;
  observeArtifactTree(root: string): MxcWindowsOpenShellArtifactTree;
  acquirePins(request: MxcWindowsOpenShellPinRequest): Promise<MxcWindowsOpenShellPinLease>;
  runCommand(
    command: MxcOpenShellLiveCommand,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<MxcOpenShellLiveCommandResult>;
}

export interface MxcWindowsOpenShellExecutorInput {
  readonly distributionAuthority: MxcOpenShellDistributionAuthority;
  readonly observationRequest: MxcOpenShellAttachmentObservationRequest;
  readonly recordFailure?: (record: MxcOpenShellLiveFailureRecord) => void;
  readonly runtime?: MxcWindowsOpenShellExecutorRuntime;
}

export class MxcWindowsOpenShellExecutorError extends Error {
  constructor(
    message: string,
    readonly mutationState: "not-started" | "unknown" = "not-started",
  ) {
    super(`Inactive Windows OpenShell executor failed: ${message}`);
    this.name = "MxcWindowsOpenShellExecutorError";
  }
}

const PIN_FILES_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    [Console]::Out.WriteLine('NEMOCLAW_MXC_PIN_ERROR')
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

public sealed class NemoClawPinnedFiles : IDisposable
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
    private struct FILETIME { public uint Low; public uint High; }

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
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file, out BY_HANDLE_FILE_INFORMATION information);

    private readonly List<IDisposable> resources = new List<IDisposable>();

    private static SafeFileHandle Open(string path, uint access, uint flags)
    {
        SafeFileHandle handle = CreateFileW(
            path, access, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
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
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return information;
    }

    private static void RequireDirectory(BY_HANDLE_FILE_INFORMATION information)
    {
        if ((information.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || (information.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            throw new IOException("Pinned path is not a plain directory.");
    }

    private static void RequireFile(BY_HANDLE_FILE_INFORMATION information)
    {
        if ((information.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
            || (information.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            throw new IOException("Pinned path is not a regular file.");
    }

    public void PinDirectory(string path)
    {
        SafeFileHandle handle = Open(
            Path.GetFullPath(path), FILE_READ_ATTRIBUTES,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        try { RequireDirectory(Information(handle)); }
        catch { handle.Dispose(); throw; }
        resources.Add(handle);
    }

    public void PinFile(string path, string expectedSha256)
    {
        SafeFileHandle handle = Open(
            Path.GetFullPath(path), GENERIC_READ,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN);
        try
        {
            RequireFile(Information(handle));
            var stream = new FileStream(handle, FileAccess.Read, 1024 * 1024, false);
            byte[] digest;
            using (SHA256 sha256 = SHA256.Create()) digest = sha256.ComputeHash(stream);
            string actual = BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actual, expectedSha256, StringComparison.Ordinal))
            {
                stream.Dispose();
                throw new IOException("Pinned file digest does not match.");
            }
            stream.Position = 0;
            resources.Add(stream);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        for (int index = resources.Count - 1; index >= 0; index--) resources[index].Dispose();
        resources.Clear();
    }
}
'@

    $payloadLine = [Console]::In.ReadLine()
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadLine)) |
        ConvertFrom-Json
    $pins = New-Object NemoClawPinnedFiles
    try {
        foreach ($directory in $payload.directories) { $pins.PinDirectory([string]$directory) }
        foreach ($file in $payload.files) { $pins.PinFile([string]$file.path, [string]$file.sha256) }
        [Console]::Out.WriteLine('NEMOCLAW_MXC_PIN_READY')
        [Console]::Out.Flush()
        [void][Console]::In.ReadLine()
    }
    finally { $pins.Dispose() }
}
catch {
    [Console]::Out.WriteLine('NEMOCLAW_MXC_PIN_ERROR')
}
`;

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !LOCAL_DRIVE_PATH_PATTERN.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcWindowsOpenShellExecutorError(`${label} is not a canonical local Windows path`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new MxcWindowsOpenShellExecutorError(`${label} is invalid`);
  }
  return value;
}

function requireContentDigest(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new MxcWindowsOpenShellExecutorError(`${label} is invalid`);
  }
  return requireDigest(value.startsWith("sha256:") ? value.slice("sha256:".length) : value, label);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function artifactTree(root: string): MxcWindowsOpenShellArtifactTree {
  const canonicalRoot = canonicalWindowsPath(root, "artifact root");
  const rootStatus = fs.lstatSync(canonicalRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new MxcWindowsOpenShellExecutorError("artifact root is not a plain directory");
  }
  const directories: string[] = [canonicalRoot];
  const files: FileBinding[] = [];
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.win32.join(directory, entry.name);
      const status = fs.lstatSync(candidate);
      if (status.isSymbolicLink()) {
        throw new MxcWindowsOpenShellExecutorError("artifact tree contains a link");
      }
      if (status.isDirectory()) {
        directories.push(candidate);
        pending.push(candidate);
      } else if (status.isFile()) {
        files.push({ path: candidate, sha256: sha256File(candidate) });
      } else {
        throw new MxcWindowsOpenShellExecutorError("artifact tree contains an unsupported file");
      }
      if (files.length + directories.length > MAX_ARTIFACT_ENTRIES) {
        throw new MxcWindowsOpenShellExecutorError("artifact tree exceeds its entry bound");
      }
    }
  }
  files.sort((left, right) => {
    const a = path.win32.relative(canonicalRoot, left.path).replaceAll("\\", "/");
    const b = path.win32.relative(canonicalRoot, right.path).replaceAll("\\", "/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  directories.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.win32.relative(canonicalRoot, file.path).replaceAll("\\", "/"), "utf8");
    digest.update("\0", "utf8");
    digest.update(file.sha256, "utf8");
    digest.update("\n", "utf8");
  }
  return cloneAndDeepFreeze({ directories, files, sha256: digest.digest("hex") });
}

function parentDirectories(filePaths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    let current = path.win32.dirname(filePath);
    const root = path.win32.parse(filePath).root;
    while (current.toLowerCase() !== root.toLowerCase()) {
      directories.add(current);
      current = path.win32.dirname(current);
    }
  }
  return [...directories].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
}

function attachmentFiles(
  attachment: MxcOpenShellAttachmentReceipt,
  observationRequest: MxcOpenShellAttachmentObservationRequest,
): readonly FileBinding[] {
  return cloneAndDeepFreeze([
    {
      path: observationRequest.installation.distributionArtifactPath,
      sha256: attachment.distribution.sha256,
    },
    attachment.components.cli,
    attachment.components.gateway,
    { path: attachment.components.wxcExec.path, sha256: attachment.components.wxcExec.sha256 },
    { path: attachment.gateway.configPath, sha256: attachment.gateway.configSha256 },
  ]);
}

function safeCommandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "appdata",
    "comspec",
    "home",
    "localappdata",
    "path",
    "pathext",
    "systemdrive",
    "systemroot",
    "temp",
    "tmp",
    "userprofile",
    "windir",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(name.toLowerCase())) environment[name] = value;
  }
  environment.SystemRoot = WINDOWS_SYSTEM_ROOT;
  environment.WINDIR = WINDOWS_SYSTEM_ROOT;
  return environment;
}

function requireCommand(
  command: MxcOpenShellLiveCommand,
  attachment: MxcOpenShellAttachmentReceipt,
  allowedOperations: readonly string[],
): void {
  if (
    canonicalWindowsPath(command.executablePath, "command executable").toLowerCase() !==
    attachment.components.cli.path.toLowerCase()
  ) {
    throw new MxcWindowsOpenShellExecutorError("only the qualified OpenShell CLI may run");
  }
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs <= 0 ||
    command.timeoutMs > 5 * 60_000
  ) {
    throw new MxcWindowsOpenShellExecutorError("command timeout is invalid");
  }
  let totalBytes = 0;
  for (const argument of command.arguments) {
    if (typeof argument !== "string" || CONTROL_CHARACTER_PATTERN.test(argument)) {
      throw new MxcWindowsOpenShellExecutorError("command argument is invalid");
    }
    totalBytes += Buffer.byteLength(argument, "utf8");
  }
  if (totalBytes > MAX_COMMAND_ARGUMENT_BYTES) {
    throw new MxcWindowsOpenShellExecutorError("command arguments exceed their bound");
  }
  const sandboxIndex = command.arguments.indexOf("sandbox");
  const operation = sandboxIndex < 0 ? undefined : command.arguments[sandboxIndex + 1];
  if (!operation || !allowedOperations.includes(operation)) {
    throw new MxcWindowsOpenShellExecutorError(
      "OpenShell command is outside the allowed operation",
    );
  }
}

function runStructuredCommand(
  command: MxcOpenShellLiveCommand,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<MxcOpenShellLiveCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executablePath, [...command.arguments], {
      env: environment,
      signal,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeoutMs);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new MxcWindowsOpenShellExecutorError("OpenShell command could not start", "unknown"));
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : outputExceeded ? 1 : status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function acquirePins(request: MxcWindowsOpenShellPinRequest): Promise<MxcWindowsOpenShellPinLease> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    if (payload.length > MAX_PIN_PAYLOAD_BYTES) {
      reject(new MxcWindowsOpenShellExecutorError("stable-file request exceeds its bound"));
      return;
    }
    const powershell = path.win32.join(
      WINDOWS_SYSTEM_ROOT,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const encoded = Buffer.from(PIN_FILES_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "AllSigned",
        "-EncodedCommand",
        encoded,
      ],
      {
        env: safeCommandEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let settled = false;
    let active = false;
    let releaseRequested = false;
    let reportLoss: (() => void) | undefined;
    const loss = new Promise<void>((resolveLoss) => {
      reportLoss = resolveLoss;
    });
    let output = "";
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new MxcWindowsOpenShellExecutorError("stable-file pinning was rejected"));
    };
    const timer = setTimeout(fail, PIN_TIMEOUT_MS);
    child.once("error", fail);
    child.once("exit", () => {
      active = false;
      if (!settled) fail();
      else if (!releaseRequested) reportLoss?.();
    });
    child.stdin.once("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (output.length > 128) {
        fail();
        return;
      }
      if (!output.includes("\n")) return;
      if (output.trim() !== "NEMOCLAW_MXC_PIN_READY") {
        fail();
        return;
      }
      settled = true;
      active = true;
      clearTimeout(timer);
      resolve({
        isActive: () => active && child.exitCode === null,
        waitForLoss: () => loss,
        release: async () => {
          if (!active || child.exitCode !== null) {
            throw new MxcWindowsOpenShellExecutorError(
              "stable-file pinning ended before release",
              "unknown",
            );
          }
          releaseRequested = true;
          child.stdin.end("release\n");
          await new Promise<void>((releaseResolve, releaseReject) => {
            const releaseTimer = setTimeout(() => {
              child.kill();
              releaseReject(
                new MxcWindowsOpenShellExecutorError("stable-file release timed out", "unknown"),
              );
            }, PIN_RELEASE_TIMEOUT_MS);
            child.once("exit", (status) => {
              clearTimeout(releaseTimer);
              if (status === 0) releaseResolve();
              else {
                releaseReject(
                  new MxcWindowsOpenShellExecutorError("stable-file release failed", "unknown"),
                );
              }
            });
          });
        },
      });
    });
    child.stdin.write(`${payload.toString("base64")}\n`);
  });
}

const DEFAULT_RUNTIME: MxcWindowsOpenShellExecutorRuntime = {
  platform: process.platform,
  environment: process.env,
  observeFileDigest: createMxcWindowsOpenShellFileDigestObserver(),
  observeArtifactTree: artifactTree,
  acquirePins,
  runCommand: runStructuredCommand,
};

/** Create the dormant physical-Windows OpenShell executor for one provider-owned distribution. */
export function createMxcWindowsOpenShellExecutor(
  input: MxcWindowsOpenShellExecutorInput,
): MxcOpenShellLiveHostBoundary {
  const runtime = input.runtime ?? DEFAULT_RUNTIME;
  if (runtime.platform !== "win32") {
    throw new MxcWindowsOpenShellExecutorError("the trusted executor requires Windows");
  }
  const attachmentAuthority = resolveMxcOpenShellDistributionAuthority(input.distributionAuthority);
  const observationRequest = cloneAndDeepFreeze(input.observationRequest);

  const refreshAttachment = async (provided: MxcOpenShellAttachmentReceipt) => {
    const observed = await observeMxcOpenShellAttachment(
      observationRequest,
      runtime.observeFileDigest,
    );
    const fresh = qualifyMxcOpenShellAttachment(attachmentAuthority, observed);
    if (!isDeepStrictEqual(provided, fresh)) {
      throw new MxcWindowsOpenShellExecutorError("attachment identity drifted");
    }
    return fresh;
  };

  const runPinned = async (
    attachment: MxcOpenShellAttachmentReceipt,
    command: MxcOpenShellLiveCommand,
    allowedOperations: readonly string[],
    additionalFiles: readonly FileBinding[] = [],
    additionalDirectories: readonly string[] = [],
    expectedTree?: Readonly<{ root: string; sha256: string }>,
  ) => {
    requireCommand(command, attachment, allowedOperations);
    const files = [...attachmentFiles(attachment, observationRequest), ...additionalFiles];
    const directories = [
      ...parentDirectories(files.map((file) => file.path)),
      ...additionalDirectories,
    ];
    const pinRequest = cloneAndDeepFreeze({
      directories: [
        ...new Set(directories.map((entry) => canonicalWindowsPath(entry, "pin path"))),
      ],
      files: files.map((file) => ({
        path: canonicalWindowsPath(file.path, "pin file"),
        sha256: requireDigest(file.sha256, "pin digest"),
      })),
    });
    let lease: MxcWindowsOpenShellPinLease;
    try {
      lease = await runtime.acquirePins(pinRequest);
    } catch {
      throw new MxcWindowsOpenShellExecutorError("stable-file pinning was rejected");
    }
    let result: MxcOpenShellLiveCommandResult | undefined;
    let failure: MxcWindowsOpenShellExecutorError | undefined;
    try {
      const freshTree = expectedTree ? runtime.observeArtifactTree(expectedTree.root) : undefined;
      if (freshTree && freshTree.sha256 !== expectedTree?.sha256) {
        throw new MxcWindowsOpenShellExecutorError("artifact identity drifted while pinned");
      }
      if (!lease.isActive()) {
        throw new MxcWindowsOpenShellExecutorError(
          "stable-file pinning ended before mutation",
          "unknown",
        );
      }
      const controller = new AbortController();
      const commandOutcome = runtime
        .runCommand(command, safeCommandEnvironment(runtime.environment), controller.signal)
        .then(
          (commandResult) => ({ kind: "command" as const, commandResult }),
          () => ({ kind: "command-error" as const }),
        );
      const outcome = await Promise.race([
        commandOutcome,
        lease.waitForLoss().then(() => ({ kind: "pin-loss" as const })),
      ]);
      if (outcome.kind === "pin-loss") {
        controller.abort();
        await commandOutcome;
        failure = new MxcWindowsOpenShellExecutorError(
          "stable-file pinning ended during mutation",
          "unknown",
        );
      } else if (outcome.kind === "command-error") {
        failure = new MxcWindowsOpenShellExecutorError(
          "OpenShell command result is unknown",
          "unknown",
        );
      } else {
        result = outcome.commandResult;
      }
    } catch (error) {
      failure =
        error instanceof MxcWindowsOpenShellExecutorError
          ? error
          : new MxcWindowsOpenShellExecutorError("stable-file verification was rejected");
    }
    try {
      await lease.release();
    } catch {
      failure ??= new MxcWindowsOpenShellExecutorError(
        "stable-file release result is unknown",
        "unknown",
      );
    }
    if (failure) throw failure;
    if (!result) {
      throw new MxcWindowsOpenShellExecutorError("OpenShell command result is unknown", "unknown");
    }
    return result;
  };

  const boundary: MxcOpenShellLiveHostBoundary = {
    verifyAndRunCreate: async ({ attachment, policy, request, command }) => {
      requireIssuedMxcOpenShellCreateRequest(request);
      try {
        const fresh = await refreshAttachment(attachment);
        const tree = runtime.observeArtifactTree(request.workload.artifactRoot);
        if (
          tree.sha256 !== requireContentDigest(request.workload.artifactDigest, "artifact digest")
        ) {
          return { status: "artifact-verification-failed" } as const;
        }
        const executable = tree.files.find(
          (file) => file.path.toLowerCase() === request.workload.executablePath.toLowerCase(),
        );
        if (
          !executable ||
          executable.sha256 !==
            requireContentDigest(request.workload.executableDigest, "executable digest")
        ) {
          return { status: "artifact-verification-failed" } as const;
        }
        const policyBinding = {
          path: canonicalWindowsPath(policy.path, "policy path"),
          sha256: requireDigest(policy.sha256, "policy digest"),
        };
        const commandResult = await runPinned(
          fresh,
          command,
          ["create"],
          [...tree.files, policyBinding],
          tree.directories,
          { root: request.workload.artifactRoot, sha256: tree.sha256 },
        );
        if (commandResult.status !== 0) return { status: "unknown" } as const;
        return { status: "completed", command: commandResult } as const;
      } catch (error) {
        return error instanceof MxcWindowsOpenShellExecutorError &&
          error.mutationState === "unknown"
          ? ({ status: "unknown" } as const)
          : ({ status: "artifact-verification-failed" } as const);
      }
    },
    run: async ({ attachment, command }) => {
      const fresh = await refreshAttachment(attachment);
      return await runPinned(fresh, command, ["get", "list"]);
    },
    deleteExact: async ({ attachment, request }) => {
      requireIssuedMxcOpenShellCreateRequest(request);
      await refreshAttachment(attachment);
      // OpenShell v0.0.24 deletes by mutable sandbox name, not immutable sandbox ID. Refuse that
      // destructive fallback so recovery reports the authority-bound resource as retained.
      return { status: 1, stdout: "", stderr: "" };
    },
    recordFailure: (record: MxcOpenShellLiveFailureRecord) =>
      input.recordFailure?.(cloneAndDeepFreeze(record)),
  };
  return Object.freeze(boundary);
}
