// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  createForwardServiceController,
  type ForwardServiceController,
  type ForwardServiceSandboxAuthority,
} from "../../adapters/openshell/forward-service-controller";
import { type ForwardServiceAuthorityMigration } from "../../adapters/openshell/forward-service-migration";
import {
  captureOpenshell,
  captureResolvedOpenshell,
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
import {
  requireProductionForwardServiceAuthority,
  retireProductionLegacySandboxForwards,
} from "../../onboard/forward-service-migration";
import { observeSandboxOnGateway } from "../../onboard/sandbox-recreate-probe";
import {
  resolveSandboxHermesApiPort,
  retargetHermesApiPortInUrl,
} from "../../onboard/hermes-api-port";
import { isWsl } from "../../platform";
import { resolveNemoclawStateDir } from "../../state/paths";
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
  readonly sandboxIdentityFingerprint: string;
  readonly sandboxName: string;
}): HermesPortableForwardRecoveryInput {
  const migration = requireProductionForwardServiceAuthority(input.sandboxName, {
    observe: (target) =>
      observeSandboxOnGateway(target, (args, options) =>
        captureResolvedOpenshell(args, {
          ...options,
          env: input.commandAuthority.env,
          openshellBinary: input.commandAuthority.executablePath,
          replaceEnv: true,
        }),
      ),
  });
  if (
    migration.authority.gatewayName !== input.gatewayName ||
    migration.authority.sandboxIdentityFingerprint !== input.sandboxIdentityFingerprint
  ) {
    throw new HermesPortableForwardRecoveryError("authority-drift");
  }
  const controller = createForwardServiceController({
    executable: () => input.commandAuthority.executablePath,
    sourceEnvironment: input.commandAuthority.env,
    stateDirectory: resolveNemoclawStateDir(),
    runExclusive: (_sandboxName, operation) => operation(),
  });
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
      authority: migration.authority,
      controller,
      migrateLegacy: () =>
        retireProductionLegacySandboxForwards(migration, {
          capture: (gatewayName) =>
            captureResolvedOpenshell(["forward", "list", "--gateway", gatewayName], {
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

function recordedForwardServiceAuthority(
  sandboxName: string,
  sandbox: ReturnType<typeof registry.getSandbox>,
): ForwardServiceSandboxAuthority | null {
  const sandboxIdentityFingerprint = sandbox?.lifecycleLiveIdentityFingerprint;
  if (!sandboxIdentityFingerprint || !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint)) {
    return null;
  }
  return {
    gatewayName: resolveSandboxGatewayName(sandbox),
    sandboxIdentityFingerprint,
    sandboxName,
  };
}

function migrateForwardServiceAuthority(sandboxName: string) {
  return requireProductionForwardServiceAuthority(sandboxName);
}

function retireLegacyForwardServiceMigration(migration: ForwardServiceAuthorityMigration): number {
  return retireProductionLegacySandboxForwards(migration, {
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

function runtimeForwardServiceController(): ForwardServiceController {
  return createForwardServiceController({
    executable: () => {
      const executable = resolveOpenshell();
      if (!executable) throw new Error("OpenShell is unavailable");
      return executable;
    },
    stateDirectory: resolveNemoclawStateDir(),
    // Runtime recovery, stop, and destroy call this module only from their
    // already-held sandbox lifecycle fence. The process owner still requires
    // an explicit serialization boundary so an un-fenced caller cannot be
    // introduced accidentally through the controller API.
    runExclusive: (_sandboxName, operation) => operation(),
  });
}

function endpoint(port: number, expectedBind = "127.0.0.1") {
  return {
    localHost: expectedBind === "0.0.0.0" ? ("0.0.0.0" as const) : ("127.0.0.1" as const),
    localPort: port,
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
 * Tear down the host-side dashboard port-forward this sandbox created.
 *
 * `stop` stops the container but must also release every receipt-owned
 * ForwardTcp child. The one-release migration seam first retires any
 * identity-qualified installed-base SSH forwards; all steady-state cleanup is
 * then exact receipt/PID control with no mutable-name fallback.
 * Returns false only when receipt-owned ForwardTcp cleanup could not be
 * completed, so destructive callers can preserve immutable retry authority.
 */
export function teardownSandboxDashboardForward(
  sandboxName: string,
  deps: {
    controller?: ForwardServiceController;
    getSandbox?: typeof registry.getSandbox;
    isLocalForwardReachable?: typeof isLocalForwardReachable;
    migrateAuthority?: (sandboxName: string) => ForwardServiceAuthorityMigration;
    retireLegacy?: (migration: ForwardServiceAuthorityMigration) => number;
    resolveSandboxDashboardPort?: typeof resolveSandboxDashboardPort;
  } = {},
): boolean {
  try {
    const getSandbox = deps.getSandbox ?? registry.getSandbox;
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return true;
    const resolvePort = deps.resolveSandboxDashboardPort ?? resolveSandboxDashboardPort;
    const primaryPort = resolvePort(sandboxName, { getSandbox: () => sandbox });
    const registeredAgent = sandbox.agent ? agentRuntime.getRegisteredAgent(sandbox) : null;
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
    const migration = (deps.migrateAuthority ?? migrateForwardServiceAuthority)(sandboxName);
    (deps.retireLegacy ?? retireLegacyForwardServiceMigration)(migration);
    (deps.controller ?? runtimeForwardServiceController()).stopAll(migration.authority);
    const isReachable = deps.isLocalForwardReachable ?? isLocalForwardReachable;
    const unreleasedPorts = [...ports].filter((port) => isReachable(port));
    if (unreleasedPorts.length > 0) {
      console.error(
        `  ForwardTcp cleanup did not release registered host port(s): ${unreleasedPorts.join(", ")}.`,
      );
    }
    return unreleasedPorts.length === 0;
  } catch (error) {
    console.error(
      `  ForwardTcp receipt/process cleanup did not complete: ${
        error instanceof Error ? error.message : "unknown process-control failure"
      }`,
    );
    return false;
  }
}

/**
 * Re-establish the dashboard port forward to the sandbox.
 * Uses the recorded dashboard port when available, including custom ports for
 * non-OpenClaw agents, then falls back to the active agent's declared port.
 * Returns true when the direct ForwardTcp service owner establishes the exact
 * receipt and listener, false otherwise.
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
  const sandbox = registry.getSandbox(sandboxName);
  const authority = recordedForwardServiceAuthority(sandboxName, sandbox);
  if (!authority) return false;
  try {
    const inspection = runtimeForwardServiceController().inspect(
      authority,
      endpoint(port, expectedBind),
    );
    if (inspection.disposition === "owned") {
      if (inspection.ownsListener === null) return null;
      return inspection.ownsListener && inspection.reachable;
    }
    return inspection.disposition === "absent" || !inspection.reachable ? false : "occupied";
  } catch {
    return null;
  }
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
  const managedEndpoint = endpoint(
    port,
    expectedBind ?? (forwardTarget.startsWith("0.0.0.0:") ? "0.0.0.0" : "127.0.0.1"),
  );
  const acceptSuccessfulForward = () => {
    let accepted = false;
    try {
      accepted = afterSuccess();
    } catch {
      accepted = false;
    }
    if (accepted) return true;
    try {
      const migration = migrateForwardServiceAuthority(sandboxName);
      runtimeForwardServiceController().stop(migration.authority, managedEndpoint);
    } catch {
      return false;
    }
    return false;
  };
  const forwardHealth = isSandboxPortForwardHealthy(sandboxName, port, expectedBind);
  if (forwardHealth === true && !forceRestart) return acceptSuccessfulForward();
  if (forwardHealth === "occupied") return false;
  if (!beforeStart()) return false;
  try {
    const migration = migrateForwardServiceAuthority(sandboxName);
    migration.assertLiveCurrent();
    retireLegacyForwardServiceMigration(migration);
    const controller = runtimeForwardServiceController();
    if (forceRestart) controller.stop(migration.authority, managedEndpoint);
    controller.ensure(migration.authority, managedEndpoint);
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
    if (health === "occupied") {
      allHealthy = false;
      continue;
    }
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
  const authority = recordedForwardServiceAuthority(sandboxName, sandbox);
  if (!authority) return false;
  const controller = runtimeForwardServiceController();
  const primaryPort = resolveSandboxDashboardPort(sandboxName, { getSandbox: () => sandbox });
  try {
    for (const port of requiredPorts) {
      const allInterface =
        port === primaryPort && (sandbox.dashboardRemoteBindPrepared === true || isWsl({}));
      const inspection = controller.inspect(
        authority,
        endpoint(port, allInterface ? "0.0.0.0" : "127.0.0.1"),
      );
      if (
        inspection.disposition !== "owned" ||
        inspection.ownsListener !== true ||
        !inspection.reachable
      ) {
        return false;
      }
    }
    return true;
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

/**
 * Re-establish the complete host-forward set for one still-live sandbox.
 *
 * Destructive lifecycle operations use this only as rollback after they have
 * retired the exact receipt-owned ForwardTcp processes but then refuse the
 * sandbox deletion. Each helper is idempotent and derives ports from the same
 * immutable registry identity, so rollback never selects a forward by mutable
 * sandbox name alone.
 */
export function restoreSandboxLaunchForwards(sandboxName: string): boolean {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) return false;
  const primaryPort = resolveSandboxDashboardPort(sandboxName, { getSandbox: () => sandbox });
  const outcomes = [
    ensureSandboxPortForward(sandboxName),
    ensureHermesDashboardPortForwardIfEnabled(sandboxName),
    ensureMessagingHostForwardHealthy(sandboxName),
    ensureDeclaredAgentForwardPortsHealthy(sandboxName, primaryPort),
  ];
  return outcomes.every((outcome) => outcome !== false);
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
