// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { dockerSpawnSync } from "../../../adapters/docker/exec";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../../onboard/runtime-provider/current";
import {
  confirmHostLocalInferenceAuthority,
  prepareSandboxHostLocalInferenceAuthority,
} from "../../../onboard/runtime-provider/host-local-inference-lifecycle";
import { requireRuntimeProviderBundleForSandbox } from "../../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import {
  privilegedSandboxExecArgv,
  withPrivilegedSandboxExecutionLease,
} from "../../../sandbox/privileged-exec";
import { sanitizeReadinessText } from "../../../readiness/sanitize";
import { readManagedSnapshotProfileAuthority } from "./managed-profile";
import { captureSandboxRuntimeSnapshot } from "./provider-lifecycle";

type SnapshotBackupAuthority = Pick<
  sandboxState.BackupOptions,
  | "runtimeSnapshot"
  | "workload"
  | "hostLocalInferenceReceipt"
  | "hostLocalInferenceProvenance"
  | "validateBeforePublish"
>;

interface SnapshotBackupAuthorityDependencies {
  readonly getSandbox: (sandboxName: string) => SandboxEntry | null;
  readonly requireProvider: (sandbox: SandboxEntry) => RuntimeProviderBundle;
  readonly captureRuntime: typeof captureSandboxRuntimeSnapshot;
  readonly prepareHostLocalInference: typeof prepareSandboxHostLocalInferenceAuthority;
  readonly confirmHostLocalInference: typeof confirmHostLocalInferenceAuthority;
  readonly backup: typeof sandboxState.backupSandboxState;
  readonly captureOpenClawStateFile: typeof captureOpenClawStateFile;
  readonly captureHermesStateFile: typeof captureHermesStateFile;
  readonly captureHermesStateDirectories: typeof captureHermesStateDirectories;
}

const MAX_OPENCLAW_CONFIG_BYTES = 16 * 1024 * 1024;
const OPENCLAW_CONFIG_CAPTURE_MAX_BUFFER = MAX_OPENCLAW_CONFIG_BYTES + 1024 * 1024;
const OPENCLAW_CONFIG_CAPTURE_TIMEOUT_MS = 30_000;
const OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX = "nemoclaw-openclaw-config-capture:";
const OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES = 128;
const OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES = 1024;
const OPENCLAW_CONFIG_DIRECTORY = "/sandbox/.openclaw";
const OPENCLAW_CONFIG_NAME = "openclaw.json";
const HERMES_CONFIG_DIRECTORY = "/sandbox/.hermes";
const HERMES_CAPTURE_TIMEOUT_MS = 120_000;
const HERMES_CAPTURE_MAX_BUFFER = 256 * 1024 * 1024;
export const OPENCLAW_CONFIG_CAPTURE_SCRIPT = `import os, stat, sys
maximum = ${MAX_OPENCLAW_CONFIG_BYTES}
directory = sys.argv[1]
name = sys.argv[2]
protocol = "${OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX}"
def fail(status, reason):
    print(protocol + reason, file=sys.stderr)
    raise SystemExit(status)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
try:
    directory_fd = os.open(directory, directory_flags)
except OSError:
    fail(10, "directory-unavailable")
try:
    directory_before = os.fstat(directory_fd)
    try:
        file_fd = os.open(name, file_flags, dir_fd=directory_fd)
    except FileNotFoundError:
        fail(2, "missing")
    except OSError:
        fail(10, "file-unavailable")
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(11, "unsafe-file-metadata")
        if before.st_size > maximum:
            fail(12, "size-limit-exceeded")
        chunks = []
        total = 0
        while True:
            chunk = os.read(file_fd, min(64 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum:
                fail(12, "size-limit-exceeded")
        after = os.fstat(file_fd)
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
        if identity(before) != identity(after) or identity(before) != identity(current) or not stat.S_ISREG(current.st_mode):
            fail(13, "file-changed-during-read")
        directory_current = os.stat(directory, follow_symlinks=False)
        if (directory_before.st_dev, directory_before.st_ino) != (directory_current.st_dev, directory_current.st_ino) or not stat.S_ISDIR(directory_current.st_mode):
            fail(13, "directory-changed-during-read")
        sys.stdout.buffer.write(b"".join(chunks))
    finally:
        os.close(file_fd)
finally:
    os.close(directory_fd)
`;

type OpenClawConfigCaptureFailure =
  | "missing"
  | "directory-unavailable"
  | "file-unavailable"
  | "unsafe-file-metadata"
  | "size-limit-exceeded"
  | "file-changed-during-read"
  | "directory-changed-during-read";

function captureFailureProtocol(stderr: unknown): OpenClawConfigCaptureFailure | null {
  if (
    (Buffer.isBuffer(stderr) && stderr.length > OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES) ||
    (typeof stderr === "string" &&
      Buffer.byteLength(stderr) > OPENCLAW_CONFIG_CAPTURE_PROTOCOL_MAX_BYTES)
  ) {
    return null;
  }
  const value = Buffer.isBuffer(stderr)
    ? stderr.toString("utf8")
    : typeof stderr === "string"
      ? stderr
      : "";
  const line = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (!line.startsWith(OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX) || /[\r\n]/.test(line)) {
    return null;
  }
  const reason = line.slice(OPENCLAW_CONFIG_CAPTURE_PROTOCOL_PREFIX.length);
  switch (reason) {
    case "missing":
    case "directory-unavailable":
    case "file-unavailable":
    case "unsafe-file-metadata":
    case "size-limit-exceeded":
    case "file-changed-during-read":
    case "directory-changed-during-read":
      return reason;
    default:
      return null;
  }
}

function captureFailureDiagnostic(stderr: unknown): string | null {
  const value = Buffer.isBuffer(stderr)
    ? stderr.subarray(0, OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES).toString("utf8")
    : typeof stderr === "string"
      ? Buffer.from(stderr)
          .subarray(0, OPENCLAW_CONFIG_CAPTURE_DIAGNOSTIC_MAX_BYTES)
          .toString("utf8")
      : "";
  const sanitized = sanitizeReadinessText(value, 240).replace(/\s+/g, " ").trim();
  return sanitized || null;
}

export function captureOpenClawStateFile(
  sandboxName: string,
  request: sandboxState.StateFileCaptureRequest,
): sandboxState.StateFileCaptureResult | null {
  if (
    request.dir !== "/sandbox/.openclaw" ||
    request.spec.path !== "openclaw.json" ||
    request.spec.strategy !== "copy"
  ) {
    return null;
  }
  try {
    return withPrivilegedSandboxExecutionLease(
      sandboxName,
      "OpenClaw config snapshot capture",
      () => {
        const argv = privilegedSandboxExecArgv(
          sandboxName,
          [
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            OPENCLAW_CONFIG_CAPTURE_SCRIPT,
            OPENCLAW_CONFIG_DIRECTORY,
            OPENCLAW_CONFIG_NAME,
          ],
          false,
          true,
        );
        const result = dockerSpawnSync(argv, {
          encoding: null,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: OPENCLAW_CONFIG_CAPTURE_TIMEOUT_MS,
          maxBuffer: OPENCLAW_CONFIG_CAPTURE_MAX_BUFFER,
        });
        const protocolFailure = captureFailureProtocol(result.stderr);
        if (
          result.status === 2 &&
          result.signal === null &&
          !result.error &&
          protocolFailure === "missing"
        ) {
          return { outcome: "missing" };
        }
        if (
          result.status !== 0 ||
          result.signal !== null ||
          result.error ||
          !Buffer.isBuffer(result.stdout)
        ) {
          const primaryDetail =
            result.error?.message ??
            (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
          const stderrDetail = protocolFailure
            ? `reason ${protocolFailure}`
            : captureFailureDiagnostic(result.stderr);
          const detail = stderrDetail ? `${primaryDetail}; ${stderrDetail}` : primaryDetail;
          return { outcome: "failed", error: `privileged config capture failed: ${detail}` };
        }
        return { outcome: "backed_up", data: result.stdout };
      },
    );
  } catch (error) {
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const HERMES_STATE_CAPTURE_SCRIPT = `import os, sqlite3, stat, sys, tempfile
base, relative, strategy = sys.argv[1:]
parts = relative.split("/")
if not relative or relative.startswith("/") or any(part in ("", ".", "..") for part in parts):
    raise SystemExit(10)
if strategy not in ("copy", "sqlite_backup"):
    raise SystemExit(10)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
file_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
def identity(value):
    return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode), value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
def directory_identity(value):
    return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode))
directory_fds = []
file_fd = None
target_name = None
try:
    base_fd = os.open(base, directory_flags)
    directory_fds.append(base_fd)
    base_before = os.fstat(base_fd)
    for component in parts[:-1]:
        next_fd = os.open(component, directory_flags, dir_fd=directory_fds[-1])
        opened = os.fstat(next_fd)
        current = os.stat(component, dir_fd=directory_fds[-1], follow_symlinks=False)
        if not stat.S_ISDIR(opened.st_mode) or directory_identity(opened) != directory_identity(current):
            os.close(next_fd)
            raise SystemExit(11)
        directory_fds.append(next_fd)
    try:
        file_fd = os.open(parts[-1], file_flags, dir_fd=directory_fds[-1])
    except FileNotFoundError:
        raise SystemExit(2)
    before = os.fstat(file_fd)
    current_before = os.stat(parts[-1], dir_fd=directory_fds[-1], follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or identity(before) != identity(current_before):
        raise SystemExit(11)
    target = tempfile.NamedTemporaryFile(dir="/tmp", delete=False)
    target_name = target.name
    target.close()
    if strategy == "sqlite_backup":
        source = sqlite3.connect("file:/proc/self/fd/" + str(file_fd) + "?mode=ro", uri=True, timeout=30)
        destination = sqlite3.connect(target_name, timeout=30)
        try:
            source.backup(destination)
            if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise SystemExit(12)
        finally:
            destination.close()
            source.close()
    else:
        with open(target_name, "wb", buffering=0) as target_stream:
            while True:
                chunk = os.read(file_fd, 64 * 1024)
                if not chunk:
                    break
                target_stream.write(chunk)
    after = os.fstat(file_fd)
    current_after = os.stat(parts[-1], dir_fd=directory_fds[-1], follow_symlinks=False)
    if identity(before) != identity(after) or identity(before) != identity(current_after):
        raise SystemExit(13)
    for index, component in enumerate(parts[:-1]):
        opened = os.fstat(directory_fds[index + 1])
        current = os.stat(component, dir_fd=directory_fds[index], follow_symlinks=False)
        if directory_identity(opened) != directory_identity(current) or not stat.S_ISDIR(current.st_mode):
            raise SystemExit(13)
    base_current = os.stat(base, follow_symlinks=False)
    if directory_identity(base_before) != directory_identity(base_current) or not stat.S_ISDIR(base_current.st_mode):
        raise SystemExit(13)
    with open(target_name, "rb", buffering=0) as stream:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
finally:
    if target_name is not None:
        try:
            os.unlink(target_name)
        except FileNotFoundError:
            pass
    if file_fd is not None:
        os.close(file_fd)
    for descriptor in reversed(directory_fds):
        os.close(descriptor)
`;

export const HERMES_DIRECTORY_CAPTURE_SCRIPT = `import os, stat, sys, tarfile
automatic_flags = getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | automatic_flags
file_flags = os.O_RDONLY | automatic_flags | getattr(os, "O_NONBLOCK", 0)
base, *names = sys.argv[1:]
def identity(value):
    return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode), value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)
def directory_identity(value):
    return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode))
def tar_info(name, value):
    info = tarfile.TarInfo(name)
    info.mode = stat.S_IMODE(value.st_mode)
    info.uid = value.st_uid
    info.gid = value.st_gid
    info.mtime = int(value.st_mtime)
    return info
def add_entry(archive, parent_fd, name, archive_name):
    if not name or "/" in name or "\\n" in name or "\\r" in name or name in (".", ".."):
        raise SystemExit(10)
    value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISDIR(value.st_mode):
        descriptor = os.open(name, directory_flags, dir_fd=parent_fd)
        try:
            opened = os.fstat(descriptor)
            if directory_identity(value) != directory_identity(opened):
                raise SystemExit(13)
            info = tar_info(archive_name + "/", opened)
            info.type = tarfile.DIRTYPE
            info.size = 0
            archive.addfile(info)
            for child in sorted(os.listdir(descriptor)):
                add_entry(archive, descriptor, child, archive_name + "/" + child)
            after = os.fstat(descriptor)
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if directory_identity(opened) != directory_identity(after) or directory_identity(opened) != directory_identity(current):
                raise SystemExit(13)
        finally:
            os.close(descriptor)
        return
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise SystemExit(11)
    descriptor = os.open(name, file_flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(descriptor)
        current_before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if identity(value) != identity(opened) or identity(opened) != identity(current_before):
            raise SystemExit(13)
        info = tar_info(archive_name, opened)
        info.type = tarfile.REGTYPE
        info.size = opened.st_size
        with os.fdopen(os.dup(descriptor), "rb", closefd=True) as stream:
            archive.addfile(info, stream)
        after = os.fstat(descriptor)
        current_after = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if identity(opened) != identity(after) or identity(opened) != identity(current_after):
            raise SystemExit(13)
    finally:
        os.close(descriptor)
for name in names:
    if not name or "/" in name or name in (".", ".."):
        raise SystemExit(10)
base_fd = os.open(base, directory_flags)
try:
    base_before = os.fstat(base_fd)
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for name in names:
            add_entry(archive, base_fd, name, name)
    base_current = os.stat(base, follow_symlinks=False)
    if directory_identity(base_before) != directory_identity(base_current) or not stat.S_ISDIR(base_current.st_mode):
        raise SystemExit(13)
finally:
    os.close(base_fd)
`;

export function captureHermesStateFile(
  sandboxName: string,
  request: sandboxState.StateFileCaptureRequest,
): sandboxState.StateFileCaptureResult | null {
  if (
    request.sandboxName !== sandboxName ||
    !sandboxState.isDeclaredAgentStateFile("hermes", request.dir, request.spec)
  )
    return null;
  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, "Hermes state snapshot capture", () => {
      const result = dockerSpawnSync(
        privilegedSandboxExecArgv(
          sandboxName,
          [
            "/usr/bin/python3",
            "-I",
            "-S",
            "-c",
            HERMES_STATE_CAPTURE_SCRIPT,
            HERMES_CONFIG_DIRECTORY,
            request.spec.path,
            request.spec.strategy,
          ],
          false,
          true,
        ),
        {
          encoding: null,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: HERMES_CAPTURE_TIMEOUT_MS,
          maxBuffer: HERMES_CAPTURE_MAX_BUFFER,
        },
      );
      if (result.status === 2 && !result.error && result.signal === null)
        return { outcome: "missing" };
      if (result.status !== 0 || result.error || result.signal || !Buffer.isBuffer(result.stdout)) {
        return {
          outcome: "failed",
          error: `privileged Hermes state capture failed: ${result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`)}`,
        };
      }
      return { outcome: "backed_up", data: result.stdout };
    });
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function captureHermesStateDirectories(
  sandboxName: string,
  request: sandboxState.StateDirectoryCaptureRequest,
  archiveFd: number,
): sandboxState.StateDirectoryCaptureResult | null {
  if (
    request.sandboxName !== sandboxName ||
    !sandboxState.areDeclaredAgentStateDirectories("hermes", request.dir, request.dirs)
  ) {
    return null;
  }
  try {
    return withPrivilegedSandboxExecutionLease(
      sandboxName,
      "Hermes state directory snapshot capture",
      () => {
        const result = dockerSpawnSync(
          privilegedSandboxExecArgv(
            sandboxName,
            [
              "/usr/bin/python3",
              "-I",
              "-S",
              "-c",
              HERMES_DIRECTORY_CAPTURE_SCRIPT,
              HERMES_CONFIG_DIRECTORY,
              ...request.dirs,
            ],
            false,
            true,
          ),
          {
            encoding: null,
            stdio: ["ignore", archiveFd, "pipe"],
            timeout: HERMES_CAPTURE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
        );
        if (result.status !== 0 || result.error || result.signal) {
          return {
            outcome: "failed",
            error: `privileged Hermes directory capture failed: ${result.error?.message ?? (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`)}`,
          };
        }
        return { outcome: "backed_up" };
      },
    );
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const defaultDependencies: Omit<SnapshotBackupAuthorityDependencies, "getSandbox"> = {
  requireProvider: (sandbox) =>
    requireRuntimeProviderBundleForSandbox(sandbox, CURRENT_RUNTIME_PROVIDER_BUNDLES),
  captureRuntime: captureSandboxRuntimeSnapshot,
  prepareHostLocalInference: prepareSandboxHostLocalInferenceAuthority,
  confirmHostLocalInference: confirmHostLocalInferenceAuthority,
  // Keep the call late-bound so tests and alternative state stores can replace
  // the module export without this adapter retaining an import-time reference.
  backup: (...args) => sandboxState.backupSandboxState(...args),
  captureOpenClawStateFile,
  captureHermesStateFile,
  captureHermesStateDirectories,
};

function failure(error: unknown): sandboxState.BackupResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
    error: `Cannot capture provider snapshot authority: ${detail}.`,
  };
}

function backupStateOnly(
  dependencies: SnapshotBackupAuthorityDependencies,
  sandboxName: string,
  options: Pick<
    sandboxState.BackupOptions,
    "name" | "captureStateFile" | "captureStateDirectories"
  >,
): sandboxState.BackupResult {
  return options.name === undefined &&
    options.captureStateFile === undefined &&
    options.captureStateDirectories === undefined
    ? dependencies.backup(sandboxName)
    : dependencies.backup(sandboxName, options);
}

function readAuthority(entry: SandboxEntry) {
  return readManagedSnapshotProfileAuthority({
    sandboxName: entry.name,
    agentType: entry.agent ?? "",
    imageTag: entry.imageTag,
    fromDockerfile: entry.fromDockerfile,
    workload: entry.workload,
  });
}

function captureManagedAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
): SnapshotBackupAuthority | null {
  const authority = readAuthority(entry);
  if (!authority) return null;
  const provider = dependencies.requireProvider(entry);
  if (!provider.workload.acceptsReceipt(authority.receipt)) {
    throw new Error(
      `runtime provider '${provider.identity.id}' does not accept the managed workload receipt`,
    );
  }
  const runtimeSnapshot = dependencies.captureRuntime(provider, entry);
  const workload = authority.receipt;

  return {
    runtimeSnapshot,
    workload,
    validateBeforePublish: () => {
      const current = dependencies.getSandbox(entry.name);
      if (!current) {
        throw new Error(`sandbox '${entry.name}' is no longer registered`);
      }
      const currentAuthority = readAuthority(current);
      if (!currentAuthority || !isDeepStrictEqual(currentAuthority.receipt, workload)) {
        throw new Error(`sandbox '${entry.name}' managed workload changed during backup`);
      }
      const currentProvider = dependencies.requireProvider(current);
      if (
        currentProvider.identity.id !== provider.identity.id ||
        !currentProvider.workload.acceptsReceipt(currentAuthority.receipt)
      ) {
        throw new Error(`sandbox '${entry.name}' runtime provider changed during backup`);
      }
      const currentRuntime = dependencies.captureRuntime(currentProvider, current);
      if (!isDeepStrictEqual(currentRuntime, runtimeSnapshot)) {
        throw new Error(`sandbox '${entry.name}' runtime changed during backup`);
      }
    },
  };
}

function captureHostLocalInferenceAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
): Pick<
  sandboxState.BackupOptions,
  "hostLocalInferenceReceipt" | "hostLocalInferenceProvenance" | "validateBeforePublish"
> | null {
  const receipt = entry.hostLocalInferenceReceipt;
  if (typeof receipt !== "string") return null;
  const provider = dependencies.requireProvider(entry);
  const prepared = dependencies.prepareHostLocalInference(provider, entry);
  if (!prepared) {
    if (entry.hostLocalInferenceProvenance) {
      throw new Error("explicit host-local inference lifecycle authority cannot be reconstructed");
    }
    return null;
  }
  return {
    hostLocalInferenceReceipt: prepared.serializedReceipt,
    ...(entry.hostLocalInferenceProvenance
      ? { hostLocalInferenceProvenance: entry.hostLocalInferenceProvenance }
      : {}),
    validateBeforePublish: () => {
      const current = dependencies.getSandbox(entry.name);
      if (!current) throw new Error(`sandbox '${entry.name}' is no longer registered`);
      if (current.hostLocalInferenceReceipt !== receipt) {
        throw new Error(`sandbox '${entry.name}' host-local inference changed during backup`);
      }
      if (
        !isDeepStrictEqual(current.hostLocalInferenceProvenance, entry.hostLocalInferenceProvenance)
      ) {
        throw new Error(
          `sandbox '${entry.name}' host-local inference provenance changed during backup`,
        );
      }
      const currentProvider = dependencies.requireProvider(current);
      if (currentProvider.identity.id !== provider.identity.id) {
        throw new Error(`sandbox '${entry.name}' runtime provider changed during backup`);
      }
      dependencies.confirmHostLocalInference(currentProvider, current, prepared);
    },
  };
}

function captureSnapshotAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
): SnapshotBackupAuthority | null {
  const managed = captureManagedAuthority(entry, dependencies);
  const hostLocal = captureHostLocalInferenceAuthority(entry, dependencies);
  if (!managed && !hostLocal) return null;
  return {
    ...(managed?.runtimeSnapshot === undefined ? {} : { runtimeSnapshot: managed.runtimeSnapshot }),
    ...(managed?.workload === undefined ? {} : { workload: managed.workload }),
    ...(hostLocal?.hostLocalInferenceReceipt === undefined
      ? {}
      : { hostLocalInferenceReceipt: hostLocal.hostLocalInferenceReceipt }),
    ...(hostLocal?.hostLocalInferenceProvenance === undefined
      ? {}
      : { hostLocalInferenceProvenance: hostLocal.hostLocalInferenceProvenance }),
    validateBeforePublish: () => {
      managed?.validateBeforePublish?.();
      hostLocal?.validateBeforePublish?.();
    },
  };
}

/**
 * Capture the provider-owned workload, runtime, and host-local inference
 * authority around the complete filesystem copy. The state layer publishes
 * the manifest only after the final callback confirms the same full sandbox
 * binding and provider proof remain live.
 */
export function backupSandboxStateWithManagedAuthority(
  sandboxName: string,
  options: Pick<sandboxState.BackupOptions, "name"> = {},
  overrides: Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
    Partial<Omit<SnapshotBackupAuthorityDependencies, "getSandbox">>,
): sandboxState.BackupResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) return backupStateOnly(dependencies, sandboxName, options);

  const stateCaptureOptions: Pick<
    sandboxState.BackupOptions,
    "captureStateFile" | "captureStateDirectories"
  > =
    !entry.agent || entry.agent === "openclaw"
      ? {
          captureStateFile: (request) =>
            dependencies.captureOpenClawStateFile(sandboxName, request),
        }
      : entry.agent === "hermes"
        ? {
            captureStateFile: (request) =>
              dependencies.captureHermesStateFile(sandboxName, request),
            captureStateDirectories: (request, archiveFd) =>
              dependencies.captureHermesStateDirectories(sandboxName, request, archiveFd),
          }
        : {};
  const backupOptions = { ...options, ...stateCaptureOptions };

  let authority: SnapshotBackupAuthority | null;
  try {
    authority = captureSnapshotAuthority(entry, dependencies);
  } catch (error) {
    return failure(error);
  }
  return authority
    ? dependencies.backup(sandboxName, { ...backupOptions, ...authority })
    : backupStateOnly(dependencies, sandboxName, backupOptions);
}
