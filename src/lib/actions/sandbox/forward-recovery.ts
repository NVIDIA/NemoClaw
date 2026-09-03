// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  buildSelectedOpenShellSubprocessEnv,
  withSelectedOpenShellCommandOptions,
} from "../../adapters/openshell/command-argv";
import {
  launchForwardService,
  type ForwardServiceTarget,
} from "../../adapters/openshell/forward-service";
import { isLegacySandboxForwardListed } from "../../adapters/openshell/forward-service-migration";
import {
  captureOpenshell,
  type OpenShellRuntimeSelection,
  runOpenshell,
} from "../../adapters/openshell/runtime";
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
  runtimeSelection?: OpenShellRuntimeSelection;
};

function retireLegacyForwardServiceMigration(
  sandboxName: string,
  gatewayName: string,
  ports: readonly number[],
  runtimeSelection?: OpenShellRuntimeSelection,
): number {
  return retireProductionLegacySandboxForwards(sandboxName, gatewayName, ports, {
    capture: (gatewayName) =>
      captureOpenshell(
        ["forward", "list", "--gateway", gatewayName],
        withSelectedOpenShellCommandOptions(
          {
            ignoreError: true,
            includeStreams: true,
            timeout: OPENSHELL_PROBE_TIMEOUT_MS,
          },
          runtimeSelection,
        ),
      ),
    isReachable: isLocalForwardReachable,
    run: (gatewayName, sandboxName, port) =>
      runOpenshell(
        ["forward", "stop", String(port), sandboxName, "--gateway", gatewayName],
        withSelectedOpenShellCommandOptions(
          {
            ignoreError: true,
            stdio: "ignore",
            timeout: 30_000,
          },
          runtimeSelection,
        ),
      ),
  });
}

function forwardServiceTarget(
  executable: string,
  gatewayName: string,
  sandboxName: string,
  port: number,
  expectedBind = "127.0.0.1",
  workspace = "default",
): ForwardServiceTarget {
  return {
    executable,
    gatewayName,
    workspace,
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
    afterSuccess: options.afterSuccess,
    beforeStart: () =>
      (!remoteBindRequested ||
        registry.getSandbox(sandboxName)?.dashboardRemoteBindPrepared === true) &&
      (options.beforeStart?.() ?? true),
    runtimeSelection: options.runtimeSelection,
  });
}

/** Probe local reachability for a registered sandbox port without claiming process ownership. */
export function isSandboxForwardHealthy(
  sandboxName: string,
  options: { isWsl?: boolean; runtimeSelection?: OpenShellRuntimeSelection } = {},
): SandboxForwardHealth {
  const allInterfaceBindRequired =
    isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND) ||
    isWsl({ isWsl: options.isWsl });
  return isSandboxPortForwardHealthy(
    sandboxName,
    resolveSandboxDashboardPort(sandboxName),
    allInterfaceBindRequired ? "0.0.0.0" : "127.0.0.1",
    options.runtimeSelection,
  );
}

export function isSandboxPortForwardHealthy(
  sandboxName: string,
  port: number,
  _expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxForwardHealth {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return false;
  if (!isLocalForwardReachable(port)) return false;
  const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
  const listed = captureOpenshell(
    ["forward", "list", "--gateway", gatewayName],
    withSelectedOpenShellCommandOptions(
      {
        ignoreError: true,
        includeStreams: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      },
      runtimeSelection,
    ),
  );
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

export function ensureSandboxPortForwardForPort(
  sandboxName: string,
  port: number,
  options: {
    afterSuccess?: () => boolean;
    forwardTarget?: string;
    expectedBind?: string;
    beforeStart?: () => boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): boolean {
  const {
    afterSuccess = () => true,
    forwardTarget = String(port),
    expectedBind,
    beforeStart = () => true,
    runtimeSelection,
  } = options;
  const acceptSuccessfulForward = () => {
    let accepted = false;
    try {
      accepted = afterSuccess();
    } catch {
      accepted = false;
    }
    return accepted;
  };
  const forwardHealth = isSandboxPortForwardHealthy(
    sandboxName,
    port,
    expectedBind,
    runtimeSelection,
  );
  if (forwardHealth === true) return acceptSuccessfulForward();
  if (!beforeStart()) return false;
  try {
    const sandbox = registry.getSandbox(sandboxName);
    if (!sandbox) throw new Error(`Sandbox '${sandboxName}' is not registered`);
    const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
    retireLegacyForwardServiceMigration(sandboxName, gatewayName, [port], runtimeSelection);
    const executable = resolveOpenshell();
    if (!executable) throw new Error("OpenShell is unavailable");
    launchForwardService(
      forwardServiceTarget(
        executable,
        gatewayName,
        sandboxName,
        port,
        expectedBind ?? (forwardTarget.startsWith("0.0.0.0:") ? "0.0.0.0" : "127.0.0.1"),
        runtimeSelection?.workspace ?? "default",
      ),
      runtimeSelection
        ? { sourceEnvironment: buildSelectedOpenShellSubprocessEnv(runtimeSelection) }
        : {},
    );
    return acceptSuccessfulForward();
  } catch (error) {
    console.error(
      `  Warning: OpenShell ForwardTcp ${String(port)} for ${sandboxName} did not start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export function ensureHermesDashboardPortForwardIfEnabled(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): boolean | null {
  return ensureHermesDashboardPortForward(sandboxName, {
    isPortForwardHealthy: (name, port) =>
      isSandboxPortForwardHealthy(name, port, undefined, runtimeSelection),
    ensurePortForward: (name, port) =>
      ensureSandboxPortForwardForPort(name, port, { runtimeSelection }),
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

export function ensureMessagingHostForwardHealthy(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): boolean | null {
  const forward = getSandboxMessagingHostForward(sandboxName);
  if (!forward) return null;
  const health = isSandboxPortForwardHealthy(sandboxName, forward.port, undefined, runtimeSelection);
  if (health === true) return true;
  return ensureSandboxPortForwardForPort(sandboxName, forward.port, { runtimeSelection });
}

export function recoverMessagingHostForward(
  sandboxName: string,
  {
    quiet,
    runtimeSelection,
  }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
): boolean | null {
  const recovered = ensureMessagingHostForwardHealthy(sandboxName, runtimeSelection);
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
  runtimeSelection?: OpenShellRuntimeSelection,
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
    const health = isSandboxPortForwardHealthy(sandboxName, port, undefined, runtimeSelection);
    if (health === true) continue;
    if (!ensureSandboxPortForwardForPort(sandboxName, port, { runtimeSelection })) {
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
  {
    quiet,
    runtimeSelection,
  }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
): boolean | null {
  const recovered = ensureDeclaredAgentForwardPortsHealthy(
    sandboxName,
    recoveryPort,
    runtimeSelection,
  );
  if (!quiet && recovered === false) {
    console.error("  One or more agent-declared port forwards could not be re-established.");
  }
  return recovered;
}
