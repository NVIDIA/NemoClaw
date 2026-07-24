// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { captureOpenshell, isCommandTimeout, runOpenshell } from "../../adapters/openshell/runtime";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { DASHBOARD_PORT } from "../../core/ports";
import { waitUntil } from "../../core/wait";
import { getActiveMessagingHostForward } from "../../messaging/host-forward";
import type { SandboxMessagingHostForwardPlan } from "../../messaging/manifest";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/persistence";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { isRemoteDashboardBindRequested } from "../../onboard/dockerfile-remote-dashboard-bind-contract";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { isWsl } from "../../platform";
import { ROOT } from "../../state/paths";
import * as registry from "../../state/registry";
import { parseForwardList } from "../../state/sandbox-session";
import { buildSubprocessEnv } from "../../subprocess-env";
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

type SandboxForwardRecoveryOptions = {
  afterSuccess?: () => boolean;
  beforeStart?: () => boolean;
  isWsl?: boolean;
};

type DashboardForwardStopRunner = (
  args: string[],
  options: { ignoreError: true; stdio: "ignore"; timeout: number },
) => { status?: number | null };

const FORWARD_RELEASE_TIMEOUT_MS = 5_000;
const FORWARD_RELEASE_POLL_MS = 250;

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function runDashboardForwardStopBestEffort(
  args: string[],
  options: { timeout: number },
): { status?: number | null } {
  try {
    const openshellBinary = resolveOpenshell();
    if (!openshellBinary) return { status: 1 };
    return spawnSync(openshellBinary, args, {
      cwd: ROOT,
      env: buildSubprocessEnv(),
      stdio: "ignore",
      timeout: options.timeout,
    });
  } catch {
    // The container lifecycle action has already completed; cleanup must not
    // replace that result when OpenShell cannot be launched.
    return { status: 1 };
  }
}

function confirmDashboardForwardReleased(
  port: number,
  isForwardReachable: (port: number) => boolean,
): boolean {
  const now = Date.now;
  return waitUntil(() => !isForwardReachable(port), {
    deadlineMs: now() + FORWARD_RELEASE_TIMEOUT_MS,
    initialIntervalMs: FORWARD_RELEASE_POLL_MS,
    maxIntervalMs: FORWARD_RELEASE_POLL_MS,
    backoffFactor: 1,
    now,
  });
}

export function resolveSandboxDashboardPort(
  sandboxName: string,
  deps: SandboxPortDeps = {},
): number {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sandbox = getSandbox(sandboxName);
  if (isValidPort(sandbox?.dashboardPort)) {
    return sandbox.dashboardPort;
  }

  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName);
  if (agent && agentRuntime.hasGatewayRuntime(agent) && isValidPort(agent.forwardPort)) {
    return agent.forwardPort;
  }

  return DASHBOARD_PORT;
}

/**
 * Tear down the host-side dashboard port-forward this sandbox created.
 *
 * `stop` stops the container but must also release the forward it spawned;
 * leaving it alive orphans an `ssh -L` listener on the dashboard port, which
 * `status` then misreports as a foreign `sandbox_dashboard_port_conflict` and
 * which `start`/`recover` contend with (#7227). Best-effort: a stop must still
 * free container resources when openshell is unreachable, so errors are ignored
 * — mirroring the sandbox- and gateway-scoped forward cleanup used elsewhere.
 * OpenShell may return before its SSH listener exits, so successful commands
 * also receive a bounded host-port release wait.
 */
export function teardownSandboxDashboardForward(
  sandboxName: string,
  deps: {
    getSandbox?: typeof registry.getSandbox;
    isLocalForwardReachable?: typeof isLocalForwardReachable;
    resolveSandboxDashboardPort?: typeof resolveSandboxDashboardPort;
    resolveSandboxGatewayName?: typeof resolveSandboxGatewayName;
    runOpenshell?: DashboardForwardStopRunner;
  } = {},
): void {
  try {
    const getSandbox = deps.getSandbox ?? registry.getSandbox;
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return;
    const gatewayName = (deps.resolveSandboxGatewayName ?? resolveSandboxGatewayName)(sandbox);
    const resolvePort = deps.resolveSandboxDashboardPort ?? resolveSandboxDashboardPort;
    const port = resolvePort(sandboxName, { getSandbox: () => sandbox });
    const run = deps.runOpenshell ?? runDashboardForwardStopBestEffort;
    const result = run(["forward", "stop", String(port), sandboxName, "--gateway", gatewayName], {
      ignoreError: true,
      stdio: "ignore",
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (result.status !== 0) return;
    confirmDashboardForwardReleased(port, deps.isLocalForwardReachable ?? isLocalForwardReachable);
  } catch {
    // Defense in depth for injected or future runners: teardown is best-effort.
  }
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the recorded dashboard port when available, including custom ports for
 * non-OpenClaw agents, then falls back to the active agent's declared port.
 * Returns true when `forward start` succeeded and a follow-up probe
 * confirms the new entry is running, false otherwise.
 */
export function ensureSandboxPortForward(
  sandboxName: string,
  options: SandboxForwardRecoveryOptions = {},
): boolean {
  const port = resolveSandboxDashboardPort(sandboxName);
  const remoteBindRequested = isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND);
  const allInterfaceBindRequired = remoteBindRequested || isWsl({ isWsl: options.isWsl });
  if (
    remoteBindRequested &&
    registry.getSandbox(sandboxName)?.dashboardRemoteBindPrepared !== true
  ) {
    console.error(
      `  Refusing remote dashboard bind for '${sandboxName}': its generated configuration was not prepared for remote exposure. Re-run onboarding with NEMOCLAW_DASHBOARD_BIND=0.0.0.0 and --recreate-sandbox before reconnecting.`,
    );
    return false;
  }
  return ensureSandboxPortForwardForPort(sandboxName, port, {
    forwardTarget: allInterfaceBindRequired ? `0.0.0.0:${port}` : String(port),
    forceRestart: remoteBindRequested,
    expectedBind: allInterfaceBindRequired ? "0.0.0.0" : "127.0.0.1",
    afterSuccess: options.afterSuccess,
    beforeStart: () =>
      (!remoteBindRequested ||
        registry.getSandbox(sandboxName)?.dashboardRemoteBindPrepared === true) &&
      (options.beforeStart?.() ?? true),
  });
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
export function isSandboxForwardHealthy(
  sandboxName: string,
  options: { isWsl?: boolean } = {},
): SandboxForwardHealth {
  const allInterfaceBindRequired =
    isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND) ||
    isWsl({ isWsl: options.isWsl });
  return isSandboxPortForwardHealthy(
    sandboxName,
    resolveSandboxDashboardPort(sandboxName),
    allInterfaceBindRequired ? "0.0.0.0" : "127.0.0.1",
  );
}

export function isSandboxPortForwardHealthy(
  sandboxName: string,
  port: number,
  expectedBind?: string,
): SandboxForwardHealth {
  const result = captureOpenshell(["forward", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (!result || isCommandTimeout(result) || result.status !== 0) return null;
  const entries = parseForwardList(result.output) as SandboxForwardListEntry[];
  return classifyForwardHealthWithReachability(
    entries,
    sandboxName,
    String(port),
    () => isLocalForwardReachable(port),
    expectedBind,
  );
}

export function ensureSandboxPortForwardForPort(
  sandboxName: string,
  port: number,
  options: {
    afterSuccess?: () => boolean;
    forwardTarget?: string;
    forceRestart?: boolean;
    expectedBind?: string;
    beforeStart?: () => boolean;
  } = {},
): boolean {
  const {
    afterSuccess = () => true,
    forwardTarget = String(port),
    forceRestart = false,
    expectedBind,
    beforeStart = () => true,
  } = options;
  const acceptSuccessfulForward = () => {
    let accepted = false;
    try {
      accepted = afterSuccess();
    } catch {
      accepted = false;
    }
    if (accepted) return true;
    runOpenshell(["forward", "stop", String(port), sandboxName], {
      ignoreError: true,
      stdio: "ignore",
    });
    return false;
  };
  let forwardHealth = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
  if (forwardHealth === true && !forceRestart) return acceptSuccessfulForward();
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

  // OpenShell v0.0.85 removes the forward PID file shortly after SIGTERM,
  // before the old SSH listener is guaranteed to release its host port. A
  // blind stop -> start can therefore collide with the just-stopped process.
  // Preserve authoritative owner metadata while waiting: accept a target-
  // owned forward that recovered on its own, reject another sandbox, and
  // prefer starting only after an otherwise-unowned local listener has
  // quiesced. If an authoritative list remains ownerless while the listener
  // stays reachable, `forward start` is still the reconciliation operation:
  // its result is accepted below only after the list reports the exact target
  // owner. An unavailable list and forced bind replacement remain fail-closed.
  // NemoClaw must compensate while the supported OpenShell 0.0.85
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
    waitUntil(
      () => {
        stopState.health = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
        stopState.portReleased = !isLocalForwardReachable(port);
        return (
          (!forceRestart && stopState.health === true) ||
          stopState.health === "occupied" ||
          stopState.portReleased
        );
      },
      {
        deadlineMs: Date.now() + waitMs,
        initialIntervalMs: 100,
        maxIntervalMs: 500,
        backoffFactor: 1.5,
      },
    );
    if (stopState.health === true && !forceRestart) return acceptSuccessfulForward();
    if (stopState.health === "occupied") return false;
    if (!stopState.portReleased && (forceRestart || stopState.health === null)) {
      return false;
    }
  }

  if (!beforeStart()) return false;
  const startResult = runOpenshell(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    {
      ignoreError: true,
      // OpenShell 0.0.85 leaves the background SSH forward attached to the
      // caller's inherited descriptors. Detach them so a scripted `recover`
      // can finish after the foreground OpenShell command exits. Keep this
      // until every supported OpenShell release redirects those descriptors.
      stdio: "ignore",
    },
  );
  // OpenShell 0.0.85 returns an error when start preflight finds a validated
  // live forward for the requested port. Recovery cannot change that upstream
  // CLI contract, so a reachable listener settles against the authoritative
  // forward list below; an absent listener still fails fast. Remove this
  // tolerance once every supported OpenShell release makes `forward start`
  // idempotent for an already-tracked live forward.
  if (startResult.status !== 0 && !isLocalForwardReachable(port)) return false;

  // `forward start --background` can return before its authoritative list
  // entry becomes visible. Poll for the exact live sandbox+port owner instead
  // of accepting an arbitrary reachable listener or failing on the first
  // metadata refresh.
  let health = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
  if (health === true) return acceptSuccessfulForward();
  if (health === "occupied") return false;
  if (waitMs === 0) return false;

  let occupied = false;
  const settled = waitUntil(
    () => {
      health = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
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
  return settled && !occupied && acceptSuccessfulForward();
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
