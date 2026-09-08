// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  launchForwardService,
  type ForwardServiceTarget,
} from "../../adapters/openshell/forward-service";
import { isLegacySandboxForwardListed } from "../../adapters/openshell/forward-service-migration";
import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { DASHBOARD_PORT, HERMES_OPENAI_API_PORT } from "../../core/ports";
import { getActiveMessagingHostForward } from "../../messaging/host-forward";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/hydration";
import type { SandboxMessagingHostForwardPlan } from "../../messaging/manifest";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { isRemoteDashboardBindRequested } from "../../onboard/dockerfile-remote-dashboard-bind-contract";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { retireProductionLegacySandboxForwards } from "../../onboard/forward-service-migration";
import {
  resolveSandboxHermesApiPort,
  retargetHermesApiPortInUrl,
} from "../../onboard/hermes-api-port";
import { isWsl } from "../../platform";
import * as registry from "../../state/registry";
import { isLocalForwardReachable, type SandboxForwardHealth } from "./forward-health";
import {
  ensureHermesDashboardPortForwardIfEnabled as ensureHermesDashboardPortForward,
  getHermesDashboardRecoveryConfig,
} from "./hermes-dashboard-recovery";
import type {
  HermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryTimingEvidence,
} from "./probe/hermes-portable-forward-recovery";
export {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
} from "./probe/hermes-portable-forward-recovery";
export type {
  HermesPortableForwardRecoveryFailure,
  HermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryResult,
  HermesPortableForwardRecoveryTiming,
  HermesPortableForwardRecoveryTimingEvidence,
  HermesPortableForwardVerificationResult,
  PreparedHermesPortableForwardRecovery,
} from "./probe/hermes-portable-forward-recovery";

export interface HermesPortableForwardCommandAuthority {
  readonly env: NodeJS.ProcessEnv;
  readonly executablePath: string;
}

/** Compose exact Hermes command authority with the direct ForwardTcp owner. */
export function createHermesPortableForwardRecoveryInput(input: {
  readonly assertCurrent: () => void;
  readonly assertRollbackCurrent: () => void;
  readonly commandAuthority: HermesPortableForwardCommandAuthority;
  readonly gatewayName: string;
  readonly intent: "connect-probe-only";
  readonly onTiming: (evidence: HermesPortableForwardRecoveryTimingEvidence) => void;
  readonly ports: readonly number[];
  readonly sandboxName: string;
}): HermesPortableForwardRecoveryInput {
  return {
    intent: input.intent,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    operationTimeoutMs: 30_000,
    ports: input.ports,
    probeTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    timing: { onComplete: input.onTiming },
    deps: {
      assertCurrent: input.assertCurrent,
      assertRollbackCurrent: input.assertRollbackCurrent,
      isReachable: isLocalForwardReachable,
      launch: (port) =>
        launchForwardService(
          forwardServiceTarget(
            input.commandAuthority.executablePath,
            input.gatewayName,
            input.sandboxName,
            port,
            "127.0.0.1",
          ),
          { sourceEnvironment: input.commandAuthority.env },
        ),
      migrateLegacy: (ports) =>
        retireProductionLegacySandboxForwards(input.sandboxName, input.gatewayName, ports, {
          capture: (gatewayName) =>
            captureOpenshell(["forward", "list", "--gateway", gatewayName], {
              env: input.commandAuthority.env,
              openshellBinary: input.commandAuthority.executablePath,
              replaceEnv: true,
              ignoreError: true,
              includeStreams: true,
              timeout: OPENSHELL_PROBE_TIMEOUT_MS,
            }),
          isReachable: isLocalForwardReachable,
          run: (gatewayName, sandboxName, port) =>
            runOpenshell(["forward", "stop", String(port), sandboxName, "--gateway", gatewayName], {
              env: input.commandAuthority.env,
              openshellBinary: input.commandAuthority.executablePath,
              replaceEnv: true,
              ignoreError: true,
              stdio: "ignore",
              timeout: 30_000,
            }),
        }),
    },
  };
}

type SandboxPortAgent = {
  forwardPort?: unknown;
  forward_ports?: unknown;
  runtime?: { kind?: unknown };
} | null;

type SandboxPortDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: (sandboxName?: string) => SandboxPortAgent;
};

type SandboxForwardRecoveryOptions = {
  afterSuccess?: () => boolean;
  beforeStart?: () => boolean;
  isWsl?: boolean;
};

function retireLegacyForwardServiceMigration(
  sandboxName: string,
  gatewayName: string,
  ports: readonly number[],
): number {
  return retireProductionLegacySandboxForwards(sandboxName, gatewayName, ports, {
    capture: (gatewayName) =>
      captureOpenshell(["forward", "list", "--gateway", gatewayName], {
        ignoreError: true,
        includeStreams: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      }),
    isReachable: isLocalForwardReachable,
    run: (gatewayName, sandboxName, port) =>
      runOpenshell(["forward", "stop", String(port), sandboxName, "--gateway", gatewayName], {
        ignoreError: true,
        stdio: "ignore",
        timeout: 30_000,
      }),
  });
}

function forwardServiceTarget(
  executable: string,
  gatewayName: string,
  sandboxName: string,
  port: number,
  expectedBind = "127.0.0.1",
): ForwardServiceTarget {
  return {
    executable,
    gatewayName,
    workspace: "default",
    sandboxName,
    localHost: expectedBind === "0.0.0.0" ? ("0.0.0.0" as const) : ("127.0.0.1" as const),
    localPort: port,
    targetHost: "127.0.0.1",
    targetPort: port,
  };
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
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
 * Resolve the health endpoint to probe inside the sandbox.
 *
 * Manifest probe URLs name the agent's default API port. Retarget them at this
 * sandbox's own port so the probe reaches its relay rather than reporting the
 * default port as unreachable.
 */
export function resolveSandboxHealthProbeUrl(sandboxName: string): string {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (agent && agentRuntime.hasGatewayRuntime(agent)) {
    return retargetHermesApiPortInUrl(
      agentRuntime.getHealthProbeUrl(agent),
      resolveSandboxHermesApiPort(registry.getSandbox(sandboxName) ?? {}),
    );
  }
  return `http://127.0.0.1:${resolveSandboxDashboardPort(sandboxName)}/health`;
}

/**
 * Wait for OpenShell's direct forwards to exit after the sandbox becomes unavailable.
 */
export function teardownSandboxDashboardForward(
  sandboxName: string,
  deps: {
    getSandbox?: typeof registry.getSandbox;
    isLocalForwardReachable?: typeof isLocalForwardReachable;
    resolveSandboxDashboardPort?: typeof resolveSandboxDashboardPort;
    sleep?: (milliseconds: number) => void;
  } = {},
): boolean {
  try {
    const getSandbox = deps.getSandbox ?? registry.getSandbox;
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return true;
    const registeredAgent = sandbox.agent ? agentRuntime.getRegisteredAgent(sandbox) : null;
    if (registeredAgent && !agentRuntime.hasGatewayRuntime(registeredAgent)) return true;
    const resolvePort = deps.resolveSandboxDashboardPort ?? resolveSandboxDashboardPort;
    const primaryPort = resolvePort(sandboxName, { getSandbox: () => sandbox });
    const hermesDashboardPort =
      sandbox.hermesDashboardEnabled === true && isValidPort(sandbox.hermesDashboardPort)
        ? sandbox.hermesDashboardPort
        : null;
    const ports = new Set<number>([primaryPort]);
    if (hermesDashboardPort !== null) ports.add(hermesDashboardPort);
    const parsedMessaging = parseSandboxMessagingPlan(sandbox.messaging?.plan, { sandboxName });
    const messagingForward = getActiveMessagingHostForward(
      parsedMessaging ? hydrateDerivedSandboxMessagingPlanFields(parsedMessaging) : null,
    );
    if (messagingForward) ports.add(messagingForward.port);
    for (const port of resolveDeclaredAgentForwardPorts(
      sandbox,
      primaryPort,
      registeredAgent,
      hermesDashboardPort,
    )) {
      ports.add(port);
    }
    const isReachable = deps.isLocalForwardReachable ?? isLocalForwardReachable;
    const sleep =
      deps.sleep ??
      ((milliseconds: number) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));
    const deadline = Date.now() + 5_000;
    let unreleasedPorts = [...ports].filter((port) => isReachable(port));
    while (unreleasedPorts.length > 0 && Date.now() < deadline) {
      sleep(100);
      unreleasedPorts = unreleasedPorts.filter((port) => isReachable(port));
    }
    if (unreleasedPorts.length > 0) {
      console.error(
        `  ForwardTcp cleanup did not release registered host port(s): ${unreleasedPorts.join(", ")}.`,
      );
    }
    return unreleasedPorts.length === 0;
  } catch (error) {
    console.error(
      `  ForwardTcp port-release verification did not complete: ${
        error instanceof Error ? error.message : "unknown verification failure"
      }`,
    );
    return false;
  }
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the recorded dashboard port when available, including custom ports for
 * non-OpenClaw agents, then falls back to the active agent's declared port.
 * Returns true when the detached OpenShell service makes the port reachable.
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
    expectedBind: allInterfaceBindRequired ? "0.0.0.0" : "127.0.0.1",
    recordDashboardBind: true,
    afterSuccess: options.afterSuccess,
    beforeStart: () =>
      (!remoteBindRequested ||
        registry.getSandbox(sandboxName)?.dashboardRemoteBindPrepared === true) &&
      (options.beforeStart?.() ?? true),
  });
}

/** Probe local reachability for a registered sandbox port without claiming process ownership. */
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
  _expectedBind?: string,
): SandboxForwardHealth {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return false;
  if (!isLocalForwardReachable(port)) return false;
  const gatewayName = resolveSandboxGatewayName(sandbox);
  const listed = captureOpenshell(["forward", "list", "--gateway", gatewayName], {
    ignoreError: true,
    includeStreams: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (
    !listed.error &&
    !listed.signal &&
    listed.status === 0 &&
    isLegacySandboxForwardListed(listed.output, sandboxName, port)
  ) {
    return false;
  }
  return true;
}

/**
 * Persist the bind a dashboard forward is about to be started with. Warns and
 * returns false when the write fails; the caller decides whether the forward
 * may start without its record.
 */
function recordDashboardBindAddress(
  sandboxName: string,
  port: number,
  bindAddress: string,
): boolean {
  try {
    if (registry.updateSandbox(sandboxName, { dashboardBindAddress: bindAddress })) return true;
    console.error(
      `  Warning: the dashboard forward for port ${String(port)} binds ${bindAddress}, but that could not be recorded for '${sandboxName}'; \`dashboard-url\` may report a stale address until the next onboard.`,
    );
  } catch (error) {
    console.error(
      `  Warning: the dashboard forward for port ${String(port)} binds ${bindAddress}, but recording it for '${sandboxName}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return false;
}

/** Explain a refused dashboard forward whose record would misdescribe it. */
function dashboardBindRefusal(
  sandboxName: string,
  bindAddress: string,
  previousBind: string | null,
): string {
  const where = bindAddress === "0.0.0.0" ? "all interfaces" : "loopback";
  const why =
    bindAddress === "0.0.0.0"
      ? "its exposure could not be recorded, so `dashboard-url` and `status` would not disclose it"
      : `the registry still records a bind on ${String(previousBind)} and could not be updated, so \`dashboard-url\` and \`status\` would report exposure that no longer exists and omit the SSH forward guidance`;
  return `  Refusing to start the dashboard forward for '${sandboxName}' on ${where}: ${why}. Repair the sandbox registry and reconnect.`;
}

/** Put back the record of the last forward that did start, after a launch failed. */
function restoreDashboardBindAddress(sandboxName: string, previousBind: string | null): void {
  let restored = false;
  try {
    restored = registry.updateSandbox(sandboxName, { dashboardBindAddress: previousBind });
  } catch {
    restored = false;
  }
  if (restored) return;
  console.error(
    `  Warning: the recorded dashboard bind for '${sandboxName}' could not be restored after the forward failed to start; \`dashboard-url\` may report a listener that does not exist until the next forward launch.`,
  );
}

export function ensureSandboxPortForwardForPort(
  sandboxName: string,
  port: number,
  options: {
    afterSuccess?: () => boolean;
    forwardTarget?: string;
    expectedBind?: string;
    beforeStart?: () => boolean;
    /**
     * Record the bind this call establishes as the sandbox's dashboard bind.
     * Only the dashboard caller sets this; messaging and declared-port
     * forwards share this function and must not overwrite that field.
     */
    recordDashboardBind?: boolean;
  } = {},
): boolean {
  const {
    afterSuccess = () => true,
    forwardTarget = String(port),
    expectedBind,
    beforeStart = () => true,
    recordDashboardBind = false,
  } = options;
  const bindAddress =
    expectedBind ?? (forwardTarget.startsWith("0.0.0.0:") ? "0.0.0.0" : "127.0.0.1");
  const acceptSuccessfulForward = () => {
    let accepted = false;
    try {
      accepted = afterSuccess();
    } catch {
      accepted = false;
    }
    return accepted;
  };
  const forwardHealth = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
  if (forwardHealth === true) return acceptSuccessfulForward();
  if (!beforeStart()) return false;
  let previousBind: string | null = null;
  let recordedBind = false;
  try {
    const sandbox = registry.getSandbox(sandboxName);
    if (!sandbox) throw new Error(`Sandbox '${sandboxName}' is not registered`);
    previousBind = sandbox.dashboardBindAddress ?? null;
    // The record follows the forward, not the sandbox. Onboarding writes it
    // when it starts the first forward; every later re-creation — restart,
    // connect, gateway recovery — decides the bind again from the current
    // environment, and a record left from onboarding would report the bind
    // that used to be true (#10861). Only a launch writes: on the healthy
    // path above nothing was created, and the listener may not be ours.
    // It is written before the launch, and a forward starts only when the
    // record will describe it: a wide forward never exists undisclosed, and
    // a loopback forward never hides behind a stale wide record that would
    // withhold the SSH forward guidance. A loopback forward for a row whose
    // record is loopback or absent may still start when the write fails,
    // because nothing an operator reads would change.
    if (recordDashboardBind) {
      recordedBind = recordDashboardBindAddress(sandboxName, port, bindAddress);
      if (!recordedBind && (bindAddress === "0.0.0.0" || previousBind === "0.0.0.0")) {
        console.error(dashboardBindRefusal(sandboxName, bindAddress, previousBind));
        return false;
      }
    }
    const gatewayName = resolveSandboxGatewayName(sandbox);
    retireLegacyForwardServiceMigration(sandboxName, gatewayName, [port]);
    const executable = resolveOpenshell();
    if (!executable) throw new Error("OpenShell is unavailable");
    launchForwardService(
      forwardServiceTarget(executable, gatewayName, sandboxName, port, bindAddress),
    );
    return acceptSuccessfulForward();
  } catch (error) {
    console.error(
      `  Warning: OpenShell ForwardTcp ${String(port)} for ${sandboxName} did not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // The record described a forward that never came up; put back the one
    // for the last forward that did, so no command reports a listener that
    // does not exist.
    if (recordedBind) restoreDashboardBindAddress(sandboxName, previousBind);
    return false;
  }
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

function resolveDeclaredAgentForwardPorts(
  sandbox: ReturnType<typeof registry.getSandbox>,
  primaryPort: number,
  agent: SandboxPortAgent,
  hermesDashboardPort: number | null,
): number[] {
  const declared = agent?.forward_ports;
  if (!Array.isArray(declared)) return [];
  const covered = new Set<number>([primaryPort]);
  if (isValidPort(agent?.forwardPort)) covered.add(agent.forwardPort);
  if (isValidPort(hermesDashboardPort)) covered.add(hermesDashboardPort);
  const ports: number[] = [];
  for (const candidate of declared) {
    if (typeof candidate !== "number") continue;
    if (!Number.isInteger(candidate) || candidate < 1024 || candidate > 65535) continue;
    if (covered.has(candidate)) continue;
    const port =
      candidate === HERMES_OPENAI_API_PORT ? resolveSandboxHermesApiPort(sandbox ?? {}) : candidate;
    if (covered.has(port)) continue;
    covered.add(port);
    ports.push(port);
  }
  return ports;
}

/**
 * Re-establish every declared `forward_ports` entry on the active agent
 * manifest that is not already owned by another recovery helper. The
 * primary dashboard port is owned by `ensureSandboxPortForward`; the
 * optional Hermes web dashboard port is owned by
 * `ensureHermesDashboardPortForwardIfEnabled`.
 *
 * Manifest entries name the agent's default ports, not this sandbox's. Both
 * the dashboard port and the Hermes API port are per-sandbox host resources, so
 * a second sandbox owns neither manifest default. Skip the manifest dashboard
 * entry, which `ensureSandboxPortForward` already recovers at this sandbox's
 * dashboard port, and resolve the manifest API entry against the sandbox's
 * recorded API port, or recovery demands a port that belongs to a sibling
 * sandbox and reports a failure the sandbox cannot repair.
 */
export function ensureDeclaredAgentForwardPortsHealthy(
  sandboxName: string,
  primaryPort: number,
): boolean | null {
  const agent = agentRuntime.getSessionAgent(sandboxName);
  if (!agent) return null;
  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName);
  const sandbox = registry.getSandbox(sandboxName);
  const ports = resolveDeclaredAgentForwardPorts(
    sandbox,
    primaryPort,
    agent,
    hermesDashboard?.publicPort ?? null,
  );
  if (ports.length === 0) return null;
  let allHealthy = true;
  for (const port of ports) {
    const health = isSandboxPortForwardHealthy(sandboxName, port);
    if (health === true) continue;
    if (!ensureSandboxPortForwardForPort(sandboxName, port)) {
      allHealthy = false;
    }
  }
  return allHealthy;
}

/**
 * Observe every host forward that the interactive preflight would recover,
 * without starting, stopping, or rebinding one.
 */
export function areSandboxLaunchForwardsHealthy(
  sandboxName: string,
  gatewayName?: string,
  _capture?: unknown,
): boolean | null {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return false;
  const owningGatewayName = resolveSandboxGatewayName(sandbox);
  if (gatewayName && gatewayName !== owningGatewayName) return false;
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const requiredPorts = resolveSandboxLaunchForwardPortsFromAuthority(sandboxName, sandbox, agent);
  if (requiredPorts.length === 0) return true;
  try {
    return requiredPorts.every((port) => isLocalForwardReachable(port));
  } catch {
    return null;
  }
}

function resolveSandboxLaunchForwardPortsFromAuthority(
  sandboxName: string,
  sandbox: NonNullable<ReturnType<typeof registry.getSandbox>>,
  agent: SandboxPortAgent,
): number[] {
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return [];

  const primaryPort = resolveSandboxDashboardPort(sandboxName);
  const requiredPorts = new Set<number>([primaryPort]);
  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName);
  if (hermesDashboard) requiredPorts.add(hermesDashboard.publicPort);
  const messagingForward = getSandboxMessagingHostForward(sandboxName);
  if (messagingForward) requiredPorts.add(messagingForward.port);
  for (const port of resolveDeclaredAgentForwardPorts(
    sandbox,
    primaryPort,
    agent,
    hermesDashboard?.publicPort ?? null,
  )) {
    requiredPorts.add(port);
  }
  return [...requiredPorts];
}

/** Resolve the complete forward set used by launch-readiness health. */
export function resolveSandboxLaunchForwardPorts(sandboxName: string): number[] | null {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return null;
  return resolveSandboxLaunchForwardPortsFromAuthority(
    sandboxName,
    sandbox,
    agentRuntime.getSessionAgent(sandboxName),
  );
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
