// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  formatOpenShellForwardStartFailure,
  type OpenShellForwardAdapter,
  type OpenShellForwardIdentity,
  type OpenShellForwardObservation,
} from "../../adapters/openshell/forward";
import {
  createOpenShellForwardAdapterForAuthority,
  openShellForwardIdentity,
  type OpenShellForwardRuntimeAuthority,
} from "../../adapters/openshell/forward-runtime";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import {
  OPENSHELL_HEAVY_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/command-execution";
import * as agentRuntime from "../../agent/runtime";
import { DASHBOARD_PORT, GATEWAY_PORT, HERMES_OPENAI_API_PORT } from "../../core/ports";
import { getActiveMessagingHostForward } from "../../messaging/host-forward";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/hydration";
import type { SandboxMessagingHostForwardPlan } from "../../messaging/manifest";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { isRemoteDashboardBindRequested } from "../../onboard/dockerfile-remote-dashboard-bind-contract";
import {
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import { resolveGatewayForwardAuthority } from "../../onboard/gateway-teardown-authority";
import { resolveGatewayForwardRuntimeAuthority } from "../../onboard/gateway-host-runtime";
import { sameGatewayOwner, type GatewayOwner } from "../../onboard/gateway-ownership";
import {
  resolveSandboxHermesApiPort,
  retargetHermesApiPortInUrl,
} from "../../onboard/hermes-api-port";
import { resolveDashboardForwardBind } from "../../onboard/dashboard-runtime";
import { isWsl } from "../../platform";
import * as registry from "../../state/registry";
export type SandboxForwardHealth = boolean;
import {
  ensureHermesDashboardPortForwardIfEnabled as ensureHermesDashboardPortForward,
  getHermesDashboardRecoveryConfig,
} from "./hermes-dashboard-recovery";
import {
  HermesPortableForwardRecoveryError,
  type HermesPortableForwardRecoveryInput,
  type HermesPortableForwardRecoveryTimingEvidence,
} from "./probe/hermes-portable-forward-adapter-recovery";
export {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
} from "./probe/hermes-portable-forward-adapter-recovery";
export type {
  HermesPortableForwardRecoveryContext,
  HermesPortableForwardRecoveryFailure,
  HermesPortableForwardRecoveryInput,
  HermesPortableForwardRecoveryResult,
  HermesPortableForwardRecoveryTiming,
  HermesPortableForwardRecoveryTimingEvidence,
  HermesPortableForwardVerificationResult,
  PreparedHermesPortableForwardRecovery,
} from "./probe/hermes-portable-forward-adapter-recovery";

/** Read forward authority from the registry root that owns the sandbox. */
function readForwardSandbox(sandboxName: string): registry.SandboxEntry | null {
  return registry.getSandboxAcrossGatewayRoots(sandboxName) ?? registry.getSandbox(sandboxName);
}

function getForwardSessionAgent(
  sandboxName: string,
): ReturnType<typeof agentRuntime.getSessionAgent> {
  return agentRuntime.resolveRegisteredSandboxAgent(
    sandboxName,
    agentRuntime.getSessionAgent(sandboxName),
  );
}

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
  const runtime: OpenShellForwardRuntimeAuthority = {
    gatewayEndpoint: gatewayAuthority.endpoint,
    gatewayName: input.gatewayName,
    workspace: "default",
    ...(gatewayAuthority.localTlsDir ? { localTlsDir: gatewayAuthority.localTlsDir } : {}),
  };
  return {
    intent: input.intent,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    // Initial inspection, sequential starts, and joint verification share one deadline.
    operationTimeoutMs: OPENSHELL_HEAVY_TIMEOUT_MS,
    ports: input.ports,
    probeTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    forwards: input.ports.map((port) =>
      openShellForwardIdentity(runtime, input.sandboxName, "127.0.0.1", port),
    ),
    timing: { onComplete: input.onTiming },
    deps: {
      adapter: createOpenShellForwardAdapterForAuthority(runtime, {
        environment: input.commandAuthority.env,
        executable: input.commandAuthority.executablePath,
      }),
      assertCurrent,
      assertRollbackCurrent,
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

type InstallerLegacyForwardRetirementDeps = {
  getRegisteredAgent?: typeof agentRuntime.getRegisteredAgent;
  getSandbox?: typeof registry.getSandbox;
  hasGatewayRuntime?: typeof agentRuntime.hasGatewayRuntime;
  listSandboxes?: typeof registry.listSandboxes;
  forwardAdapterForAuthority?: (
    authority: OpenShellForwardRuntimeAuthority,
  ) => Pick<OpenShellForwardAdapter, "retireLegacyForward">;
  resolveForwardRuntimeAuthority?: typeof forwardRuntimeAuthority;
  resolveSandboxDashboardPort?: typeof resolveSandboxDashboardPort;
  selectedGatewayName?: string;
};

export type InstallerLegacyForwardRetirementSummary = Readonly<{
  retired: number;
  unchanged: number;
  skipped: number;
}>;

function resolveSandboxForwardPortsFromAuthority(
  sandboxName: string,
  sandbox: NonNullable<ReturnType<typeof registry.getSandbox>>,
  agent: SandboxPortAgent,
  primaryPort: number,
  hermesDashboardPort: number | null,
): number[] {
  const ports = new Set<number>([primaryPort]);
  if (isValidPort(hermesDashboardPort)) ports.add(hermesDashboardPort);
  const messagingForward = getSandboxMessagingHostForward(sandboxName, sandbox);
  if (messagingForward) ports.add(messagingForward.port);
  for (const port of resolveDeclaredAgentForwardPorts(
    sandbox,
    primaryPort,
    agent,
    hermesDashboardPort,
  )) {
    ports.add(port);
  }
  return [
    primaryPort,
    ...[...ports].filter((port) => port !== primaryPort).sort((first, second) => first - second),
  ];
}

function registeredLegacyForwardIdentities(
  sandboxName: string,
  sandbox: NonNullable<ReturnType<typeof registry.getSandbox>>,
  registeredAgent: SandboxPortAgent,
  runtime: OpenShellForwardRuntimeAuthority,
  resolvePort: typeof resolveSandboxDashboardPort,
): OpenShellForwardIdentity[] {
  const primaryPort = resolvePort(sandboxName, { getSandbox: () => sandbox });
  const hermesDashboardPort =
    sandbox.hermesDashboardEnabled === true && isValidPort(sandbox.hermesDashboardPort)
      ? sandbox.hermesDashboardPort
      : null;
  const ports = resolveSandboxForwardPortsFromAuthority(
    sandboxName,
    sandbox,
    registeredAgent,
    primaryPort,
    hermesDashboardPort,
  );
  const primaryBind = resolveDashboardForwardBind(sandbox, {
    requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
    wsl: isWsl(),
  });
  return ports.map((port) =>
    sandboxForwardIdentity(
      runtime,
      sandboxName,
      port,
      port === primaryPort ? primaryBind : "127.0.0.1",
    ),
  );
}

function sameForwardIdentities(
  first: readonly OpenShellForwardIdentity[],
  second: readonly OpenShellForwardIdentity[],
): boolean {
  return (
    first.length === second.length &&
    first.every((forward, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        forward.gatewayEndpoint === other.gatewayEndpoint &&
        forward.gatewayName === other.gatewayName &&
        forward.localHost === other.localHost &&
        forward.port === other.port &&
        forward.sandboxName === other.sandboxName &&
        forward.workspace === other.workspace
      );
    })
  );
}

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
  const runtimeAuthority = resolveGatewayForwardRuntimeAuthority(owner);
  return {
    endpoint: runtimeAuthority.gatewayEndpoint,
    ...(runtimeAuthority.localTlsDir ? { localTlsDir: runtimeAuthority.localTlsDir } : {}),
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
  const sandbox = readForwardSandbox(sandboxName);
  if (!sandbox || resolveSandboxGatewayName(sandbox) !== gatewayName) {
    throw new Error("Sandbox gateway changed during forward observation");
  }
  assertForwardGatewayAuthorityCurrent(gatewayName, expected);
}

/**
 * Retire exact legacy dashboard forwards before an incompatible gateway upgrade.
 */
export async function retireRegisteredLegacyDashboardForwards(
  deps: InstallerLegacyForwardRetirementDeps = {},
): Promise<InstallerLegacyForwardRetirementSummary> {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const getRegisteredAgent = deps.getRegisteredAgent ?? agentRuntime.getRegisteredAgent;
  const hasGatewayRuntime = deps.hasGatewayRuntime ?? agentRuntime.hasGatewayRuntime;
  const resolvePort = deps.resolveSandboxDashboardPort ?? resolveSandboxDashboardPort;
  const resolveRuntime = deps.resolveForwardRuntimeAuthority ?? forwardRuntimeAuthority;
  const selectedGatewayName = deps.selectedGatewayName ?? resolveGatewayName(GATEWAY_PORT);
  const adapterForAuthority =
    deps.forwardAdapterForAuthority ??
    ((authority: OpenShellForwardRuntimeAuthority) =>
      createOpenShellForwardAdapterForAuthority(authority, {
        legacyForwardWorkspaceSelection: "implicit-default",
      }));
  const sandboxes = [...(deps.listSandboxes ?? registry.listSandboxes)().sandboxes]
    .filter((sandbox) => resolveSandboxGatewayName(sandbox) === selectedGatewayName)
    .sort((a, b) => a.name.localeCompare(b.name));
  let retired = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const sandbox of sandboxes) {
    const registeredAgent = sandbox.agent ? getRegisteredAgent(sandbox) : null;
    if (registeredAgent && !hasGatewayRuntime(registeredAgent)) {
      skipped += 1;
      continue;
    }

    const sandboxName = sandbox.name;
    const gatewayName = resolveSandboxGatewayName(sandbox);
    const { authority, runtime } = resolveRuntime(gatewayName);
    const forwards = registeredLegacyForwardIdentities(
      sandboxName,
      sandbox,
      registeredAgent,
      runtime,
      resolvePort,
    );
    const assertCurrent = async (): Promise<void> => {
      const current = getSandbox(sandboxName);
      if (!current || resolveSandboxGatewayName(current) !== gatewayName) {
        throw new Error("Sandbox forward registration changed during installer retirement");
      }
      const currentRuntime = resolveRuntime(gatewayName);
      if (!sameForwardGatewayAuthority(currentRuntime.authority, authority)) {
        throw new Error("OpenShell forward authority changed during installer retirement");
      }
      const currentAgent = current.agent ? getRegisteredAgent(current) : null;
      if (
        !sameForwardIdentities(
          forwards,
          registeredLegacyForwardIdentities(
            sandboxName,
            current,
            currentAgent,
            currentRuntime.runtime,
            resolvePort,
          ),
        )
      ) {
        throw new Error("Sandbox forward registration changed during installer retirement");
      }
    };
    const adapter = adapterForAuthority(runtime);
    for (const forward of forwards) {
      const result = await adapter.retireLegacyForward({
        forward,
        assertCurrent,
        authorize: async () => assertCurrent(),
      });
      if (result.state === "retired") {
        retired += 1;
        continue;
      }
      if (result.state === "not_needed") {
        unchanged += 1;
        continue;
      }
      throw new Error(
        `Could not prove legacy forward retirement for sandbox '${sandboxName}' on port ${String(forward.port)}.`,
      );
    }
  }

  return { retired, unchanged, skipped };
}

function forwardRuntimeAuthority(
  gatewayName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): { authority: ForwardGatewayAuthority; runtime: OpenShellForwardRuntimeAuthority } {
  const authority = resolveForwardGatewayAuthority(gatewayName);
  const selection = selectedForwardRuntime(gatewayName, runtimeSelection, authority.localTlsDir);
  return {
    authority,
    runtime: {
      gatewayEndpoint: authority.endpoint,
      gatewayName,
      workspace: selection.workspace,
      ...(selection.localTlsDir ? { localTlsDir: selection.localTlsDir } : {}),
    },
  };
}

function sandboxForwardIdentity(
  authority: OpenShellForwardRuntimeAuthority,
  sandboxName: string,
  port: number,
  expectedBind = "127.0.0.1",
): OpenShellForwardIdentity {
  return openShellForwardIdentity(
    authority,
    sandboxName,
    expectedBind === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1",
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
  const getSandbox = deps.getSandbox ?? readForwardSandbox;
  const sandbox = getSandbox(sandboxName);
  if (isValidPort(sandbox?.dashboardPort)) {
    return sandbox.dashboardPort;
  }

  const getSessionAgent = deps.getSessionAgent ?? getForwardSessionAgent;
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
  const agent = getForwardSessionAgent(sandboxName);
  if (agent && agentRuntime.hasGatewayRuntime(agent)) {
    return retargetHermesApiPortInUrl(
      agentRuntime.getHealthProbeUrl(agent),
      resolveSandboxHermesApiPort(readForwardSandbox(sandboxName) ?? {}),
    );
  }
  return `http://127.0.0.1:${resolveSandboxDashboardPort(sandboxName)}/health`;
}

/**
 * Wait for OpenShell's direct forwards to exit after the sandbox becomes unavailable.
 */
export async function teardownSandboxDashboardForward(
  sandboxName: string,
  deps: {
    getSandbox?: typeof registry.getSandbox;
    forwardAdapterForAuthority?: (
      authority: OpenShellForwardRuntimeAuthority,
    ) => Pick<OpenShellForwardAdapter, "verifyForwardRelease">;
    resolveForwardRuntimeAuthority?: typeof forwardRuntimeAuthority;
    resolveSandboxDashboardPort?: typeof resolveSandboxDashboardPort;
  } = {},
): Promise<boolean> {
  try {
    const getSandbox = deps.getSandbox ?? readForwardSandbox;
    const sandbox = getSandbox(sandboxName);
    if (!sandbox) return true;
    const registeredAgent = sandbox.agent ? agentRuntime.getRegisteredAgent(sandbox) : null;
    if (registeredAgent && !agentRuntime.hasGatewayRuntime(registeredAgent)) return true;
    const resolvePort = deps.resolveSandboxDashboardPort ?? resolveSandboxDashboardPort;
    const gatewayName = resolveSandboxGatewayName(sandbox);
    const { authority, runtime } = (deps.resolveForwardRuntimeAuthority ?? forwardRuntimeAuthority)(
      gatewayName,
    );
    const forwards = registeredLegacyForwardIdentities(
      sandboxName,
      sandbox,
      registeredAgent,
      runtime,
      resolvePort,
    );
    const release = await (
      deps.forwardAdapterForAuthority ?? createOpenShellForwardAdapterForAuthority
    )(runtime).verifyForwardRelease({
      forwards,
      timeoutMs: 5_000,
      assertCurrent: async () => assertForwardGatewayAuthorityCurrent(gatewayName, authority),
    });
    if (release.state !== "released") {
      const unreleasedPorts =
        "forwards" in release
          ? release.forwards.map((forward) => forward.port)
          : forwards.map((forward) => forward.port);
      console.error(
        `  ForwardTcp cleanup did not release registered host port(s): ${unreleasedPorts.join(", ")}.`,
      );
      return false;
    }
    return true;
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
export async function ensureSandboxPortForward(
  sandboxName: string,
  options: SandboxForwardRecoveryOptions = {},
): Promise<boolean> {
  const port = resolveSandboxDashboardPort(sandboxName);
  const sandbox = readForwardSandbox(sandboxName);
  const remoteBindRequested = isRemoteDashboardBindRequested(process.env.NEMOCLAW_DASHBOARD_BIND);
  const bind = resolveDashboardForwardBind(sandbox, {
    requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
    wsl: isWsl({ isWsl: options.isWsl }),
  });
  if (remoteBindRequested && sandbox?.dashboardRemoteBindPrepared !== true) {
    console.error(
      `  Refusing remote dashboard bind for '${sandboxName}': its generated configuration was not prepared for remote exposure. Re-run onboarding with NEMOCLAW_DASHBOARD_BIND=0.0.0.0 and --recreate-sandbox before reconnecting.`,
    );
    return false;
  }
  return ensureSandboxPortForwardForPort(sandboxName, port, {
    forwardTarget: bind === "0.0.0.0" ? `0.0.0.0:${port}` : String(port),
    expectedBind: bind,
    afterSuccess: options.afterSuccess,
    beforeStart: () =>
      (!remoteBindRequested ||
        readForwardSandbox(sandboxName)?.dashboardRemoteBindPrepared === true) &&
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
 * - `stale`: an exact legacy forward may be retired only through adapter
 *   authority and is then re-observed before replacement.
 * - `foreign`: another listener owns the port, so recovery does not mutate it.
 * - `indeterminate`: observation could not prove a safe state, so recovery
 *   fails closed without mutation.
 */
export type SandboxForwardListener = OpenShellForwardObservation["state"];

export type OpenShellForwardObservationAdapterFactory = (
  authority: OpenShellForwardRuntimeAuthority,
) => Pick<OpenShellForwardAdapter, "observeForwards">;

export async function describeSandboxForwardListener(
  sandboxName: string,
  options: {
    forwardAdapterForAuthority?: OpenShellForwardObservationAdapterFactory;
    isWsl?: boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): Promise<SandboxForwardListener> {
  const bind = resolveDashboardForwardBind(readForwardSandbox(sandboxName), {
    requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
    wsl: isWsl({ isWsl: options.isWsl }),
  });
  return await describeSandboxPortForwardListener(
    sandboxName,
    resolveSandboxDashboardPort(sandboxName),
    bind,
    options.runtimeSelection,
    options.forwardAdapterForAuthority,
  );
}

export async function isSandboxForwardHealthy(
  sandboxName: string,
  options: { isWsl?: boolean; runtimeSelection?: OpenShellRuntimeSelection } = {},
): Promise<SandboxForwardHealth> {
  return (await describeSandboxForwardListener(sandboxName, options)) === "owned";
}

export async function isSandboxPortForwardHealthy(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<SandboxForwardHealth> {
  return (
    (await describeSandboxPortForwardListener(
      sandboxName,
      port,
      expectedBind,
      runtimeSelection,
    )) === "owned"
  );
}

/** Why recovery leaves a listener it cannot attribute to the sandbox alone. */
export function nonOwnedForwardListenerRefusal(sandboxName: string, port: number): string {
  return `  Host port ${String(port)} for '${sandboxName}' is held by a listener that NemoClaw cannot attribute to this sandbox's OpenShell forward. NemoClaw cannot prove it started the listener, so it leaves the listener running and does not restore a forward onto it. Find the owner with \`ss -ltnp 'sport = :${String(port)}'\` or \`lsof -nP -iTCP:${String(port)} -sTCP:LISTEN\`, free the port, then run \`nemoclaw ${sandboxName} recover\` again.`;
}

function forwardOperationFailureMessage(
  result:
    | Awaited<ReturnType<OpenShellForwardAdapter["startForward"]>>
    | Awaited<ReturnType<OpenShellForwardAdapter["retireLegacyForward"]>>,
): string {
  if ("error" in result) {
    const failure = "failure" in result ? result.failure : undefined;
    const suffix = failure ? ` [${formatOpenShellForwardStartFailure(failure)}]` : "";
    return `${result.error.message}${suffix}`;
  }
  if ("observation" in result && result.observation.state === "foreign") {
    return "The host port is owned by a foreign listener.";
  }
  return "NemoClaw could not prove the OpenShell forward state.";
}

export async function describeSandboxPortForwardListener(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  forwardAdapterForAuthority?: OpenShellForwardObservationAdapterFactory,
  expectedListenerPid?: number,
): Promise<SandboxForwardListener> {
  return await inspectSandboxPortForwardListener(
    sandboxName,
    port,
    expectedBind,
    runtimeSelection,
    forwardAdapterForAuthority,
    expectedListenerPid,
  );
}

async function inspectSandboxPortForwardListener(
  sandboxName: string,
  port: number,
  expectedBind?: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  forwardAdapterForAuthority: OpenShellForwardObservationAdapterFactory = createOpenShellForwardAdapterForAuthority,
  expectedListenerPid?: number,
): Promise<SandboxForwardListener> {
  const sandbox = readForwardSandbox(sandboxName);
  if (!sandbox) return "absent";
  try {
    const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
    const { authority, runtime } = forwardRuntimeAuthority(gatewayName, runtimeSelection);
    const [observation] = await forwardAdapterForAuthority(runtime).observeForwards({
      forwards: [sandboxForwardIdentity(runtime, sandboxName, port, expectedBind)],
      ...(expectedListenerPid === undefined
        ? {}
        : { expectedListenerPidsByPort: new Map([[port, expectedListenerPid]]) }),
      assertCurrent: async () =>
        assertSandboxForwardAuthorityCurrent(sandboxName, gatewayName, authority),
    });
    return observation?.state ?? "indeterminate";
  } catch {
    return "indeterminate";
  }
}

export async function ensureSandboxPortForwardForPort(
  sandboxName: string,
  port: number,
  options: {
    afterSuccess?: () => boolean;
    forwardTarget?: string;
    expectedBind?: string;
    beforeStart?: () => boolean;
    runtimeSelection?: OpenShellRuntimeSelection;
  } = {},
): Promise<boolean> {
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
    listener = await inspectSandboxPortForwardListener(
      sandboxName,
      port,
      expectedBind,
      runtimeSelection,
    );
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
  if (listener === "foreign" || listener === "indeterminate") {
    console.error(nonOwnedForwardListenerRefusal(sandboxName, port));
    return false;
  }
  if (!beforeStart()) return false;
  try {
    const sandbox = readForwardSandbox(sandboxName);
    if (!sandbox) throw new Error(`Sandbox '${sandboxName}' is not registered`);
    const gatewayName = runtimeSelection?.gatewayName ?? resolveSandboxGatewayName(sandbox);
    const { authority, runtime } = forwardRuntimeAuthority(gatewayName, runtimeSelection);
    const forward = sandboxForwardIdentity(
      runtime,
      sandboxName,
      port,
      expectedBind ?? (forwardTarget.startsWith("0.0.0.0:") ? "0.0.0.0" : "127.0.0.1"),
    );
    const adapter = createOpenShellForwardAdapterForAuthority(runtime);
    const assertCurrent = async () =>
      assertSandboxForwardAuthorityCurrent(sandboxName, gatewayName, authority);
    if (listener === "stale") {
      const retirement = await adapter.retireLegacyForward({
        forward,
        assertCurrent,
        authorize: async () =>
          assertSandboxForwardAuthorityCurrent(sandboxName, gatewayName, authority),
      });
      if (retirement.state !== "retired" && retirement.state !== "not_needed") {
        throw new Error(forwardOperationFailureMessage(retirement));
      }
    }
    const started = await adapter.startForward({ forward, assertCurrent });
    if (started.state !== "started" && started.state !== "reused") {
      throw new Error(forwardOperationFailureMessage(started));
    }
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

export async function ensureHermesDashboardPortForwardIfEnabled(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean | null> {
  return ensureHermesDashboardPortForward(sandboxName, {
    getRecoveryConfig: (name) => getHermesDashboardRecoveryConfig(name, readForwardSandbox),
    isPortForwardHealthy: (name, port) =>
      isSandboxPortForwardHealthy(name, port, undefined, runtimeSelection),
    ensurePortForward: (name, port) =>
      ensureSandboxPortForwardForPort(name, port, { runtimeSelection }),
  });
}

function getSandboxMessagingHostForward(
  sandboxName: string,
  entry: ReturnType<typeof registry.getSandbox> = readForwardSandbox(sandboxName),
): SandboxMessagingHostForwardPlan | null {
  const parsed = parseSandboxMessagingPlan(entry?.messaging?.plan, { sandboxName });
  const plan = parsed ? hydrateDerivedSandboxMessagingPlanFields(parsed) : null;
  return getActiveMessagingHostForward(plan);
}

export async function ensureMessagingHostForwardHealthy(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean | null> {
  const forward = getSandboxMessagingHostForward(sandboxName);
  if (!forward) return null;
  const health = await isSandboxPortForwardHealthy(
    sandboxName,
    forward.port,
    undefined,
    runtimeSelection,
  );
  if (health === true) return true;
  return ensureSandboxPortForwardForPort(sandboxName, forward.port, { runtimeSelection });
}

export async function recoverMessagingHostForward(
  sandboxName: string,
  { quiet, runtimeSelection }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
): Promise<boolean | null> {
  const recovered = await ensureMessagingHostForwardHealthy(sandboxName, runtimeSelection);
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
export async function ensureDeclaredAgentForwardPortsHealthy(
  sandboxName: string,
  primaryPort: number,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean | null> {
  const agent = getForwardSessionAgent(sandboxName);
  if (!agent) return null;
  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName, readForwardSandbox);
  const sandbox = readForwardSandbox(sandboxName);
  const ports = resolveDeclaredAgentForwardPorts(
    sandbox,
    primaryPort,
    agent,
    hermesDashboard?.publicPort ?? null,
  );
  if (ports.length === 0) return null;
  let allHealthy = true;
  for (const port of ports) {
    const health = await isSandboxPortForwardHealthy(
      sandboxName,
      port,
      undefined,
      runtimeSelection,
    );
    if (health === true) continue;
    if (!(await ensureSandboxPortForwardForPort(sandboxName, port, { runtimeSelection }))) {
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
export async function areSandboxLaunchForwardsHealthy(
  sandboxName: string,
  gatewayName?: string,
  deps: {
    forwardAdapterForAuthority?: (
      authority: OpenShellForwardRuntimeAuthority,
    ) => Pick<OpenShellForwardAdapter, "observeForwards">;
  } = {},
): Promise<boolean | null> {
  const sandbox = readForwardSandbox(sandboxName);
  if (!sandbox) return false;
  try {
    const owningGatewayName = resolveSandboxGatewayName(sandbox);
    if (gatewayName && gatewayName !== owningGatewayName) return false;
    const agent = getForwardSessionAgent(sandboxName);
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
      const currentSandbox = readForwardSandbox(sandboxName);
      if (!currentSandbox || resolveSandboxGatewayName(currentSandbox) !== owningGatewayName) {
        throw new Error("Sandbox gateway changed during forward observation");
      }
      const currentAgent = getForwardSessionAgent(sandboxName);
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

    const { authority, runtime } = forwardRuntimeAuthority(owningGatewayName);
    const primaryBind = resolveDashboardForwardBind(sandbox, {
      requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
      wsl: isWsl(),
    });
    const observations = await (
      deps.forwardAdapterForAuthority ?? createOpenShellForwardAdapterForAuthority
    )(runtime).observeForwards({
      forwards: requiredPorts.map((port) =>
        sandboxForwardIdentity(
          runtime,
          sandboxName,
          port,
          port === primaryPort ? primaryBind : "127.0.0.1",
        ),
      ),
      assertCurrent: async () => {
        assertSandboxForwardAuthorityCurrent(sandboxName, owningGatewayName, authority);
        assertForwardPlanCurrent();
      },
    });
    if (observations.some((observation) => observation.state === "indeterminate")) return null;
    if (observations.some((observation) => observation.state !== "owned")) return false;

    assertForwardPlanCurrent();
    const currentPrimaryBind = resolveDashboardForwardBind(readForwardSandbox(sandboxName), {
      requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
      wsl: isWsl(),
    });
    if (currentPrimaryBind !== primaryBind) {
      throw new Error("Sandbox forward bind changed during observation");
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

  const hermesDashboard = getHermesDashboardRecoveryConfig(sandboxName, () => sandbox);
  return resolveSandboxForwardPortsFromAuthority(
    sandboxName,
    sandbox,
    agent,
    primaryPort,
    hermesDashboard?.publicPort ?? null,
  );
}

/** Resolve the complete forward set used by launch-readiness health. */
export function resolveSandboxLaunchForwardPorts(sandboxName: string): number[] | null {
  const sandbox = readForwardSandbox(sandboxName);
  if (!sandbox) return null;
  const agent = getForwardSessionAgent(sandboxName);
  const primaryPort = resolveSandboxDashboardPort(sandboxName, {
    getSandbox: () => sandbox,
    getSessionAgent: () => agent,
  });
  return resolveSandboxLaunchForwardPortsFromAuthority(sandboxName, sandbox, agent, primaryPort);
}

export async function recoverDeclaredAgentForwardPorts(
  sandboxName: string,
  recoveryPort: number,
  { quiet, runtimeSelection }: { quiet: boolean; runtimeSelection?: OpenShellRuntimeSelection },
): Promise<boolean | null> {
  const recovered = await ensureDeclaredAgentForwardPortsHealthy(
    sandboxName,
    recoveryPort,
    runtimeSelection,
  );
  if (!quiet && recovered === false) {
    console.error("  One or more agent-declared port forwards could not be re-established.");
  }
  return recovered;
}
