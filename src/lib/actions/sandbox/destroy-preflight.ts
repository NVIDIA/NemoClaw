// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { isRoutedInferenceProvider } from "../../onboard/model-router";
import {
  doesModelRouterProcessOwnPort,
  findModelRouterPidForPort,
  stopModelRouterProcess,
} from "../../onboard/model-router-process";
import type { Session } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { type DestroyRunOpenshell, selectGatewayForSandboxDestroy } from "./destroy-gateway";
import { classifyDestroySandboxPresence } from "./destroy-presence";
import { getSandboxTargetGatewayName } from "./gateway-target";
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

// Routed onboard profiles use blueprint port 4000 by default; matches the
// uninstall teardown default in src/lib/actions/uninstall/run-plan.ts.
const DEFAULT_MODEL_ROUTER_PORT = 4000;

export type StopModelRouterForDestroyedSandboxDeps = {
  loadSession: () => Session | null;
  updateSession: (mutator: (session: Session) => Session | void) => Session;
  findPidForPort?: typeof findModelRouterPidForPort;
  isRoutedProvider?: typeof isRoutedInferenceProvider;
  listSandboxes?: typeof registry.listSandboxes;
  log?: (message: string) => void;
  ownsPort?: typeof doesModelRouterProcessOwnPort;
  stopProcess?: (pid: number, port: number) => Promise<void>;
  warn?: (message: string) => void;
};

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
 * and no registered routed sandbox remains, so a routed peer keeps its router.
 *
 * The recorded PID is preferred; when a fresh session no longer records it,
 * the /proc scan recovers the orphan by verified command line, exactly like
 * reconcileModelRouter's recovery path. A stop failure is a warning, not an
 * error: the sandbox delete already succeeded, and a stuck session-global host
 * proxy must not fail the destroy. The session keeps routerPid on failure so
 * uninstall and reconcile can still find the process.
 */
export async function stopModelRouterForDestroyedSandbox(
  sandbox: SandboxEntry | null,
  deps: StopModelRouterForDestroyedSandboxDeps,
): Promise<void> {
  const isRoutedProvider = deps.isRoutedProvider ?? isRoutedInferenceProvider;
  if (!isRoutedProvider(sandbox?.provider)) return;
  const port = resolveDestroyedSandboxRouterPort(sandbox?.endpointUrl);
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  // Called after registry removal, so every remaining entry is a peer.
  const routedPeerRemains = listSandboxes().sandboxes.some(
    (entry) =>
      isRoutedProvider(entry.provider) &&
      resolveDestroyedSandboxRouterPort(entry.endpointUrl) === port,
  );
  if (routedPeerRemains) return;

  const ownsPort = deps.ownsPort ?? doesModelRouterProcessOwnPort;
  const findPidForPort = deps.findPidForPort ?? findModelRouterPidForPort;
  const session = deps.loadSession();
  const recordedPid = session?.routerPid ?? null;
  const recordedCredentialHash = session?.routerCredentialHash ?? null;
  const recordedPidOwnsPort = ownsPort(recordedPid, port);
  const sessionMatchesDestroyedSandbox =
    session !== null &&
    session.sandboxName === sandbox?.name &&
    resolveDestroyedSandboxRouterPort(session.endpointUrl) === port;
  const sessionOwnsTargetRouter = recordedPidOwnsPort || sessionMatchesDestroyedSandbox;
  const pid = recordedPidOwnsPort ? (recordedPid as number) : findPidForPort(port);

  if (pid !== null) {
    const log = deps.log ?? console.log;
    const warn = deps.warn ?? console.warn;
    log(`  Stopping Model Router (PID ${pid})...`);
    try {
      await (deps.stopProcess ?? stopModelRouterProcess)(pid, port);
    } catch (error) {
      warn(
        `Failed to stop the Model Router (PID ${pid}) on port ${port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      warn(
        `Stop it manually (kill ${pid}) before the next Model Router onboarding, or onboarding fails with "Port ${port} already has a healthy router endpoint".`,
      );
      return;
    }
  }

  // Clear when either field is set: a session with only a credential hash
  // still carries stale router identity after the last routed sandbox is gone.
  if (sessionOwnsTargetRouter && (recordedPid !== null || recordedCredentialHash !== null)) {
    deps.updateSession((current: Session) => {
      if (
        current.sessionId !== session?.sessionId ||
        current.sandboxName !== session?.sandboxName ||
        current.endpointUrl !== session?.endpointUrl ||
        current.routerPid !== recordedPid ||
        current.routerCredentialHash !== recordedCredentialHash
      ) {
        return current;
      }
      current.routerPid = null;
      current.routerCredentialHash = null;
      return current;
    });
  }
}

export function prepareSandboxDestroy(sandboxName: string): SandboxDestroyPreflight {
  const sandbox = registry.getSandbox(sandboxName);
  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: DestroyRunOpenshell;
  };

  // Capture the sandbox gateway before destructive work, then pin every
  // following OpenShell subprocess against that same registry-owned gateway.
  const cleanupGatewayName = getSandboxTargetGatewayName(sandboxName);
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
    mcpEntriesRequiringConfigMutation.length > 0
  ) {
    // Fail before stopping local services or mutating any MCP resource when
    // the live adapter config cannot be changed safely.
    assertMcpAdapterConfigMutationsAllowed(sandboxName, sandbox, mcpEntriesRequiringConfigMutation);
  }

  return { cleanupGatewayName, runOpenshell, sandbox, sandboxConfirmedAbsent };
}
