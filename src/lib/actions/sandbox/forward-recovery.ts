// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  createForwardServiceTarget,
  isForwardServiceListenerOwner,
  launchForwardService,
  type ForwardServiceTarget,
} from "../../adapters/openshell/forward-service";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  buildSelectedOpenShellSubprocessEnv,
  captureResolvedOpenshell,
  replaceOpenShellRuntimeSelectionEnv,
  type OpenShellRuntimeSelection,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { getGatewayHttpsEndpoint } from "../../core/gateway-address";
import { DASHBOARD_PORT, HERMES_OPENAI_API_PORT } from "../../core/ports";
import { getActiveMessagingHostForward } from "../../messaging/host-forward";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/hydration";
import type { SandboxMessagingHostForwardPlan } from "../../messaging/manifest";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { isRemoteDashboardBindRequested } from "../../onboard/dockerfile-remote-dashboard-bind-contract";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import { resolveGatewayForwardAuthority } from "../../onboard/gateway-teardown-authority";
import { sameGatewayOwner, type GatewayOwner } from "../../onboard/gateway-ownership";
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
import {
  HermesPortableForwardRecoveryError,
  type HermesPortableForwardRecoveryInput,
  type HermesPortableForwardRecoveryTimingEvidence,
} from "./probe/hermes-portable-forward-recovery";
export {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
} from "./probe/hermes-portable-forward-recovery";
export type {
  HermesPortableForwardRecoveryContext,
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
  let gatewayAuthority: ReturnType<typeof resolveForwardGatewayAuthority>;
  try {
    input.assertCurrent();
    gatewayAuthority = resolveForwardGatewayAuthority(input.gatewayName);
    input.assertCurrent();
  } catch {
    throw new HermesPortableForwardRecoveryError("authority-drift");
  }
  const assertGatewayAuthorityCurrent = (): void => {
    const current = resolveForwardGatewayAuthority(input.gatewayName);
    if (!sameForwardGatewayAuthority(current, gatewayAuthority)) {
      throw new Error("OpenShell forward service gateway authority changed");
    }
  };
  const assertCurrent = (): void => {
    input.assertCurrent();
    assertGatewayAuthorityCurrent();
  };
  const assertRollbackCurrent = (): void => {
    input.assertRollbackCurrent();
    assertGatewayAuthorityCurrent();
  };
  const sourceEnvironment = { ...input.commandAuthority.env };
  replaceOpenShellRuntimeSelectionEnv(sourceEnvironment, {
    gatewayName: input.gatewayName,
    workspace: "default",
    ...(gatewayAuthority.localTlsDir ? { localTlsDir: gatewayAuthority.localTlsDir } : {}),
  });
  return {
    intent: input.intent,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    operationTimeoutMs: 30_000,
    ports: input.ports,
    probeTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    forwardService: {
      executablePath: input.commandAuthority.executablePath,
      gatewayEndpoint: gatewayAuthority.endpoint,
      sourceEnvironment,
      workspace: "default",
    },
    timing: { onComplete: input.onTiming },
    deps: {
      assertCurrent,
      assertRollbackCurrent,
      captureCurrentList: (args, timeout) =>
        captureResolvedOpenshell([...args], {
          env: sourceEnvironment,
          openshellBinary: input.commandAuthority.executablePath,
          replaceEnv: true,
          ignoreError: true,
          includeStreams: true,
          timeout,
        }),
      captureRollbackList: (args, timeout) =>
        captureResolvedOpenshell([...args], {
          env: sourceEnvironment,
          openshellBinary: input.commandAuthority.executablePath,
          replaceEnv: true,
          ignoreError: true,
          includeStreams: true,
          timeout,
        }),
      runCurrentMutation: (args, timeout) =>
        runOpenshell([...args], {
          env: sourceEnvironment,
          openshellBinary: input.commandAuthority.executablePath,
          replaceEnv: true,
          ignoreError: true,
          stdio: "ignore",
          timeout,
        }),
      isForwardServiceOwner: (target) => isForwardServiceListenerOwner(target),
      launchForwardService: (target, options) => launchForwardService(target, options),
      isPortReachable: isLocalForwardReachable,
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

function selectedForwardRuntime(
  gatewayName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  authorityLocalTlsDir?: string,
): OpenShellRuntimeSelection {
  if (
    runtimeSelection?.localTlsDir &&
    authorityLocalTlsDir &&
    runtimeSelection.localTlsDir !== authorityLocalTlsDir
  ) {
    throw new Error("OpenShell forward service TLS selection disagrees with gateway authority");
  }
  const localTlsDir = authorityLocalTlsDir ?? runtimeSelection?.localTlsDir;
  return {
    gatewayName,
    workspace: runtimeSelection?.workspace ?? "default",
    ...(localTlsDir ? { localTlsDir } : {}),
  };
}

type ForwardGatewayAuthority = {
  readonly endpoint: string;
  readonly localTlsDir?: string;
  readonly owner: GatewayOwner;
};

function resolveForwardGatewayAuthority(gatewayName: string): ForwardGatewayAuthority {
  const gatewayPort = resolveGatewayPortFromName(gatewayName);
  if (gatewayPort === null) {
    throw new Error(`Invalid OpenShell forward gateway '${gatewayName}'`);
  }
  const owner = resolveGatewayForwardAuthority({ gatewayName, gatewayPort });
  const externalTlsDir =
    owner.endpoint && new URL(owner.endpoint).protocol === "https:" && owner.stateDir
      ? path.join(owner.stateDir, "tls")
      : undefined;
  return {
    endpoint: owner.endpoint ?? new URL(getGatewayHttpsEndpoint(gatewayPort)).origin,
    ...(externalTlsDir ? { localTlsDir: externalTlsDir } : {}),
    owner,
  };
}

function sameForwardGatewayAuthority(
  first: ForwardGatewayAuthority,
  second: ForwardGatewayAuthority,
): boolean {
  return (
    first.endpoint === second.endpoint &&
    first.localTlsDir === second.localTlsDir &&
    sameGatewayOwner(first.owner, second.owner)
  );
}

function assertForwardGatewayAuthorityCurrent(
  gatewayName: string,
  expected: ForwardGatewayAuthority,
): void {
  if (!sameForwardGatewayAuthority(resolveForwardGatewayAuthority(gatewayName), expected)) {
    throw new Error("OpenShell forward service gateway authority changed during launch");
  }
}

function assertSandboxForwardAuthorityCurrent(
  sandboxName: string,
  gatewayName: string,
  expected: ForwardGatewayAuthority,
): void {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox || resolveSandboxGatewayName(sandbox) !== gatewayName) {
    throw new Error("Sandbox gateway changed during forward observation");
  }
  assertForwardGatewayAuthorityCurrent(gatewayName, expected);
}

function forwardServiceTarget(
  executable: string,
  gatewayName: string,
  sandboxName: string,
  port: number,
  expectedBind = "127.0.0.1",
  workspace = "default",
  gatewayEndpoint?: string,
): ForwardServiceTarget {
  return createForwardServiceTarget(
    {
      executable,
      gatewayName,
      ...(gatewayEndpoint ? { gatewayEndpoint } : {}),
      workspace,
      sandboxName,
      localHost: expectedBind === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
    },
    port,
  );
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

/**
 * What answers on a sandbox's host forward port.
 *
 * - `owned`: this sandbox's exact OpenShell ForwardTcp service, proved from
 *   the listener PID, its executable and its full argv.
 * - `absent`: nothing listens.
 * - `unverified`: something listens that NemoClaw cannot attribute to this
 *   sandbox's forward. Recovery never relaunches onto it: the listener is
 *   left running and reported, because a forward that did start there would
 *   hand the dashboard URL and its token to whatever answers (#11149).
 */
export type SandboxForwardListener = "owned" | "absent" | "unverified";

export function describeSandboxForwardListener(
  sandboxName: string,
  options: { isWsl?: boolean; runtimeSelection?: OpenShellRuntimeSelection } = {},
): SandboxForwardListener {
  const allInterfaceBindRequired =
    isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND) ||
    isWsl({ isWsl: options.isWsl });
  return describeSandboxPortForwardListener(
    sandboxName,
    resolveSandboxDashboardPort(sandboxName),
    allInterfaceBindRequired ? "0.0.0.0" : "127.0.0.1",
    options.runtimeSelection,
  );
}

export function isSandboxForwardHealthy(
  sandboxName: string,
  options: { isWsl?: boolean; runtimeSelection?: OpenShellRuntimeSelection } = {},
): SandboxForwardHealth {
  return describeSandboxForwardListener(sandboxName, options) === "owned";
}

export function isSandboxPortForwardHealthy(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxForwardHealth {
  return (
    describeSandboxPortForwardListener(sandboxName, port, expectedBind, runtimeSelection) ===
    "owned"
  );
}

/** Why recovery leaves a listener it cannot attribute to the sandbox alone. */
export function unverifiedForwardListenerRefusal(sandboxName: string, port: number): string {
  return `  Host port ${String(port)} for '${sandboxName}' is held by a listener that NemoClaw cannot attribute to this sandbox's OpenShell forward. NemoClaw cannot prove it started the listener, so it leaves the listener running and does not restore a forward onto it. Find the owner with \`ss -ltnp 'sport = :${String(port)}'\` or \`lsof -nP -iTCP:${String(port)} -sTCP:LISTEN\`, free the port, then run \`nemoclaw ${sandboxName} recover\` again.`;
}

export function describeSandboxPortForwardListener(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxForwardListener {
  return inspectSandboxPortForwardListener(sandboxName, port, expectedBind, runtimeSelection);
}

function inspectSandboxPortForwardListener(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxForwardListener {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return "absent";
  if (!isLocalForwardReachable(port)) return "absent";
  try {
    const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
    const authority = resolveForwardGatewayAuthority(gatewayName);
    const proofRuntime = selectedForwardRuntime(
      gatewayName,
      runtimeSelection,
      authority.localTlsDir,
    );
    const executable = resolveOpenshell();
    if (!executable) return "unverified";
    const bindAddress = expectedBind ?? "127.0.0.1";
    const target = forwardServiceTarget(
      executable,
      gatewayName,
      sandboxName,
      port,
      bindAddress,
      proofRuntime.workspace,
      authority.endpoint,
    );
    if (!isForwardServiceListenerOwner(target)) return "unverified";
    return sameForwardGatewayAuthority(resolveForwardGatewayAuthority(gatewayName), authority)
      ? "owned"
      : "unverified";
  } catch {
    return "unverified";
  }
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
  let listener: SandboxForwardListener;
  try {
    listener = inspectSandboxPortForwardListener(sandboxName, port, expectedBind, runtimeSelection);
  } catch (error) {
    console.error(
      `  Warning: OpenShell ForwardTcp ${String(port)} for ${sandboxName} could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  if (listener === "owned") return acceptSuccessfulForward();
  // A listener this sandbox does not own is reported, never replaced. A
  // launch onto it would only fail as "occupied", and reporting the forward
  // as restored would send the dashboard token to that process (#11149).
  if (listener === "unverified") {
    console.error(unverifiedForwardListenerRefusal(sandboxName, port));
    return false;
  }
  if (!beforeStart()) return false;
  try {
    const sandbox = registry.getSandbox(sandboxName);
    if (!sandbox) throw new Error(`Sandbox '${sandboxName}' is not registered`);
    const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
    const authority = resolveForwardGatewayAuthority(gatewayName);
    const launchRuntime = selectedForwardRuntime(
      gatewayName,
      runtimeSelection,
      authority.localTlsDir,
    );
    const executable = resolveOpenshell();
    if (!executable) throw new Error("OpenShell is unavailable");
    const target = forwardServiceTarget(
      executable,
      gatewayName,
      sandboxName,
      port,
      expectedBind ?? (forwardTarget.startsWith("0.0.0.0:") ? "0.0.0.0" : "127.0.0.1"),
      launchRuntime.workspace,
      authority.endpoint,
    );
    launchForwardService(target, {
      sourceEnvironment: buildSelectedOpenShellSubprocessEnv(launchRuntime),
      verifyReady: () => {
        assertForwardGatewayAuthorityCurrent(gatewayName, authority);
        if (!isForwardServiceListenerOwner(target)) {
          throw new Error("OpenShell ForwardTcp listener ownership could not be verified");
        }
        assertForwardGatewayAuthorityCurrent(gatewayName, authority);
      },
    });
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
  entry: ReturnType<typeof registry.getSandbox> = registry.getSandbox(sandboxName),
): SandboxMessagingHostForwardPlan | null {
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
  const health = isSandboxPortForwardHealthy(
    sandboxName,
    forward.port,
    undefined,
    runtimeSelection,
  );
  if (health === true) return true;
  return ensureSandboxPortForwardForPort(sandboxName, forward.port, { runtimeSelection });
}

export function recoverMessagingHostForward(
  sandboxName: string,
  { quiet, runtimeSelection }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
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

function normalizeForwardPorts(ports: readonly number[]): number[] {
  return [...new Set(ports)].sort((first, second) => first - second);
}

function sameForwardPortSet(first: readonly number[], second: readonly number[]): boolean {
  const normalizedFirst = normalizeForwardPorts(first);
  const normalizedSecond = normalizeForwardPorts(second);
  return (
    normalizedFirst.length === normalizedSecond.length &&
    normalizedFirst.every((port, index) => port === normalizedSecond[index])
  );
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
  try {
    const owningGatewayName = resolveSandboxGatewayName(sandbox);
    if (gatewayName && gatewayName !== owningGatewayName) return false;
    const agent = agentRuntime.getSessionAgent(sandboxName);
    const primaryPort = resolveSandboxDashboardPort(sandboxName, {
      getSandbox: () => sandbox,
      getSessionAgent: () => agent,
    });
    const requiredPorts = resolveSandboxLaunchForwardPortsFromAuthority(
      sandboxName,
      sandbox,
      agent,
      primaryPort,
    );
    const assertForwardPlanCurrent = (): void => {
      const currentSandbox = registry.getSandbox(sandboxName);
      if (!currentSandbox || resolveSandboxGatewayName(currentSandbox) !== owningGatewayName) {
        throw new Error("Sandbox gateway changed during forward observation");
      }
      const currentAgent = agentRuntime.getSessionAgent(sandboxName);
      const currentPrimaryPort = resolveSandboxDashboardPort(sandboxName, {
        getSandbox: () => currentSandbox,
        getSessionAgent: () => currentAgent,
      });
      const currentRequiredPorts = resolveSandboxLaunchForwardPortsFromAuthority(
        sandboxName,
        currentSandbox,
        currentAgent,
        currentPrimaryPort,
      );
      if (
        currentPrimaryPort !== primaryPort ||
        !sameForwardPortSet(currentRequiredPorts, requiredPorts)
      ) {
        throw new Error("Sandbox forward plan changed during observation");
      }
    };
    if (requiredPorts.length === 0) {
      assertForwardPlanCurrent();
      return true;
    }

    const authority = resolveForwardGatewayAuthority(owningGatewayName);
    const proofRuntime = selectedForwardRuntime(
      owningGatewayName,
      undefined,
      authority.localTlsDir,
    );
    const executable = resolveOpenshell();
    if (!executable) return null;
    const targetContext = {
      executable,
      gatewayName: owningGatewayName,
      gatewayEndpoint: authority.endpoint,
      workspace: proofRuntime.workspace,
    };
    const primaryBind =
      isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND) || isWsl()
        ? "0.0.0.0"
        : "127.0.0.1";
    for (const port of requiredPorts) {
      assertSandboxForwardAuthorityCurrent(sandboxName, owningGatewayName, authority);
      if (!isLocalForwardReachable(port)) return false;
      const target = forwardServiceTarget(
        targetContext.executable,
        targetContext.gatewayName,
        sandboxName,
        port,
        port === primaryPort ? primaryBind : "127.0.0.1",
        targetContext.workspace,
        targetContext.gatewayEndpoint,
      );
      if (!isForwardServiceListenerOwner(target)) return false;
      assertSandboxForwardAuthorityCurrent(sandboxName, owningGatewayName, authority);
    }

    assertForwardPlanCurrent();
    const currentPrimaryBind =
      isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND) || isWsl()
        ? "0.0.0.0"
        : "127.0.0.1";
    if (currentPrimaryBind !== primaryBind) {
      throw new Error("Sandbox forward bind changed during observation");
    }
    const currentExecutable = resolveOpenshell();
    if (
      !currentExecutable ||
      !path.isAbsolute(currentExecutable) ||
      currentExecutable !== targetContext.executable
    ) {
      throw new Error("OpenShell executable changed during forward observation");
    }
    assertForwardGatewayAuthorityCurrent(owningGatewayName, authority);
    return true;
  } catch {
    return null;
  }
}

function resolveSandboxLaunchForwardPortsFromAuthority(
  sandboxName: string,
  sandbox: NonNullable<ReturnType<typeof registry.getSandbox>>,
  agent: SandboxPortAgent,
  primaryPort: number,
): number[] {
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) return [];

  const requiredPorts = new Set<number>([primaryPort]);
  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName, () => sandbox);
  if (hermesDashboard) requiredPorts.add(hermesDashboard.publicPort);
  const messagingForward = getSandboxMessagingHostForward(sandboxName, sandbox);
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
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const primaryPort = resolveSandboxDashboardPort(sandboxName, {
    getSandbox: () => sandbox,
    getSessionAgent: () => agent,
  });
  return resolveSandboxLaunchForwardPortsFromAuthority(sandboxName, sandbox, agent, primaryPort);
}

export function recoverDeclaredAgentForwardPorts(
  sandboxName: string,
  recoveryPort: number,
  { quiet, runtimeSelection }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
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
