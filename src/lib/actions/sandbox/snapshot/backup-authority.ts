// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../../../adapters/docker/exec";
import type { AgentDefinition } from "../../../agent/definition-types";
import {
  copyCapturedOpenClawState,
  type CapturedOpenClawState,
} from "../../../state/state-directory-restore";
import { runTarListing } from "../../../state/tar-listing";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import { managedStartupStateRootOwnership } from "../../../onboard/managed-startup/state-roots";
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
import { readManagedSnapshotProfileAuthority } from "./managed-profile";
import {
  captureSandboxRuntimeSnapshot,
  prepareSandboxStoppedStateCapture,
} from "./provider-lifecycle";

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
  readonly captureHermesStateFile: typeof captureHermesStateFile;
}

const HERMES_CAPTURE_TIMEOUT_MS = 120_000;
const HERMES_CAPTURE_MAX_BUFFER = 256 * 1024 * 1024;
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
            request.dir,
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
    return {
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
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
  captureHermesStateFile,
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
      : {
          hostLocalInferenceProvenance: hostLocal.hostLocalInferenceProvenance,
        }),
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
  overrides: Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
    Partial<Omit<SnapshotBackupAuthorityDependencies, "getSandbox">>,
): sandboxState.BackupResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) return dependencies.backup(sandboxName);

  // The complete native-home archive owns agent state. Hermes keeps one narrow
  // privileged fallback only for reading allowlisted recreation environment
  // metadata when the ordinary SSH user cannot read `.env`.
  const stateCaptureOptions: Pick<sandboxState.BackupOptions, "captureStateFile"> =
    entry.agent === "hermes"
      ? {
          captureStateFile: (request) => dependencies.captureHermesStateFile(sandboxName, request),
        }
      : {};
  const backupOptions = stateCaptureOptions;

  let authority: SnapshotBackupAuthority | null;
  try {
    authority = captureSnapshotAuthority(entry, dependencies);
  } catch (error) {
    return failure(error);
  }
  return authority
    ? dependencies.backup(sandboxName, { ...backupOptions, ...authority })
    : Object.keys(backupOptions).length === 0
      ? dependencies.backup(sandboxName)
      : dependencies.backup(sandboxName, backupOptions);
}

export interface PreparedStoppedOpenClawState extends CapturedOpenClawState {
  readonly cleanupDirectory: string;
  dispose(): void;
}

/** Prepare a private, declared-state copy before inspecting MCP or deleting an Error source. */
export async function prepareStoppedOpenClawState(
  sandboxName: string,
  getSandbox: SnapshotBackupAuthorityDependencies["getSandbox"],
  agent: AgentDefinition,
): Promise<PreparedStoppedOpenClawState | null> {
  const dependencies = { ...defaultDependencies, getSandbox };
  const entry = getSandbox(sandboxName);
  if (!entry || (entry.agent ?? "openclaw") !== "openclaw") return null;
  const authority = captureSnapshotAuthority(entry, dependencies);
  const runtime = authority?.runtimeSnapshot;
  if (!runtime || runtime.lifecycleState !== "stopped" || !authority.workload) return null;
  const capture = prepareSandboxStoppedStateCapture(
    dependencies.requireProvider(entry),
    entry,
    runtime,
    {
      directories: agent.backupStateDirs,
      prefixes: agent.backupStateDirPrefixes,
      files: agent.stateFiles.map((file) => (typeof file === "string" ? file : file.path)),
      managedStateRoots:
        authority.workload.kind === "managed-image"
          ? managedStartupStateRootOwnership({ agent: "openclaw", sandboxName })
          : [],
    },
  );
  if (!capture) return null;
  const assertCurrent = (): void => {
    const current = getSandbox(sandboxName);
    if (
      !current ||
      current.gatewayName !== entry.gatewayName ||
      current.lifecycleLiveIdentityFingerprint !== entry.lifecycleLiveIdentityFingerprint
    ) {
      throw new Error("Stopped source registration changed during recovery.");
    }
    authority.validateBeforePublish?.();
    capture.assertCurrent();
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-state-"));
  fs.chmodSync(temporary, 0o700);
  const archivePath = path.join(temporary, "source.tar");
  const raw = path.join(temporary, "raw");
  const directory = path.join(temporary, "state");
  const cleanupOnExit = (): void => {
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      /* private files remain owner-only */
    }
  };
  const dispose = (): void => {
    fs.rmSync(temporary, { recursive: true, force: true });
    process.removeListener("exit", cleanupOnExit);
  };
  process.once("exit", cleanupOnExit);
  try {
    const descriptor = fs.openSync(archivePath, "wx", 0o600);
    try {
      await capture.capture(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const archive = { filePath: archivePath };
    let unsupported = false;
    const listingFailure = runTarListing(
      archive,
      ["-tvf", "-"],
      "stopped state inventory",
      (line) => {
        if (!["-", "d", "l"].includes(line[0] ?? "")) unsupported = true;
      },
    );
    if (listingFailure || unsupported)
      throw new Error("Stopped state contains an unsupported archive entry.");
    fs.mkdirSync(raw, { mode: 0o700 });
    const extracted = sandboxState.safeTarExtract(archive, raw);
    if (!extracted.success) throw new Error("Stopped state archive failed snapshot validation.");
    const sourceDirectory = raw;
    const sourceRoot = fs.lstatSync(sourceDirectory);
    if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink())
      throw new Error("Stopped OpenClaw state root is not a directory.");
    fs.chmodSync(sourceDirectory, 0o700);
    fs.mkdirSync(directory, { mode: 0o700 });
    copyCapturedOpenClawState(
      { sandboxName, directory: sourceDirectory, assertCurrent },
      directory,
      agent.backupStateDirs,
      agent.backupStateDirPrefixes,
      agent.stateFiles.map((file) =>
        typeof file === "string"
          ? { path: file, strategy: "copy" }
          : { path: file.path, strategy: file.strategy ?? "copy" },
      ),
    );
    fs.rmSync(raw, { recursive: true, force: true });
    fs.unlinkSync(archivePath);
    assertCurrent();
    return { sandboxName, directory, cleanupDirectory: temporary, assertCurrent, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
