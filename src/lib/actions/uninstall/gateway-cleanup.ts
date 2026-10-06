// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSandboxContainerOwner } from "../../domain/sandbox/container-owner";
import { fingerprintOpenShellSandboxId } from "../../domain/sandbox/openshell-identity";
import {
  listGatewayStateRoots,
  readGatewayRegistryFile,
  registryEntryGatewayPort,
  type GatewayRegistryEntry,
} from "../../state/gateway-registry";
import type { RunResult } from "../../adapters/uninstall/commands";

import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  getMcpLifecycleLockPath,
  MCP_LIFECYCLE_LOCK_DIRNAME,
} from "../../state/mcp-lifecycle-lock-storage";
import type { OpenShellGatewayReuseObserver } from "../../adapters/openshell/gateway-reuse";
import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import {
  isInterruptedPreGatewaySession,
  isInterruptedPreGatewayTeardownSession,
  removeGatewayRegistrationThroughAdapter,
  resolveGatewayTeardownAuthority,
  type GatewayTeardownAuthorityResolver,
} from "../../onboard/gateway-teardown-authority";

export {
  type GatewayTeardownAuthorityResolver,
  isInterruptedPreGatewaySession,
  isInterruptedPreGatewayTeardownSession,
  resolveGatewayTeardownAuthority,
};

/** Gateway-specific dependencies needed by uninstall's cleanup transaction. */
export interface GatewayCleanupRuntime {
  commandExists(command: string): boolean;
  env: NodeJS.ProcessEnv;
  gatewayLifecycle: OpenShellGatewayLifecycle;
  gatewayReuseObserver: OpenShellGatewayReuseObserver;
  runDocker(args: string[], options?: SpawnSyncOptions): { status: number | null };
  resolveGatewayTeardownAuthority: GatewayTeardownAuthorityResolver;
  log(message: string): void;
  warn(message: string): void;
}

export async function portableGatewayIsReachable(
  runtime: GatewayCleanupRuntime,
  gatewayName: string,
): Promise<boolean> {
  const observed = await runtime.gatewayReuseObserver.observeGatewayReuse({
    target: { kind: "named", gatewayName },
  });
  return !observed.error && observed.healthy && observed.namedMetadata;
}

export async function removeGatewayRegistration(
  runtime: GatewayCleanupRuntime,
  gatewayLabel: string,
  allowLegacyDestroy: boolean,
  gatewayPort: number,
): Promise<boolean> {
  const outcome = await removeGatewayRegistrationThroughAdapter({
    gatewayName: gatewayLabel,
    allowLegacyDestroy,
    lifecycle: runtime.gatewayLifecycle,
    revalidateAuthority: () =>
      runtime.resolveGatewayTeardownAuthority(
        {
          gatewayName: gatewayLabel,
          gatewayPort,
        },
        { allowMissingPackagedServiceTeardown: true, env: runtime.env },
      ),
  });
  if (!outcome.ok) {
    if (outcome.unsupported && !allowLegacyDestroy) {
      runtime.warn(
        `Could not remove local registration for externally supervised gateway '${gatewayLabel}'. ` +
          "NemoClaw will not use the legacy gateway destroy command for an externally supervised gateway.",
      );
      return false;
    }
    runtime.warn(
      `Could not remove gateway registration '${gatewayLabel}': ${outcome.error.message}`,
    );
    if (
      !runtime.commandExists("docker") ||
      runtime.runDocker(["info"], { env: runtime.env, stdio: "ignore", timeout: 10_000 }).status !==
        0
    ) {
      runtime.warn(
        "Docker is not available in this shell. Restore Docker access. " +
          "If using Docker Desktop on Windows, enable WSL integration for this distro. " +
          "For WSL, save work in all sessions before running wsl --shutdown from PowerShell. Reopen the distro afterward. " +
          "Verify docker info succeeds, then rerun the same uninstall command.",
      );
    }
    return false;
  }
  if (outcome.state === "absent") runtime.warn(`Gateway '${gatewayLabel}' is already absent`);
  else runtime.log(`Removed gateway registration '${gatewayLabel}'`);
  return true;
}

/**
 * Names of the gateways OpenShell currently knows about, or `null` when that
 * cannot be determined (OpenShell missing, the query failed, or its output was
 * unparseable). `null` always means "stay conservative": callers must not treat
 * an absence they cannot prove as evidence that a gateway is gone. (#7315)
 */
export async function collectLiveOpenShellGatewayNames(
  runtime: GatewayCleanupRuntime,
  gatewayName: string,
): Promise<Set<string> | null> {
  if (!runtime.commandExists("openshell")) return null;
  const result = await runtime.gatewayLifecycle.listGateways({
    target: { kind: "named", gatewayName },
  });
  return result.ok ? new Set(result.names) : null;
}

/** Admit only empty lifecycle state or locks held by this uninstall transaction. */
export function gatewayLifecycleStateContainsOnlyOwnedLocks(
  sharedRoot: string,
  ownedSandboxNames: readonly string[] = [],
): boolean {
  const stateDir = path.join(sharedRoot, "state");
  try {
    const state = fs.lstatSync(stateDir);
    if (state.isSymbolicLink() || !state.isDirectory()) return false;
    const entries = fs.readdirSync(stateDir);
    if (entries.length === 0) return true;
    if (entries.length !== 1 || entries[0] !== MCP_LIFECYCLE_LOCK_DIRNAME) return false;
    const locksDir = path.join(stateDir, MCP_LIFECYCLE_LOCK_DIRNAME);
    const locks = fs.lstatSync(locksDir);
    return (
      !locks.isSymbolicLink() &&
      locks.isDirectory() &&
      fs
        .readdirSync(locksDir, { withFileTypes: true })
        .every(
          (entry) =>
            entry.isFile() &&
            ownedSandboxNames.some(
              (name) =>
                path.basename(getMcpLifecycleLockPath(name, stateDir)) === entry.name &&
                isMcpLifecycleLockHeld(name, stateDir),
            ),
        )
    );
  } catch {
    return false;
  }
}

export type RetainedSandboxInventoryFailure = "inventory" | "selected-container" | "identity";

export class RetainedSandboxInventoryError extends Error {
  constructor(reason: RetainedSandboxInventoryFailure) {
    const actions = {
      inventory:
        "Docker inventory could not be read. Restore Docker access, verify docker info succeeds, and retry.",
      "selected-container":
        "A selected sandbox container remains. Inspect it and complete its gateway-scoped cleanup before retrying.",
      identity:
        "Same-name container ownership could not be confirmed. Restore access to the owning gateway and resolve the identity conflict before retrying.",
    };
    super(
      `Retained uninstall data was preserved: ${actions[reason]} Keep NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR unset for this retained-data recovery.`,
    );
    this.name = "RetainedSandboxInventoryError";
  }
}

/** Check removed sandboxes before uninstall discards their registry evidence. Names never authorize deletion. */
export function findUnresolvedDockerSandboxes(
  home: string,
  selectedPort: number,
  names: readonly string[],
  registrations: Record<string, GatewayRegistryEntry>,
  containerNames: readonly string[],
  capture: (args: string[]) => RunResult,
  captureOpenShell: (args: string[]) => RunResult,
): string[] {
  return names.filter((name) => {
    const entry = registrations[name];
    if (
      !entry ||
      entry.openshellDriver !== "docker" ||
      typeof entry.lifecycleLiveIdentityFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.lifecycleLiveIdentityFingerprint) ||
      entry.pendingCreateIdentity !== undefined ||
      entry.pendingRouteReservation !== undefined
    ) {
      return containerNames.some(
        (container) => resolveSandboxContainerOwner(container, name, names) === container,
      );
    }
    return !retainedDockerSandboxIsAbsent(
      home,
      selectedPort,
      name,
      entry,
      capture,
      captureOpenShell,
    );
  });
}

/** Establish absence without mistaking a known sibling's immutable identity for this sandbox. */
export function retainedDockerSandboxIsAbsent(
  home: string,
  selectedPort: number,
  sandboxName: string,
  selected: GatewayRegistryEntry,
  capture: (args: string[]) => RunResult,
  captureOpenShell: (args: string[]) => RunResult,
  onFailure?: (reason: RetainedSandboxInventoryFailure) => void,
): boolean {
  const refuse = (reason: RetainedSandboxInventoryFailure = "identity"): false => {
    onFailure?.(reason);
    return false;
  };
  const listed = capture([
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    `label=openshell.ai/sandbox-name=${sandboxName}`,
    "--format",
    "{{.ID}}",
  ]);
  if (listed.status !== 0 || listed.error || listed.signal) return refuse("inventory");
  const ids = listed.stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return true;
  const selectedIdentity = selected.lifecycleLiveIdentityFingerprint;
  if (typeof selectedIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(selectedIdentity))
    return refuse();
  const siblingIdentities = new Map<string, { port: number; gateway: string }>();
  for (const { root } of listGatewayStateRoots(home)) {
    const entry = readGatewayRegistryFile(home, path.join(root, "sandboxes.json"))?.sandboxes[
      sandboxName
    ];
    if (!entry) continue;
    const port = registryEntryGatewayPort(entry);
    if (
      port === selectedPort ||
      entry.openshellDriver !== "docker" ||
      entry.pendingRouteReservation !== undefined ||
      entry.pendingCreateIdentity !== undefined
    )
      continue;
    const identity = entry.lifecycleLiveIdentityFingerprint;
    if (
      typeof identity !== "string" ||
      !/^[a-f0-9]{64}$/u.test(identity) ||
      typeof entry.createdAt !== "string" ||
      !Number.isFinite(Date.parse(entry.createdAt))
    )
      continue;
    if (typeof entry.gatewayName !== "string" || !entry.gatewayName) continue;
    const previous = siblingIdentities.get(identity);
    if (previous !== undefined && previous.port !== port) return refuse();
    siblingIdentities.set(identity, { port, gateway: entry.gatewayName });
  }
  return ids.every((id) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) return refuse();
    const result = capture([
      "inspect",
      "--type",
      "container",
      "--format",
      "[{{json .Id}},{{json .Config.Labels}}]",
      id,
    ]);
    if (result.status !== 0 || result.error || result.signal) return refuse("inventory");
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      return refuse();
    }
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value[0] !== id ||
      !value[1] ||
      typeof value[1] !== "object" ||
      Array.isArray(value[1])
    )
      return refuse();
    const labels = value[1] as Record<string, unknown>;
    if (
      labels["openshell.ai/managed-by"] !== "openshell" ||
      labels["openshell.ai/sandbox-name"] !== sandboxName ||
      typeof labels["openshell.ai/sandbox-id"] !== "string"
    )
      return refuse();
    const namespace = labels["openshell.ai/sandbox-namespace"];
    if (typeof namespace !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(namespace))
      return refuse();
    const identity = fingerprintOpenShellSandboxId(labels["openshell.ai/sandbox-id"]);
    if (identity === null) return refuse();
    if (identity === selectedIdentity) return refuse("selected-container");
    const sibling = siblingIdentities.get(identity);
    if (!sibling) return refuse();
    const live = captureOpenShell([
      "sandbox",
      "get",
      "-g",
      sibling.gateway,
      sandboxName,
      "-o",
      "json",
    ]);
    if (live.status !== 0 || live.error || live.signal) return refuse();
    let liveSandbox: unknown;
    try {
      liveSandbox = JSON.parse(live.stdout);
    } catch {
      return refuse();
    }
    if (!liveSandbox || typeof liveSandbox !== "object" || Array.isArray(liveSandbox))
      return refuse();
    const observed = liveSandbox as Record<string, unknown>;
    return (
      (observed.name === sandboxName &&
        typeof observed.id === "string" &&
        fingerprintOpenShellSandboxId(observed.id) === identity) ||
      refuse()
    );
  });
}
