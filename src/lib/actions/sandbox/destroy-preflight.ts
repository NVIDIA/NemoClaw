// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { withModelRouterPortLifecycleLock } from "../../inference/gateway-route-mutation-lock";
import { DEFAULT_MODEL_ROUTER_PORT, isRoutedInferenceProvider } from "../../onboard/model-router";
import {
  doesModelRouterProcessOwnPort,
  inspectModelRouterProcessForPort,
  isRouterHealthy,
  stopModelRouterProcess,
} from "../../onboard/model-router-process";
import { listHostGatewayRegistryEntries } from "../../state/gateway-registry";
import type {
  acquireOnboardLock,
  compareAndSwapSession,
  releaseOnboardLock,
  Session,
} from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { type DestroyRunOpenshell, selectGatewayForSandboxDestroy } from "./destroy-gateway";
import { classifyDestroySandboxPresence } from "./destroy-presence";
import {
  getPersistedSandboxTargetGatewayName,
  getSandboxTargetGatewayName,
} from "./gateway-target";
import { assertMcpAdapterConfigMutationsAllowed } from "./mcp-bridge-runtime-capabilities";

export type SandboxDestroyPreflight = {
  cleanupGatewayName: string;
  runOpenshell: DestroyRunOpenshell;
  sandbox: SandboxEntry | null;
  sandboxConfirmedAbsent: boolean;
};

export function stopSandboxInferenceResources(
  sandboxName: string,
  sandbox: SandboxEntry | null,
): void {
  const nim = require("../../inference/nim") as {
    stopNimContainer: (name: string, opts?: { silent?: boolean }) => void;
    stopNimContainerByName: (name: string) => void;
  };
  if (sandbox?.nimContainer) {
    console.log(`  Stopping NIM for '${sandboxName}'...`);
    nim.stopNimContainerByName(sandbox.nimContainer);
  } else {
    // Older registry entries may not record the convention-named container.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

  // The Ollama auth proxy is per-sandbox. GPU model unload happens during
  // post-delete host cleanup, after the live sandbox is confirmed gone.
  if (sandbox?.provider?.includes("ollama")) {
    const { killStaleProxy } = require("../../inference/ollama/proxy") as {
      killStaleProxy: () => void;
    };
    killStaleProxy();
  }
}

export type StopModelRouterForDestroyedSandboxDeps = {
  acquireOnboardLock: typeof acquireOnboardLock;
  compareAndSwapSession: typeof compareAndSwapSession;
  expectedSession: Session | null;
  loadSession: () => Session | null;
  releaseOnboardLock: typeof releaseOnboardLock;
  inspectProcessForPort?: typeof inspectModelRouterProcessForPort;
  isHealthy?: typeof isRouterHealthy;
  isRoutedProvider?: typeof isRoutedInferenceProvider;
  listHostRegistryEntries?: typeof listHostGatewayRegistryEntries;
  log?: (message: string) => void;
  ownsPort?: typeof doesModelRouterProcessOwnPort;
  resolveHomeDir?: () => string;
  stopProcess?: (pid: number, port: number) => Promise<void>;
  warn?: (message: string) => void;
  withModelRouterPortLifecycleLock?: typeof withModelRouterPortLifecycleLock;
};

function sessionMatchesDestroySnapshot(current: Session | null, expected: Session | null): boolean {
  if (current === null || expected === null) return current === expected;
  return (
    current.sessionId === expected.sessionId &&
    current.updatedAt === expected.updatedAt &&
    current.sandboxName === expected.sandboxName &&
    current.endpointUrl === expected.endpointUrl &&
    current.routerPid === expected.routerPid &&
    current.routerCredentialHash === expected.routerCredentialHash
  );
}

export function resolveDestroyedSandboxRouterPort(endpointUrl: string | null | undefined): number {
  try {
    const port = Number(new URL(endpointUrl ?? "").port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_MODEL_ROUTER_PORT;
  } catch {
    return DEFAULT_MODEL_ROUTER_PORT;
  }
}

/**
 * Stop the host Model Router proxy after the last routed sandbox is destroyed.
 *
 * The router is a detached host process whose PID is recorded only in the
 * onboarding session (routerPid). Destroy never stopped it, so the orphan kept
 * its port and the next routed onboard failed with "Port 4000 already has a
 * healthy router endpoint" (#9098). This mirrors the uninstall teardown
 * (#5169) but stays scoped: it acts only when the destroyed sandbox was routed
 * and no registered routed sandbox in any gateway state root uses the same
 * router port, so a same-port peer keeps its router.
 *
 * The recorded PID is preferred only when the session sandbox and router port
 * match the destroyed sandbox. Otherwise, the /proc scan recovers the orphan
 * by verified command line, exactly like reconcileModelRouter's recovery path.
 * The current-user port lock and non-blocking onboarding session lock cover the
 * peer scan, stop, and session update. Destroy skips teardown when onboarding
 * owns the session lock or the pre-delete session snapshot changed. A stop
 * failure or inconclusive process inventory is a warning, not an error: the
 * sandbox delete already succeeded. The matching session keeps routerPid and
 * credential identity so uninstall and reconcile retain recovery evidence.
 */
export async function stopModelRouterForDestroyedSandbox(
  sandbox: SandboxEntry | null,
  deps: StopModelRouterForDestroyedSandboxDeps,
): Promise<boolean> {
  const isRoutedProvider = deps.isRoutedProvider ?? isRoutedInferenceProvider;
  if (!sandbox || !isRoutedProvider(sandbox.provider)) return false;
  const port = resolveDestroyedSandboxRouterPort(sandbox.endpointUrl);
  const withPortLock = deps.withModelRouterPortLifecycleLock ?? withModelRouterPortLifecycleLock;
  await withPortLock(port, async () => {
    const warn = deps.warn ?? console.warn;
    const sessionLock = deps.acquireOnboardLock("nemoclaw destroy Model Router teardown");
    if (!sessionLock.acquired) {
      warn(
        "Another onboarding run owns the session lock. Keeping the Model Router process and recovery identity.",
      );
      return;
    }

    let destroyedSessionId: string | null = null;
    try {
      const session = deps.loadSession();
      if (!sessionMatchesDestroySnapshot(session, deps.expectedSession)) {
        warn(
          "The onboarding session changed during destroy. Keeping the Model Router process and replacement session unchanged.",
        );
        return;
      }
      const sessionMatchesSandbox =
        session?.sandboxName === sandbox.name &&
        resolveDestroyedSandboxRouterPort(session.endpointUrl) === port;
      destroyedSessionId = session?.sandboxName === sandbox.name ? session.sessionId : null;

      const listHostRegistryEntries =
        deps.listHostRegistryEntries ?? listHostGatewayRegistryEntries;
      const home = (deps.resolveHomeDir ?? (() => process.env.HOME || os.homedir()))();
      // Called after selected-registry removal, so every remaining host entry is
      // a peer, including entries owned by a different gateway state root.
      const routedPeerRemains = listHostRegistryEntries(home).some(({ entry }) => {
        const provider = typeof entry.provider === "string" ? entry.provider : null;
        const endpointUrl = typeof entry.endpointUrl === "string" ? entry.endpointUrl : null;
        return (
          isRoutedProvider(provider) && resolveDestroyedSandboxRouterPort(endpointUrl) === port
        );
      });
      if (routedPeerRemains) return;

      const ownsPort = deps.ownsPort ?? doesModelRouterProcessOwnPort;
      const inspectProcessForPort = deps.inspectProcessForPort ?? inspectModelRouterProcessForPort;
      const isHealthy = deps.isHealthy ?? isRouterHealthy;
      const recordedPid = sessionMatchesSandbox ? (session.routerPid ?? null) : null;
      const recordedCredentialHash = sessionMatchesSandbox
        ? (session.routerCredentialHash ?? null)
        : null;
      let pid: number | null = null;
      if (ownsPort(recordedPid, port)) {
        pid = recordedPid as number;
      } else {
        const lookup = inspectProcessForPort(port);
        if (lookup.status === "unavailable") {
          warn(
            `Could not inspect the host process inventory for the Model Router on port ${port}. ` +
              "Keeping its session recovery identity; inspect the port listener before the next Model Router onboarding.",
          );
          return;
        }
        if (lookup.status === "found") {
          pid = lookup.pid;
        } else if (await isHealthy(port, 1000)) {
          warn(
            `No Model Router process could be confirmed for healthy port ${port}. ` +
              "Keeping its session recovery identity; inspect the port listener before the next Model Router onboarding.",
          );
          return;
        }
      }

      if (pid !== null) {
        const log = deps.log ?? console.log;
        log(`  Stopping Model Router (PID ${pid})...`);
        try {
          await (deps.stopProcess ?? stopModelRouterProcess)(pid, port);
        } catch (error) {
          warn(
            `Failed to stop the Model Router (PID ${pid}) on port ${port}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (ownsPort(pid, port)) {
            warn(
              `Inspect PID ${pid} and the listener on port ${port}; stop the process only after confirming it is still the matching model-router proxy.`,
            );
          } else {
            warn(
              `PID ${pid} no longer identifies the matching model-router proxy. Do not stop it by PID; inspect the listener on port ${port}.`,
            );
          }
          return;
        }
      }

      // Clear when either field is set: a matching session with only a
      // credential hash still carries stale router identity after its sandbox
      // is gone. A completed process scan plus an unhealthy port confirms that
      // no router remains when no PID was found.
      if (sessionMatchesSandbox && (recordedPid !== null || recordedCredentialHash !== null)) {
        deps.compareAndSwapSession(
          (current) =>
            current.sessionId === session.sessionId &&
            current.sandboxName === session.sandboxName &&
            current.endpointUrl === session.endpointUrl &&
            current.routerPid === recordedPid &&
            current.routerCredentialHash === recordedCredentialHash,
          (current) => {
            current.routerPid = null;
            current.routerCredentialHash = null;
            return current;
          },
          "nemoclaw destroy Model Router session cleanup",
        );
      }
    } finally {
      try {
        if (destroyedSessionId !== null) {
          deps.compareAndSwapSession(
            (current) =>
              current.sessionId === destroyedSessionId && current.sandboxName === sandbox.name,
            (current) => {
              current.sandboxName = null;
              return current;
            },
            "nemoclaw destroy sandbox session cleanup",
          );
        }
      } finally {
        deps.releaseOnboardLock();
      }
    }
  });
  return true;
}

export function prepareSandboxDestroy(
  sandboxName: string,
  {
    force = false,
    retainedRecoveryGatewayName,
  }: { force?: boolean; retainedRecoveryGatewayName?: string } = {},
): SandboxDestroyPreflight {
  const sandbox = registry.getSandbox(sandboxName);
  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: DestroyRunOpenshell;
  };

  // Capture the sandbox gateway before destructive work, then pin every
  // following OpenShell subprocess against that same durable authority. A
  // retained recovery record remains authoritative after a partial destroy
  // has already retired the registry row.
  const registeredGatewayName = sandbox ? getPersistedSandboxTargetGatewayName(sandbox) : null;
  if (
    retainedRecoveryGatewayName &&
    registeredGatewayName &&
    retainedRecoveryGatewayName !== registeredGatewayName
  ) {
    throw new Error(
      `Refusing to destroy sandbox '${sandboxName}': retained recovery gateway '${retainedRecoveryGatewayName}' does not match registered gateway '${registeredGatewayName}'.`,
    );
  }
  const cleanupGatewayName =
    retainedRecoveryGatewayName ?? registeredGatewayName ?? getSandboxTargetGatewayName();
  selectGatewayForSandboxDestroy(sandboxName, cleanupGatewayName, runOpenshell);
  process.env.OPENSHELL_GATEWAY = cleanupGatewayName;

  const sandboxPresence = classifyDestroySandboxPresence(
    sandboxName,
    runOpenshell(["sandbox", "list", "-o", "json"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    }),
  );
  const sandboxConfirmedAbsent = sandboxPresence === "absent";
  const mcpEntriesRequiringConfigMutation = Object.values(sandbox?.mcp?.bridges ?? {}).filter(
    (entry) => entry.addState !== "prepared",
  );
  if (
    !sandboxConfirmedAbsent &&
    sandbox &&
    !sandbox.mcp?.destroyPreparedAt &&
    !sandbox.mcp?.destroyPendingAt &&
    mcpEntriesRequiringConfigMutation.length > 0 &&
    // `--force` accepts leaving the retained-volume adapter entry in place, so
    // this early refusal must not block it before any teardown starts. The
    // preparation phase reclassifies the same refusal and reports what it kept.
    !force
  ) {
    // Fail before stopping local services or mutating any MCP resource when
    // the live adapter config cannot be changed safely.
    assertMcpAdapterConfigMutationsAllowed(sandboxName, sandbox, mcpEntriesRequiringConfigMutation);
  }

  return { cleanupGatewayName, runOpenshell, sandbox, sandboxConfirmedAbsent };
}
