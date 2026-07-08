// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell, isCommandTimeout, runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { DASHBOARD_PORT } from "../../core/ports";
import { waitUntil } from "../../core/wait";
import { getActiveMessagingHostForward } from "../../messaging/host-forward";
import type { SandboxMessagingHostForwardPlan } from "../../messaging/manifest";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/persistence";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import * as registry from "../../state/registry";
import { parseForwardList } from "../../state/sandbox-session";
import {
  classifyForwardHealthWithReachability,
  isLocalForwardReachable,
  type SandboxForwardHealth,
  type SandboxForwardListEntry,
} from "./forward-health";
import {
  ensureHermesDashboardPortForwardIfEnabled as ensureHermesDashboardPortForward,
  getHermesDashboardRecoveryConfig,
} from "./hermes-dashboard-recovery";

type SandboxPortAgent = { forwardPort?: unknown; runtime?: { kind?: unknown } } | null;

type SandboxPortDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: (sandboxName?: string) => SandboxPortAgent;
};

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function resolveSandboxDashboardPort(
  sandboxName: string,
  deps: SandboxPortDeps = {},
): number {
  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (agent && agentRuntime.hasGatewayRuntime(agent) && isValidPort(agent.forwardPort)) {
    return agent.forwardPort;
  }

  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sandbox = getSandbox(sandboxName);
  return isValidPort(sandbox?.dashboardPort) ? sandbox.dashboardPort : DASHBOARD_PORT;
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the recorded dashboard port for OpenClaw sandboxes, or the agent's
 * declared forward port when a non-OpenClaw agent is active.
 * Returns true when `forward start` succeeded and a follow-up probe
 * confirms the new entry is running, false otherwise.
 */
export function ensureSandboxPortForward(sandboxName: string): boolean {
  return ensureSandboxPortForwardForPort(sandboxName, resolveSandboxDashboardPort(sandboxName));
}

/**
 * Probe `openshell forward list` for the sandbox's dashboard forward.
 * Returns true when an entry exists for the expected sandbox+port pair
 * with STATUS=running, false when the entry is missing or non-running,
 * "occupied" when another sandbox already owns the expected port, and
 * null when openshell is unreachable.
 *
 * The in-sandbox gateway and the host-side forward are independent
 * dimensions: the forward can die (host SSH session dropped, list shows
 * STATUS=dead) while the gateway keeps listening on 127.0.0.1:<port>.
 *
 * Local reachability is intentionally not sufficient: an unrelated listener
 * cannot prove that OpenShell assigned this sandbox the requested host port.
 */
export function isSandboxForwardHealthy(sandboxName: string): SandboxForwardHealth {
  return isSandboxPortForwardHealthy(sandboxName, resolveSandboxDashboardPort(sandboxName));
}

export function isSandboxPortForwardHealthy(
  sandboxName: string,
  port: number,
): SandboxForwardHealth {
  const result = captureOpenshell(["forward", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (!result || isCommandTimeout(result) || result.status !== 0) return null;
  const entries = parseForwardList(result.output) as SandboxForwardListEntry[];
  return classifyForwardHealthWithReachability(entries, sandboxName, String(port), () =>
    isLocalForwardReachable(port),
  );
}

export function ensureSandboxPortForwardForPort(sandboxName: string, port: number): boolean {
  let forwardHealth = isSandboxPortForwardHealthy(sandboxName, port);
  if (forwardHealth === true) return true;
  if (forwardHealth === "occupied") return false;
  const configuredWaitMs = Number(process.env.NEMOCLAW_FORWARD_RECOVERY_WAIT_MS ?? "3000");
  const waitMs = Number.isFinite(configuredWaitMs) ? Math.max(0, configuredWaitMs) : 3000;

  const stopResult = runOpenshell(["forward", "stop", String(port), sandboxName], {
    ignoreError: true,
    stdio: "ignore",
  });
  if (stopResult.status !== 0) {
    console.error(
      `  Warning: openshell forward stop ${port} ${sandboxName} exited ${stopResult.status}; attempting restart anyway.`,
    );
  }

  // OpenShell v0.0.72 removes the forward PID file shortly after SIGTERM,
  // before the old SSH listener is guaranteed to release its host port. A
  // blind stop -> start can therefore collide with the just-stopped process.
  // Preserve authoritative owner metadata while waiting: accept a target-
  // owned forward that recovered on its own, reject another sandbox, and only
  // start after an otherwise-unowned local listener has actually quiesced.
  // NemoClaw must compensate while the already-released OpenShell 0.0.72
  // contract remains supported; test/process-recovery.test.ts locks both the
  // delayed-release and fail-closed cases. Remove this wait only after every
  // supported OpenShell release either waits for host-listener release before
  // `forward stop` returns or exposes an authoritative listener-released state
  // that this path consumes instead.
  if (waitMs > 0 && isLocalForwardReachable(port)) {
    const stopState: { health: SandboxForwardHealth; portReleased: boolean } = {
      health: forwardHealth,
      portReleased: false,
    };
    const stopSettled = waitUntil(
      () => {
        stopState.health = isSandboxPortForwardHealthy(sandboxName, port);
        stopState.portReleased = !isLocalForwardReachable(port);
        return (
          stopState.health === true || stopState.health === "occupied" || stopState.portReleased
        );
      },
      {
        deadlineMs: Date.now() + waitMs,
        initialIntervalMs: 100,
        maxIntervalMs: 500,
        backoffFactor: 1.5,
      },
    );
    if (stopState.health === true) return true;
    if (stopState.health === "occupied" || !stopSettled || !stopState.portReleased) return false;
  }

  const startResult = runOpenshell(
    ["forward", "start", "--background", String(port), sandboxName],
    {
      ignoreError: true,
    },
  );
  if (startResult.status !== 0) return false;

  // `forward start --background` can return before its authoritative list
  // entry becomes visible. Poll for the exact live sandbox+port owner instead
  // of accepting an arbitrary reachable listener or failing on the first
  // metadata refresh.
  let health = isSandboxPortForwardHealthy(sandboxName, port);
  if (health === true) return true;
  if (health === "occupied") return false;
  if (waitMs === 0) return false;

  let occupied = false;
  const settled = waitUntil(
    () => {
      health = isSandboxPortForwardHealthy(sandboxName, port);
      if (health === "occupied") {
        occupied = true;
        return true;
      }
      return health === true;
    },
    {
      deadlineMs: Date.now() + waitMs,
      initialIntervalMs: 100,
      maxIntervalMs: 500,
      backoffFactor: 1.5,
    },
  );
  return settled && !occupied;
}

export function ensureHermesDashboardPortForwardIfEnabled(sandboxName: string): boolean | null {
  return ensureHermesDashboardPortForward(sandboxName, {
    isPortForwardHealthy: isSandboxPortForwardHealthy,
    ensurePortForward: ensureSandboxPortForwardForPort,
  });
}

function getSandboxMessagingHostForward(
  sandboxName: string,
): SandboxMessagingHostForwardPlan | null {
  const entry = registry.getSandbox(sandboxName);
  const parsed = parseSandboxMessagingPlan(entry?.messaging?.plan, { sandboxName });
  const plan = parsed ? hydrateDerivedSandboxMessagingPlanFields(parsed) : null;
  return getActiveMessagingHostForward(plan);
}

export function ensureMessagingHostForwardHealthy(sandboxName: string): boolean | null {
  const forward = getSandboxMessagingHostForward(sandboxName);
  if (!forward) return null;
  const health = isSandboxPortForwardHealthy(sandboxName, forward.port);
  if (health === true) return true;
  if (health === "occupied") return false;
  return ensureSandboxPortForwardForPort(sandboxName, forward.port);
}

export function recoverMessagingHostForward(
  sandboxName: string,
  { quiet }: { quiet: boolean },
): boolean | null {
  const recovered = ensureMessagingHostForwardHealthy(sandboxName);
  if (!quiet && recovered === false) {
    console.error("  Messaging webhook port forward could not be re-established.");
  }
  return recovered;
}

/**
 * Re-establish every declared `forward_ports` entry on the active agent
 * manifest that is not already owned by another recovery helper. The
 * primary dashboard port is owned by `ensureSandboxPortForward`; the
 * optional Hermes web dashboard port is owned by
 * `ensureHermesDashboardPortForwardIfEnabled`.
 */
export function ensureDeclaredAgentForwardPortsHealthy(
  sandboxName: string,
  primaryPort: number,
): boolean | null {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (!agent) return null;
  const declared = (agent as { forward_ports?: unknown }).forward_ports;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName);
  const skipSet = new Set<number>([primaryPort]);
  if (hermesDashboard && Number.isInteger(hermesDashboard.publicPort)) {
    skipSet.add(hermesDashboard.publicPort);
  }
  let sawCovered = false;
  let allHealthy = true;
  for (const candidate of declared) {
    if (typeof candidate !== "number") continue;
    if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) continue;
    if (skipSet.has(candidate)) continue;
    sawCovered = true;
    const health = isSandboxPortForwardHealthy(sandboxName, candidate);
    if (health === true) continue;
    if (health === "occupied") {
      allHealthy = false;
      continue;
    }
    if (!ensureSandboxPortForwardForPort(sandboxName, candidate)) {
      allHealthy = false;
    }
  }
  if (!sawCovered) return null;
  return allHealthy;
}

export function recoverDeclaredAgentForwardPorts(
  sandboxName: string,
  recoveryPort: number,
  { quiet }: { quiet: boolean },
): boolean | null {
  const recovered = ensureDeclaredAgentForwardPortsHealthy(sandboxName, recoveryPort);
  if (!quiet && recovered === false) {
    console.error("  One or more agent-declared port forwards could not be re-established.");
  }
  return recovered;
}
