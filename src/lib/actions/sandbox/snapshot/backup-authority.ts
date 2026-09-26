// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  let authority: SnapshotBackupAuthority | null;
  try {
    authority = captureSnapshotAuthority(entry, dependencies);
  } catch (error) {
    return failure(error);
  }
  return authority ? dependencies.backup(sandboxName, authority) : dependencies.backup(sandboxName);
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
