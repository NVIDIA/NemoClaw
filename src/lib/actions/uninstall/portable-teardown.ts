// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Full destructive uninstall of the portable profile used to run the generic
// `openshell sandbox delete --all` teardown and then delete NemoClaw state,
// returning exit 0 while receipt-owned rootless-Podman containers kept running
// and NemoClaw-installed selector values stayed in the current user's systemd
// manager environment. The stale CONTAINERS_CONF then pointed at a deleted
// file, socket activation failed to start podman.service, and a clean reinstall
// began from a broken runtime (gh #9189).
//
// This module tears down exactly the runtime NemoClaw created, under the
// authority/retry contract required by #9189 and the review of this PR:
//
//   1. Every mutation is bound to the RECORDED current-user rootless Podman
//      socket authority from the lifecycle receipt (schema >= 4). A receipt
//      that predates recorded authority, or a socket that is missing,
//      replaced, or owned by another principal, fails closed and preserves
//      every receipt, selector, and container for a safe retry.
//   2. Podman is invoked with the transport pinned to that socket
//      (CONTAINER_HOST=unix://<recorded socket>) and with the ambient
//      CONTAINER_CONNECTION / CONTAINER_SSHKEY selectors removed, so ambient
//      configuration cannot redirect deletion elsewhere.
//   3. A container is inspected BEFORE deletion: the resolved full container
//      ID, `openshell.managed=true`, and the sandbox identity labels must
//      match the receipt. Deletion uses the verified full ID, never a
//      name-only or short-id guess.
//   4. Receipt files are retired ONLY after every exact container deletion is
//      verified. A failed, ambiguous, or unauthorized cleanup preserves the
//      receipts (the container IDs needed for retry), the configuration, and
//      the gateway state, and surfaces `ok: false`.
//   5. User-manager selectors are cleared only after container removal
//      succeeds, and only when the current value matches the NemoClaw
//      projection (CONTAINERS_CONF = portable containers.conf, NETAVARK_FW =
//      iptables, CONTAINER_HOST = unix://<recorded socket>). CONTAINER_CONNECTION
//      and CONTAINER_SSHKEY have no recorded NemoClaw projection (NemoClaw
//      strips them from child environments rather than setting them), so any
//      user value is preserved.
//
// The protected rootless-Podman proof (exact full command on clean CI runners,
// exit 0 only after sandbox + registry are absent, socket restart, reinstall
// with no stale selector) requires NVIDIA CI runners and is tracked in the
// workflow; it cannot run in a local unit environment.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capturePodmanSocketAuthority,
  type PodmanSocketAuthority,
  type PodmanSocketAuthorityDeps,
} from "../../adapters/podman/socket-authority";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../onboard/runtime-provider/podman-lifecycle";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../../state/onboard/portable-runtime-authority";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PortableTeardownInput {
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly run?: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult;
  readonly readDirSync?: (dir: string) => string[];
  readonly readFileSync?: (file: string, encoding: "utf8") => string;
  readonly rmSync?: (target: string) => void;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  /** Current Unix user ID for socket-authority ownership checks. */
  readonly uid?: number;
  /** Socket-authority capture deps (lstat/uid) for tests. */
  readonly socketAuthorityDeps?: PodmanSocketAuthorityDeps;
}

export interface PortableTeardownResult {
  readonly ok: boolean;
  readonly removedContainerIds: readonly string[];
  readonly unsetSelectors: readonly string[];
  readonly removedReceiptFiles: readonly string[];
  readonly reason?: string;
}

const RECEIPT_DIRECTORY = "portable-demo-lifecycle";
const CURRENT_RECEIPT_SCHEMA_VERSION = 4;
const PORTABLE_REGISTRY_LABEL = "com.nvidia.nemoclaw.portable=1";
const PORTABLE_CONTAINERS_CONF_SUFFIX = path.join(
  "nemoclaw",
  "portable",
  "containers.conf",
);
// The container IDs NemoClaw records in portable lifecycle receipts (64 hex
// chars) and the short IDs podman also accepts. Deletion always uses the
// verified full ID from `podman inspect`.
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/u;
const FULL_CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/u;

export interface PortableLifecycleReceipt {
  readonly schemaVersion: number;
  readonly containerId: string;
  readonly sandboxName?: string;
  readonly registryGeneration?: string;
  readonly runtimeAuthority?: CheckpointPortableRuntimeAuthority;
}

export function portableReceiptDirectory(stateDir: string): string {
  return path.join(stateDir, RECEIPT_DIRECTORY);
}

export function defaultPortableStateDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME ?? os.homedir(), ".nemoclaw");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPortableReceipt(
  file: string,
  readFileSync: (file: string, encoding: "utf8") => string,
): PortableLifecycleReceipt | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text) as unknown;
    if (!isRecord(value)) return null;
    if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1)
      return null;
    if (
      typeof value.containerId !== "string" ||
      !CONTAINER_ID_PATTERN.test(value.containerId)
    ) {
      return null;
    }
    const receipt: PortableLifecycleReceipt = {
      schemaVersion: value.schemaVersion,
      containerId: value.containerId,
    };
    if (typeof value.sandboxName === "string")
      receipt.sandboxName = value.sandboxName;
    if (typeof value.registryGeneration === "string") {
      receipt.registryGeneration = value.registryGeneration;
    }
    if (value.schemaVersion >= CURRENT_RECEIPT_SCHEMA_VERSION) {
      const authority = parsePortableRuntimeAuthority(value.runtimeAuthority);
      if (authority === null) return null;
      receipt.runtimeAuthority = authority;
    }
    return receipt;
  } catch {
    return null;
  }
}

export function listPortableReceiptFiles(
  stateDir: string,
  readDirSync: (dir: string) => string[],
): string[] {
  let names: string[];
  try {
    names = readDirSync(portableReceiptDirectory(stateDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(portableReceiptDirectory(stateDir), name));
}

/** Parse the recorded authority out of a receipt, refusing pre-authority schema. */
export function resolveReceiptRuntimeAuthority(
  receipt: PortableLifecycleReceipt,
  uid: number | undefined,
):
  | { readonly authority: CheckpointPortableRuntimeAuthority }
  | { readonly reason: string } {
  if (receipt.schemaVersion < CURRENT_RECEIPT_SCHEMA_VERSION) {
    return {
      reason:
        "portable lifecycle receipt predates recorded portable Podman authority; re-run `onboard --experimental-profile portable` before uninstall",
    };
  }
  const authority = receipt.runtimeAuthority;
  if (
    authority === undefined ||
    authority.kind !== "podman" ||
    authority.ownership !== "current-user"
  ) {
    return {
      reason: "portable lifecycle receipt has no current-user Podman authority",
    };
  }
  if (typeof authority.uid !== "number") {
    return {
      reason: "portable lifecycle receipt has an invalid recorded user",
    };
  }
  if (uid !== undefined && authority.uid !== uid) {
    return {
      reason: `recorded portable Podman authority belongs to uid ${String(authority.uid)}, not the current uid ${String(uid)}`,
    };
  }
  return { authority };
}

/** Capture the CURRENT authority of the recorded socket and fail if it is gone or unsafe. */
export function revalidateSocketAuthority(
  socketPath: string,
  deps: PodmanSocketAuthorityDeps,
  uid: number | undefined,
): { readonly authority: PodmanSocketAuthority } | { readonly reason: string } {
  let authority: PodmanSocketAuthority;
  try {
    authority = capturePodmanSocketAuthority(socketPath, deps);
  } catch (error) {
    return {
      reason: `recorded portable Podman socket ${socketPath} could not be revalidated: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (uid !== undefined && authority.ownerUid !== String(uid)) {
    return {
      reason: `recorded portable Podman socket is owned by uid ${authority.ownerUid}, not the current uid ${String(uid)}`,
    };
  }
  return { authority };
}

/** A child environment pinned to the recorded rootless socket. */
export function portablePodmanEnv(
  env: NodeJS.ProcessEnv,
  socketPath: string,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  // Pin the Docker-compatible transport to the recorded socket so ambient
  // selectors cannot redirect deletion (mirrors the podman adapter's policy).
  childEnv.CONTAINER_HOST = `unix://${socketPath}`;
  delete childEnv.CONTAINER_CONNECTION;
  delete childEnv.CONTAINER_SSHKEY;
  return childEnv;
}

interface VerifiedContainer {
  readonly fullId: string;
  readonly running: boolean;
}

/** The NemoClaw ownership label carried by the portable registry container. */
const PORTABLE_REGISTRY_OWNERSHIP_LABEL = "com.nvidia.nemoclaw.portable";

/**
 * Inspect one container through the pinned transport and verify its identity
 * before any deletion. A sandbox identity (receipt-based) must carry the
 * OpenShell managed/sandbox labels; a registry identity must carry the
 * NemoClaw portable ownership label. Either way the resolved full container
 * ID must agree with the recorded ID, and deletion always uses that verified
 * full ID.
 */
export function verifyPortableContainer(
  containerId: string,
  identity:
    | { readonly kind: "sandbox"; readonly receipt: PortableLifecycleReceipt }
    | { readonly kind: "registry" },
  run: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult,
  env: NodeJS.ProcessEnv,
): { readonly verified: VerifiedContainer } | { readonly reason: string } {
  const inspect = run("podman", ["inspect", containerId], env);
  if (inspect.status !== 0) {
    return {
      reason: `could not inspect portable container ${containerId}: ${inspect.stderr.trim() || "unknown inspect failure"}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(inspect.stdout) as unknown;
  } catch {
    return {
      reason: `podman inspect for ${containerId} returned unparseable output`,
    };
  }
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    return {
      reason: `podman inspect for ${containerId} did not resolve exactly one container`,
    };
  }
  const container = value[0] as Record<string, unknown>;
  const inspectedId = typeof container.Id === "string" ? container.Id : "";
  if (!FULL_CONTAINER_ID_PATTERN.test(inspectedId)) {
    return {
      reason: `podman inspect for ${containerId} returned an invalid container ID`,
    };
  }
  // The receipt may carry a short or full ID; the resolved full ID must agree.
  const recorded = containerId.toLowerCase();
  const inspected = inspectedId.toLowerCase();
  if (inspected !== recorded && !inspected.startsWith(recorded)) {
    return {
      reason: `portable container ${containerId} resolved to ${inspectedId}, which does not match the recorded identity`,
    };
  }
  const state = isRecord(container.State)
    ? (container.State as Record<string, unknown>)
    : null;
  const config = isRecord(container.Config)
    ? (container.Config as Record<string, unknown>)
    : null;
  const labels =
    config !== null && isRecord(config.Labels)
      ? (config.Labels as Record<string, unknown>)
      : null;
  if (identity.kind === "sandbox") {
    const receipt = identity.receipt;
    if (labels === null || labels[PODMAN_MANAGED_LABEL] !== "true") {
      return {
        reason: `portable container ${inspectedId} is not openshell-managed`,
      };
    }
    if (
      receipt.sandboxName !== undefined &&
      labels[PODMAN_SANDBOX_NAME_LABEL] !== receipt.sandboxName
    ) {
      return {
        reason: `portable container ${inspectedId} sandbox name does not match the receipt`,
      };
    }
    if (labels[PODMAN_SANDBOX_NAMESPACE_LABEL] !== PODMAN_SANDBOX_NAMESPACE) {
      return {
        reason: `portable container ${inspectedId} sandbox namespace does not match`,
      };
    }
    if (labels[PODMAN_SANDBOX_WORKSPACE_LABEL] !== PODMAN_SANDBOX_WORKSPACE) {
      return {
        reason: `portable container ${inspectedId} sandbox workspace does not match`,
      };
    }
  } else if (
    labels === null ||
    labels[PORTABLE_REGISTRY_OWNERSHIP_LABEL] !== "1"
  ) {
    return {
      reason: `portable container ${inspectedId} is not a NemoClaw-owned portable registry`,
    };
  }
  return {
    verified: { fullId: inspectedId, running: state?.Running === true },
  };
}

export function removeVerifiedContainer(
  fullId: string,
  run: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): boolean {
  const result = run("podman", ["rm", "-f", fullId], env);
  if (result.status === 0) return true;
  warn(
    `  Could not remove portable container ${fullId}: ${result.stderr.trim()}`,
  );
  return false;
}

export function findPortableRegistryContainerIds(
  run: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const result = run(
    "podman",
    [
      "ps",
      "-a",
      "--filter",
      `label=${PORTABLE_REGISTRY_LABEL}`,
      "--format",
      "{{.ID}}",
    ],
    env,
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/u)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseShowEnvironment(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/**
 * Unset only the NemoClaw-owned user-manager selectors whose CURRENT value
 * still matches the recorded/derived projection. Never touches unrelated or
 * user-changed values. CONTAINER_CONNECTION and CONTAINER_SSHKEY have no
 * NemoClaw projection (NemoClaw strips them instead of setting them), so any
 * user value is preserved.
 */
export function clearPortableUserManagerSelectors(
  env: NodeJS.ProcessEnv,
  run: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => CommandResult,
  socketPath: string,
): readonly string[] {
  const result = run("systemctl", ["--user", "show-environment"], env);
  if (result.status !== 0) return [];
  const current = parseShowEnvironment(result.stdout);
  const toUnset: string[] = [];

  const containersConf = current.get("CONTAINERS_CONF");
  if (
    containersConf !== undefined &&
    containersConf.endsWith(PORTABLE_CONTAINERS_CONF_SUFFIX)
  ) {
    toUnset.push("CONTAINERS_CONF");
  }
  if (current.get("NETAVARK_FW") === "iptables") {
    toUnset.push("NETAVARK_FW");
  }
  if (current.get("CONTAINER_HOST") === `unix://${socketPath}`) {
    toUnset.push("CONTAINER_HOST");
  }

  for (const name of toUnset) {
    run("systemctl", ["--user", "unset-environment", name], env);
  }
  return toUnset;
}

export function teardownPortableRuntime(
  input: PortableTeardownInput,
): PortableTeardownResult {
  const env = input.env;
  const run =
    input.run ??
    ((
      command: string,
      args: string[],
      childEnv: NodeJS.ProcessEnv,
    ): CommandResult => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        env: childEnv,
      });
      return {
        status: result.status,
        stdout:
          typeof result.stdout === "string"
            ? result.stdout
            : String(result.stdout ?? ""),
        stderr:
          typeof result.stderr === "string"
            ? result.stderr
            : String(result.stderr ?? ""),
      };
    });
  const readDirSync = input.readDirSync ?? fs.readdirSync;
  const readFileSync = input.readFileSync ?? fs.readFileSync;
  const rmSync =
    input.rmSync ?? ((file: string) => fs.rmSync(file, { force: true }));
  const log = input.log ?? ((message: string) => console.log(message));
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const socketAuthorityDeps = input.socketAuthorityDeps ?? { uid: input.uid };

  const stateDir = input.stateDir ?? defaultPortableStateDir(env);
  const receiptFiles = listPortableReceiptFiles(stateDir, readDirSync);
  const removedContainerIds: string[] = [];
  const removedReceiptFiles: string[] = [];
  let ok = true;
  let reason = "";

  // 1. Receipt-owned sandbox containers. Every receipt must prove its socket
  // authority and container identity BEFORE any mutation; a single failure
  // preserves everything (receipts stay, so the exact container IDs survive
  // for retry).
  const consumedReceipts: Array<{
    file: string;
    receipt: PortableLifecycleReceipt;
  }> = [];
  const removedViaReceipt = new Set<string>();
  for (const file of receiptFiles) {
    const receipt = readPortableReceipt(file, readFileSync);
    if (receipt === null) {
      reason = `unreadable portable lifecycle receipt: ${file}; preserved for retry`;
      warn(`  Skipped unreadable portable lifecycle receipt: ${file}`);
      ok = false;
      continue;
    }
    const resolved = resolveReceiptRuntimeAuthority(receipt, input.uid);
    if ("reason" in resolved) {
      reason = `${resolved.reason} (receipt ${file}); preserved for retry`;
      warn(`  Refusing portable teardown: ${resolved.reason} (${file})`);
      ok = false;
      continue;
    }
    const authority = resolved.authority;
    const fence = revalidateSocketAuthority(
      authority.socketPath,
      socketAuthorityDeps,
      input.uid,
    );
    if ("reason" in fence) {
      reason = `${fence.reason}; preserved for retry`;
      warn(`  Refusing portable teardown: ${fence.reason}`);
      ok = false;
      continue;
    }
    const childEnv = portablePodmanEnv(env, authority.socketPath);
    const inspected = verifyPortableContainer(
      receipt.containerId,
      { kind: "sandbox", receipt },
      run,
      childEnv,
    );
    if ("reason" in inspected) {
      reason = `${inspected.reason}; preserved for retry`;
      warn(`  Refusing portable teardown: ${inspected.reason}`);
      ok = false;
      continue;
    }
    const { fullId } = inspected.verified;
    if (removeVerifiedContainer(fullId, run, childEnv, warn)) {
      removedViaReceipt.add(fullId);
      removedContainerIds.push(fullId);
      consumedReceipts.push({ file, receipt });
    } else {
      reason = `could not remove portable container ${fullId}; receipt preserved for retry`;
      ok = false;
    }
  }

  // 2. NemoClaw-owned registry containers, through the SAME recorded socket
  // authority (the first successfully fenced receipt's socket). Registry
  // containers are found by ownership label, never by name.
  if (ok && consumedReceipts.length > 0) {
    const authority = consumedReceipts[0].receipt.runtimeAuthority;
    const socketPath = authority !== undefined ? authority.socketPath : "";
    if (socketPath !== "") {
      const childEnv = portablePodmanEnv(env, socketPath);
      const registryIds = findPortableRegistryContainerIds(run, childEnv);
      for (const registryId of registryIds) {
        if (removedViaReceipt.has(registryId)) continue;
        // A label hit must still resolve to exactly one owned container.
        const inspected = verifyPortableContainer(
          registryId,
          { kind: "registry" },
          run,
          childEnv,
        );
        if ("reason" in inspected) {
          reason = `${inspected.reason}; preserved for retry`;
          warn(`  Refusing portable teardown: ${inspected.reason}`);
          ok = false;
          break;
        }
        if (
          removeVerifiedContainer(
            inspected.verified.fullId,
            run,
            childEnv,
            warn,
          )
        ) {
          removedContainerIds.push(inspected.verified.fullId);
        } else {
          reason = `could not remove portable registry container ${inspected.verified.fullId}; preserved for retry`;
          ok = false;
          break;
        }
      }
    }
  }

  // 3. Only after every exact container removal is verified: clear the
  // NemoClaw-owned user-manager selectors (value-matched projection).
  let unsetSelectors: readonly string[] = [];
  if (ok && consumedReceipts.length > 0) {
    const authority = consumedReceipts[0].receipt.runtimeAuthority;
    if (authority !== undefined) {
      unsetSelectors = clearPortableUserManagerSelectors(
        env,
        run,
        authority.socketPath,
      );
      if (unsetSelectors.length > 0) {
        log(
          `  Cleared NemoClaw portable selectors from the user manager: ${unsetSelectors.join(", ")}`,
        );
      }
    }
  }

  // 4. Retire the receipts only after verified deletion (and only for the
  // containers actually removed).
  if (ok) {
    for (const { file } of consumedReceipts) {
      rmSync(file);
      removedReceiptFiles.push(file);
    }
  }

  if (
    receiptFiles.length === 0 &&
    unsetSelectors.length === 0 &&
    removedContainerIds.length === 0
  ) {
    return {
      ok: true,
      removedContainerIds: [],
      unsetSelectors: [],
      removedReceiptFiles: [],
    };
  }

  if (!ok) {
    return {
      ok: false,
      removedContainerIds,
      unsetSelectors,
      removedReceiptFiles,
      reason:
        reason ||
        "Portable runtime cleanup did not complete; receipts and state were preserved for a safe retry.",
    };
  }
  return { ok: true, removedContainerIds, unsetSelectors, removedReceiptFiles };
}
