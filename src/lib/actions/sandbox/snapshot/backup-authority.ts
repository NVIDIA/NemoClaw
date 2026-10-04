// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { readManagedSnapshotProfileAuthority } from "./managed-profile";
import {
  captureSandboxRuntimeSnapshot,
  prepareSandboxStoppedStateCapture,
} from "./provider-lifecycle";
import type { PreparedStoppedNativeState } from "../../../state/state-directory-restore";

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
}

type SnapshotBackupControlOptions = Pick<
  sandboxState.BackupOptions,
  "deadlineMs" | "deferSanitizationDeadlineCleanup" | "deferCompletionPublication"
>;

type SnapshotBackupOverrides = Pick<SnapshotBackupAuthorityDependencies, "getSandbox"> &
  Partial<Omit<SnapshotBackupAuthorityDependencies, "getSandbox">>;

export function discardIncompleteBackup(
  sandboxName: string,
  result: sandboxState.BackupResult,
  cleanupDeadlineMs: number,
  operation: string,
): sandboxState.BackupResult {
  const publishedManifest = result.manifest;
  const backupPath = publishedManifest?.backupPath;
  if (!publishedManifest || !backupPath) return result;
  if (sandboxState.removeSandboxStateBackup(sandboxName, backupPath, cleanupDeadlineMs)) {
    const { manifest: _removedManifest, ...withoutPartialBackup } = result;
    return { ...withoutPartialBackup, backedUpDirs: [], backedUpFiles: [] };
  }
  const cleanupError = `Failed ${operation} backup at '${backupPath}' could not be removed`;
  let manifest = publishedManifest;
  let invalidationError: string | null = null;
  try {
    manifest = sandboxState.markRebuildBackupIncomplete(manifest);
  } catch (error) {
    invalidationError = error instanceof Error ? error.message : String(error);
  }
  const retainedError = invalidationError
    ? `${cleanupError}; the retained manifest could not be marked incomplete: ${invalidationError}`
    : cleanupError;
  return {
    ...result,
    manifest,
    error: result.error ? `${result.error}. ${retainedError}` : retainedError,
  };
}

function requireAuthorityBudget(deadlineMs: number | undefined): void {
  if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
    throw new Error("provider snapshot authority deadline expired");
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

function backupState(
  dependencies: SnapshotBackupAuthorityDependencies,
  sandboxName: string,
  options: sandboxState.BackupOptions,
): sandboxState.BackupResult {
  return Object.keys(options).length === 0
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
  deadlineMs?: number,
): SnapshotBackupAuthority | null {
  requireAuthorityBudget(deadlineMs);
  const authority = readAuthority(entry);
  if (!authority) return null;
  const provider = dependencies.requireProvider(entry);
  if (!provider.workload.acceptsReceipt(authority.receipt)) {
    throw new Error(
      `runtime provider '${provider.identity.id}' does not accept the managed workload receipt`,
    );
  }
  const runtimeSnapshot = dependencies.captureRuntime(provider, entry, deadlineMs);
  requireAuthorityBudget(deadlineMs);
  const workload = authority.receipt;

  return {
    runtimeSnapshot,
    workload,
    validateBeforePublish: () => {
      requireAuthorityBudget(deadlineMs);
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
      const currentRuntime = dependencies.captureRuntime(currentProvider, current, deadlineMs);
      requireAuthorityBudget(deadlineMs);
      if (!isDeepStrictEqual(currentRuntime, runtimeSnapshot)) {
        throw new Error(`sandbox '${entry.name}' runtime changed during backup`);
      }
    },
  };
}

function captureHostLocalInferenceAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
  deadlineMs?: number,
): Pick<
  sandboxState.BackupOptions,
  "hostLocalInferenceReceipt" | "hostLocalInferenceProvenance" | "validateBeforePublish"
> | null {
  const receipt = entry.hostLocalInferenceReceipt;
  if (typeof receipt !== "string") return null;
  requireAuthorityBudget(deadlineMs);
  const provider = dependencies.requireProvider(entry);
  const prepared =
    deadlineMs === undefined
      ? dependencies.prepareHostLocalInference(provider, entry)
      : dependencies.prepareHostLocalInference(provider, entry, { deadlineMs });
  requireAuthorityBudget(deadlineMs);
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
      requireAuthorityBudget(deadlineMs);
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
      if (deadlineMs === undefined) {
        dependencies.confirmHostLocalInference(currentProvider, current, prepared);
      } else {
        dependencies.confirmHostLocalInference(currentProvider, current, prepared, { deadlineMs });
      }
      requireAuthorityBudget(deadlineMs);
    },
  };
}

function captureSnapshotAuthority(
  entry: SandboxEntry,
  dependencies: SnapshotBackupAuthorityDependencies,
  deadlineMs?: number,
): SnapshotBackupAuthority | null {
  const managed = captureManagedAuthority(entry, dependencies, deadlineMs);
  const hostLocal = captureHostLocalInferenceAuthority(entry, dependencies, deadlineMs);
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
  optionsOrOverrides: SnapshotBackupControlOptions | SnapshotBackupOverrides,
  overridesOrStopped?: SnapshotBackupOverrides | PreparedStoppedNativeState,
  stoppedNativeStateOverride?: PreparedStoppedNativeState,
): sandboxState.BackupResult {
  const legacyCall = "getSandbox" in optionsOrOverrides;
  const options: SnapshotBackupControlOptions = legacyCall ? {} : optionsOrOverrides;
  const overrides = (
    legacyCall ? optionsOrOverrides : overridesOrStopped
  ) as SnapshotBackupOverrides;
  const stoppedNativeState = legacyCall
    ? (overridesOrStopped as PreparedStoppedNativeState | undefined)
    : stoppedNativeStateOverride;
  const dependencies = { ...defaultDependencies, ...overrides };
  const entry = dependencies.getSandbox(sandboxName);
  if (!entry) return backupState(dependencies, sandboxName, options);

  let authority: SnapshotBackupAuthority | null;
  try {
    authority = captureSnapshotAuthority(entry, dependencies, options.deadlineMs);
  } catch (error) {
    return failure(error);
  }
  if (!stoppedNativeState) {
    return authority
      ? backupState(dependencies, sandboxName, { ...options, ...authority })
      : backupState(dependencies, sandboxName, options);
  }
  return dependencies.backup(sandboxName, {
    ...options,
    ...(authority ?? {}),
    nativeStateSource: {
      root: "/sandbox",
      directory: stoppedNativeState.nativeDirectory,
      assertCurrent: stoppedNativeState.assertCurrent,
    },
    validateBeforePublish: () => authority?.validateBeforePublish?.(),
  });
}

function rejectStoppedState(message: string): never {
  throw new Error(message);
}

function makePrivateTreeRemovable(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(root, stat.mode | 0o300);
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name);
    const childStat = fs.lstatSync(child);
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
      makePrivateTreeRemovable(child);
    }
  }
}

/** Prepare a private complete native-state copy before inspecting a stopped source. */
export async function prepareStoppedAgentState(
  sandboxName: string,
  getSandbox: SnapshotBackupAuthorityDependencies["getSandbox"],
): Promise<PreparedStoppedNativeState | null> {
  const dependencies = { ...defaultDependencies, getSandbox };
  const entry = getSandbox(sandboxName);
  const agentName = entry?.agent ?? "openclaw";
  if (!entry || (agentName !== "openclaw" && agentName !== "langchain-deepagents-code"))
    return null;
  const authority = captureSnapshotAuthority(entry, dependencies);
  const runtime = authority?.runtimeSnapshot;
  if (!runtime || runtime.lifecycleState !== "stopped" || !authority.workload) return null;
  const capture = prepareSandboxStoppedStateCapture(
    dependencies.requireProvider(entry),
    entry,
    runtime,
    {
      nativeRoot: "/sandbox",
      managedStateRoots:
        authority.workload.kind === "managed-image"
          ? managedStartupStateRootOwnership({ agent: agentName, sandboxName })
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
      rejectStoppedState("Stopped source registration changed during recovery.");
    }
    authority.validateBeforePublish?.();
    capture.assertCurrent();
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-state-"));
  fs.chmodSync(temporary, 0o700);
  const archivePath = path.join(temporary, "source.tar");
  const raw = path.join(temporary, "raw");
  const cleanupOnExit = (): void => {
    try {
      makePrivateTreeRemovable(raw);
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      /* private files remain owner-only */
    }
  };
  const dispose = (): void => {
    makePrivateTreeRemovable(raw);
    fs.rmSync(temporary, { recursive: true, force: true });
    process.removeListener("exit", cleanupOnExit);
  };
  process.once("exit", cleanupOnExit);
  try {
    const descriptor = fs.openSync(archivePath, "wx", 0o600);
    try {
      // The provider archive and its extracted private tree coexist until the
      // archive is validated and removed. Reserve capacity for both copies.
      const maxBytes = sandboxState.nativeStateCaptureMaxBytes(temporary, undefined, 2);
      if (maxBytes === 0) {
        rejectStoppedState("Stopped state capture has no backup-disk space available.");
      }
      await capture.capture(descriptor, maxBytes);
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
        if (!["-", "d", "l", "h"].includes(line[0] ?? "")) unsupported = true;
      },
    );
    if (listingFailure || unsupported)
      rejectStoppedState("Stopped state contains an unsupported archive entry.");
    fs.mkdirSync(raw, { mode: 0o700 });
    const validation = sandboxState.validateTarEntries(archive, raw);
    if (!validation.safe) rejectStoppedState("Stopped state archive failed snapshot validation.");
    if (sandboxState.rejectSymlinkExtractionTraversal(archive, validation.entries).length > 0) {
      rejectStoppedState("Stopped state archive contains an unsafe symlink extraction layout.");
    }
    if (sandboxState.rejectHardLinkExtractionTraversal(archive, validation.entries).length > 0) {
      rejectStoppedState("Stopped state archive contains an unsafe hard-link extraction layout.");
    }
    // This provider-owned stream has already containment-checked hard-link
    // targets and limited headers to files, directories, and links. Extract
    // into a new private directory without resolving symlink targets: absolute
    // and system-targeting links are legitimate native-home content, and tar
    // must preserve them rather than write through them.
    const extracted = spawnSync("tar", ["-xf", archivePath, "--no-same-owner", "-C", raw], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: sandboxState.NATIVE_STATE_CAPTURE_TIMEOUT_MS,
    });
    if (extracted.status !== 0 || extracted.error || extracted.signal) {
      rejectStoppedState("Stopped state archive failed snapshot extraction.");
    }
    const sourceRoot = fs.lstatSync(raw);
    if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink())
      rejectStoppedState("Stopped agent native root is not a directory.");
    fs.chmodSync(raw, 0o700);
    const agentDirectory = agentName === "openclaw" ? ".openclaw" : ".deepagents";
    let directory = path.join(raw, agentDirectory);
    try {
      const configRoot = fs.lstatSync(directory);
      if (!configRoot.isDirectory() || configRoot.isSymbolicLink()) {
        rejectStoppedState("Stopped agent config root is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        rejectStoppedState(error instanceof Error ? error.message : String(error));
      }
      directory = path.join(temporary, "empty-agent-config");
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    fs.unlinkSync(archivePath);
    assertCurrent();
    return {
      sandboxName,
      agentName,
      nativeDirectory: raw,
      directory,
      cleanupDirectory: temporary,
      assertCurrent,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
