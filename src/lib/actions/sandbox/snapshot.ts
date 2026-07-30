// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { formatFailedBackupItems } from "../../domain/backup-failure";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import * as nim from "../../inference/nim";
import {
  isDcodeAgent,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  OBSERVABILITY_POLICY_BINDING,
} from "../../onboard/observability-policy-presets";
import { normalizePolicyTierName } from "../../onboard/policy-tier-suppression";
import * as policies from "../../policy";
import { ROOT, run, validateName } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import * as shields from "../../shields";
import { withTimerBoundShieldsMutationLock } from "../../shields/timer-bound-lock";
import { readTimerMarker } from "../../shields/timer-control";
import { isSandboxReady } from "../../state/gateway";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import * as sandboxState from "../../state/sandbox";
import {
  DCODE_AGENT_NAME,
  DCODE_BUSY_PROBE_SCRIPT,
  DCODE_PROBE_STATE,
  parseDcodeProbeState,
} from "./dcode-activity-probe";
import { cleanupShieldsDestroyArtifacts, removeSandboxRegistryEntry } from "./destroy";
import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdoutFromStreams,
} from "./sandbox-exec-output";
import {
  probeGatewayRunning,
  selectSandboxGatewayIfRegistered,
  usesGatewayMetadataProbe,
} from "./sandbox-gateway-routing";
import {
  assertSandboxCreateArgvWithinTransportLimit,
  captureOpenshell,
  cleanupHermesSandboxProviders,
  createManagedBootstrapIdentity,
  createManagedStartupRootApplyRequest,
  dockerCapture,
  findAvailableDashboardPort,
  formatSnapshotBaselineExclusionSummary,
  getHermesToolGatewayCloneBroker,
  getOpenshellBinary,
  getRegistryOccupiedDashboardPorts,
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
  HERMES_SANDBOX_PROVIDER_SUFFIXES,
  type HermesToolGatewayCloneBroker,
  isValidForwardPort,
  MANAGED_STARTUP_CA_ENV,
  MANAGED_STARTUP_PROFILE_ENV,
  type ManagedBootstrapRuntimeCreateLifecycle,
  type ManagedBootstrapRuntimePatch,
  type ManagedBootstrapRuntimeProvider,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
  type ManagedStartupRootApplyRequest,
  type PreparedManagedCloneProvider,
  printHermesGatewayRestoreHint,
  renderManagedBootstrapHeldCommand,
  resolveHermesDashboardOnboardState,
  resolveOpenShellSandboxId,
  resolvePersistedManagedBootstrapRuntimeProvider,
  resolveSandboxGatewayName,
  runOpenshell,
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
  streamSandboxCreate,
  withDashboardPortReservationLock,
} from "./snapshot/dependencies";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = useColor ? "\x1b[1m" : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";

export type SnapshotRequest =
  | { kind: "help" }
  | { kind: "create"; name?: string }
  | { kind: "list" }
  | {
      kind: "restore";
      selector?: string;
      to?: string;
      /** #3756: required when `to` names an existing sandbox. Deletes the
       * destination first, then recreates it from the source's image. */
      force?: boolean;
      /** Skip the --force interactive confirmation. Implied by
       * NEMOCLAW_NON_INTERACTIVE=1. */
      yes?: boolean;
    };

export class SnapshotCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[] = [], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n") || `Snapshot command failed with exit ${exitCode}`);
    this.name = "SnapshotCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function snapshotExit(exitCode = 1): never {
  throw new SnapshotCommandError([], exitCode);
}

function formatSnapshotVersion(b: unknown) {
  const snapshotVersion = (b as { snapshotVersion?: number }).snapshotVersion ?? 0;
  return `v${snapshotVersion}`;
}

function renderSnapshotTable(
  backups: Array<{
    snapshotVersion: number;
    name?: string | null;
    timestamp: string;
    backupPath: string;
  }>,
) {
  const rows = backups.map((b) => ({
    version: formatSnapshotVersion(b),
    name: b.name || "",
    timestamp: b.timestamp,
    backupPath: b.backupPath,
  }));
  const widths = {
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    timestamp: Math.max(9, ...rows.map((r) => r.timestamp.length)),
    backupPath: Math.max(4, ...rows.map((r) => r.backupPath.length)),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  console.log(
    `    ${B}${pad("Version", widths.version)}  ${pad("Name", widths.name)}  ${pad("Timestamp", widths.timestamp)}  ${pad("Path", widths.backupPath)}${R}`,
  );
  for (const r of rows) {
    console.log(
      `    ${pad(r.version, widths.version)}  ${pad(r.name, widths.name)}  ${pad(r.timestamp, widths.timestamp)}  ${D}${pad(r.backupPath, widths.backupPath)}${R}`,
    );
  }
}

// Resolve the running src pod's image. Docker- and VM-driver sandboxes don't
// have the legacy cluster container — trust the registered imageTag and fail
// fast if it's missing. Only the "kubernetes" driver falls back to the
// kubectl probe inside the gateway container.
function resolveSrcPodImage(
  srcName: string,
  srcEntry?: SandboxEntry | { name: string },
): string | null {
  const registeredImage = (srcEntry as { imageTag?: string | null } | undefined)?.imageTag;
  const registeredWorkload = (
    srcEntry as
      | {
          workload?: { kind?: string; reference?: string } | null;
        }
      | undefined
  )?.workload;
  if (
    registeredWorkload?.kind === "managed-image" &&
    registeredWorkload.reference === registeredImage
  ) {
    return registeredImage ?? null;
  }
  const registeredDriver = (srcEntry as { openshellDriver?: string | null } | undefined)
    ?.openshellDriver;
  if (usesGatewayMetadataProbe(registeredDriver)) {
    return registeredImage ?? null;
  }

  const srcGatewayName = resolveSandboxGatewayName(
    srcEntry as { gatewayName?: string | null; gatewayPort?: number | null },
  );
  const gatewayContainer = `openshell-cluster-${srcGatewayName}`;
  try {
    const output = dockerCapture(
      [
        "exec",
        gatewayContainer,
        "kubectl",
        "get",
        "pod",
        srcName,
        "-n",
        "openshell",
        "-o",
        'jsonpath={.spec.containers[?(@.name=="agent")].image}',
      ],
      { ignoreError: true, timeout: 10000 },
    );
    return output.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

// Allocate the clone's own dashboard port. Dashboard ports are per-sandbox
// host resources: the host forward for src's port is owned by src, so a clone
// that inherits the port gets a dashboard URL that points at src's dashboard
// and a rebuild preflight that rejects the clone forever (#6746). Allocate
// dst's own port instead, from the same per-gateway forward list +
// cross-gateway registry occupancy view as onboard's `ensureDashboardForward`.
// Sources without a dashboard port (non-dashboard-managed agents) return null
// so the clone's field stays unset. Callers must invoke this before any
// destructive step (e.g. deleting a `--force` destination) so port-range
// exhaustion aborts before, not after, the mutation.
function allocateCloneDashboardPort(
  dstName: string,
  srcEntry: {
    name?: string;
    dashboardPort?: number | null;
    hermesDashboardEnabled?: boolean;
    hermesDashboardInternalPort?: number | null;
  },
): number | null {
  const srcPort = srcEntry.dashboardPort;
  if (typeof srcPort !== "number" || !Number.isInteger(srcPort) || srcPort <= 0) return null;
  const forwards = captureOpenshell(["forward", "list"], { ignoreError: true });
  const occupied = getRegistryOccupiedDashboardPorts(dstName);
  const hermesInternalPort = srcEntry.hermesDashboardInternalPort;
  if (srcEntry.hermesDashboardEnabled === true && isValidForwardPort(hermesInternalPort)) {
    occupied.set(
      String(hermesInternalPort),
      `${srcEntry.name ?? "source"} (Hermes dashboard internal)`,
    );
  }
  try {
    return findAvailableDashboardPort(dstName, srcPort, forwards.output || "", undefined, occupied);
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    snapshotExit(1);
  }
}

function resolveCloneDashboardEnvArgs(
  srcEntry: SandboxEntry | { name: string },
  dstDashboardPort: number | null,
): string[] {
  const envArgs: string[] = [];
  if (dstDashboardPort !== null) {
    envArgs.push(`CHAT_UI_URL=http://127.0.0.1:${dstDashboardPort}`);
    envArgs.push(`NEMOCLAW_DASHBOARD_PORT=${dstDashboardPort}`);
  }

  const source = srcEntry as SandboxEntry;
  if (source.agent !== "hermes") return envArgs;
  if (source.hermesDashboardEnabled !== true) {
    envArgs.push(`${HERMES_DASHBOARD_ENABLE_ENV}=0`);
    return envArgs;
  }
  if (dstDashboardPort === null) {
    console.error("  Cannot clone enabled Hermes dashboard settings without a dashboard port.");
    snapshotExit(1);
  }
  const hermesEnv: NodeJS.ProcessEnv = {
    [HERMES_DASHBOARD_ENABLE_ENV]: "1",
    [HERMES_DASHBOARD_PORT_ENV]: String(dstDashboardPort),
    [HERMES_DASHBOARD_INTERNAL_PORT_ENV]: String(source.hermesDashboardInternalPort),
    [HERMES_DASHBOARD_TUI_ENV]: source.hermesDashboardTui === true ? "1" : "0",
  };
  try {
    resolveHermesDashboardOnboardState({
      agentName: source.agent,
      effectivePort: dstDashboardPort,
      env: hermesEnv,
    });
  } catch (error) {
    console.error(
      `  Cannot clone Hermes dashboard settings: ${error instanceof Error ? error.message : String(error)}.`,
    );
    snapshotExit(1);
  }
  for (const [name, value] of Object.entries(hermesEnv)) {
    envArgs.push(`${name}=${value}`);
  }
  return envArgs;
}

interface PreparedManagedSnapshotClone {
  readonly envArgs: readonly string[];
  readonly runtimeProvider: ManagedBootstrapRuntimeProvider;
  readonly rootApplyRequest: ManagedStartupRootApplyRequest;
  readonly workload: Extract<NonNullable<SandboxEntry["workload"]>, { kind: "managed-image" }>;
  readonly messaging: SandboxEntry["messaging"];
  readonly registryFields: Partial<SandboxEntry>;
  readonly credentialProviders: readonly PreparedManagedCloneProvider[];
  /** Ephemeral destination-only credentials; never forwarded to sandbox create. */
  readonly credentialEnvironment: NodeJS.ProcessEnv;
}

type SnapshotMessagingPlan = NonNullable<SandboxEntry["messaging"]>["plan"];

function managedCloneRegistryFields(
  profile: ManagedStartupProfile,
  source: SandboxEntry,
): Partial<SandboxEntry> {
  const webSearch =
    profile.agentConfig.agent === "langchain-deepagents-code"
      ? null
      : profile.agentConfig.webSearch;
  const hermesDashboard = profile.dashboard.agent === "hermes" ? profile.dashboard : null;
  const dcodeConfig =
    profile.agentConfig.agent === "langchain-deepagents-code" ? profile.agentConfig : null;
  const hermesInferenceProvider =
    profile.agent === "hermes" && profile.tools.enabledGateways.length > 0
      ? profile.inference.upstreamProvider
      : undefined;
  return {
    // Snapshot peers stay on the source gateway's configured route. The
    // destination-scoped provider below owns only that sandbox's rotating key.
    provider:
      hermesInferenceProvider === undefined ? profile.inference.upstreamProvider : source.provider,
    model: profile.inference.model,
    endpointUrl: source.endpointUrl ?? null,
    endpointSource: source.endpointSource ?? null,
    credentialEnv: source.credentialEnv ?? null,
    preferredInferenceApi: profile.inference.api,
    compatibleEndpointReasoning:
      profile.agent === "openclaw" && profile.inference.upstreamProvider === "compatible-endpoint"
        ? profile.tuning.reasoning === true
          ? "true"
          : "false"
        : null,
    compatibleEndpointReasoningEffort:
      profile.agent === "openclaw" &&
      profile.inference.upstreamProvider === "compatible-endpoint" &&
      profile.inference.api === "openai-completions" &&
      profile.tuning.reasoningEffort !== "default"
        ? profile.tuning.reasoningEffort
        : null,
    toolDisclosure: profile.tools.disclosure,
    webSearchEnabled: webSearch?.enabled === true,
    webSearchProvider: webSearch?.enabled === true ? webSearch.provider : null,
    observabilityEnabled: dcodeConfig?.observabilityEnabled === true,
    ...(dcodeConfig ? { dcodeAutoApprovalMode: dcodeConfig.autoApprovalMode } : {}),
    hermesToolGateways:
      profile.agent === "hermes" && profile.tools.enabledGateways.length > 0
        ? [...profile.tools.enabledGateways]
        : undefined,
    hermesInferenceProvider,
    hermesDashboardEnabled: hermesDashboard?.mode === "loopback-forwarded" ? true : undefined,
    hermesDashboardPort:
      hermesDashboard?.mode === "loopback-forwarded" ? hermesDashboard.publicPort : undefined,
    hermesDashboardInternalPort:
      hermesDashboard?.mode === "loopback-forwarded" ? hermesDashboard.internalPort : undefined,
    hermesDashboardTui:
      hermesDashboard?.mode === "loopback-forwarded" && hermesDashboard.tuiEnabled
        ? true
        : undefined,
    dashboardRemoteBindPrepared:
      profile.dashboard.agent === "openclaw" && profile.dashboard.bindAddress === "0.0.0.0",
  };
}

async function prepareManagedSnapshotClone(
  sourceSandboxName: string,
  destinationSandboxName: string,
  source: SandboxEntry,
  fromImage: string,
  destinationDashboardPort: number | null,
  destinationWillBeReplaced: boolean,
): Promise<PreparedManagedSnapshotClone | null> {
  const workload = source.workload;
  if (workload?.kind !== "managed-image") return null;
  const runtimeProvider = resolvePersistedManagedBootstrapRuntimeProvider(source.openshellDriver);
  if (workload.reference !== fromImage || source.imageTag !== workload.reference) {
    throw new Error("managed workload receipt does not match the source sandbox image reference");
  }
  const { MANAGED_STARTUP_AGENTS, MANAGED_STARTUP_PROFILE_SCHEMA_VERSION } = await import(
    "../../onboard/managed-startup/profile"
  );
  if (
    typeof source.agent !== "string" ||
    !(MANAGED_STARTUP_AGENTS as readonly string[]).includes(source.agent)
  ) {
    throw new Error("managed workload receipt has no exact shipped-agent identity");
  }
  if (workload.startupProfileContractVersion !== MANAGED_STARTUP_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `managed workload receipt uses unsupported startup profile contract ${String(
        workload.startupProfileContractVersion,
      )}`,
    );
  }
  const { rebindManagedStartupProfileForClone } = await import(
    "../../onboard/managed-startup/clone-rebinder"
  );
  const hermesToolGatewayBroker = getHermesToolGatewayCloneBroker();
  const destinationHermesInferenceProvider =
    source.agent === "hermes" &&
    Array.isArray(source.hermesToolGateways) &&
    source.hermesToolGateways.length > 0
      ? hermesToolGatewayBroker.getHermesInferenceProviderName(destinationSandboxName)
      : undefined;
  const rebound = rebindManagedStartupProfileForClone({
    sourceSandboxName,
    destinationSandboxName,
    expectedAgent: source.agent as ManagedStartupAgent,
    destinationDashboardPort,
    ...(destinationHermesInferenceProvider === undefined
      ? {}
      : { destinationHermesInferenceProvider }),
    encodedProfile: workload.encodedProfile,
    startupProfileSha256: workload.startupProfileSha256,
    ...(workload.corporateCaB64 === undefined ? {} : { corporateCaB64: workload.corporateCaB64 }),
    currentSource: source,
  });
  const targetWorkload = {
    ...workload,
    encodedProfile: rebound.encodedProfile,
    startupProfileSha256: rebound.startupProfileSha256,
    ...(rebound.corporateCaB64 === undefined ? {} : { corporateCaB64: rebound.corporateCaB64 }),
  } as const;
  const credentialProxyEnvArgs = workload.credentialProxyReplayRequired
    ? (await import("../../onboard/host-proxy-env")).credentialHostProxyReplayEnvArgs(process.env)
    : [];
  const messaging =
    rebound.profile.messaging.plan === null
      ? undefined
      : {
          schemaVersion: 1 as const,
          plan: rebound.profile.messaging.plan as unknown as NonNullable<
            SandboxEntry["messaging"]
          >["plan"],
        };
  const { prepareManagedCloneProviders, resolveManagedCloneCredentialEnvironment } = await import(
    "./snapshot/managed-clone-providers"
  );
  if (rebound.profile.agent === "hermes" && rebound.profile.tools.enabledGateways.length > 0) {
    // This read-only compatibility/health proof must precede both interactive
    // OAuth and the force-restore destination deletion boundary.
    hermesToolGatewayBroker.preflightHermesToolGatewayCloneBinding(destinationSandboxName);
  }
  const credentialEnvironment = await resolveManagedCloneCredentialEnvironment({
    profile: rebound.profile,
  });
  const providerEnvironment = { ...process.env, ...credentialEnvironment };
  return {
    envArgs: credentialProxyEnvArgs,
    runtimeProvider,
    rootApplyRequest: createManagedStartupRootApplyRequest({
      agent: rebound.profile.agent,
      encodedProfile: rebound.encodedProfile,
      ...(rebound.corporateCaB64 === undefined ? {} : { corporateCaB64: rebound.corporateCaB64 }),
    }),
    workload: targetWorkload,
    registryFields: managedCloneRegistryFields(rebound.profile, source),
    messaging,
    credentialEnvironment,
    credentialProviders: prepareManagedCloneProviders({
      profile: rebound.profile,
      messagingPlan: (messaging?.plan ?? null) as SnapshotMessagingPlan | null,
      destinationSandboxName,
      destinationWillBeReplaced,
      environment: providerEnvironment,
      root: ROOT,
      runOpenshell,
      hermesToolGatewayBroker,
    }),
  };
}

async function prepareSnapshotClonePolicy(srcEntry: SandboxEntry): Promise<{
  policyPath: string;
  cleanup?: () => boolean;
}> {
  if (srcEntry.baselineExclusionTransition) {
    const transition = srcEntry.baselineExclusionTransition;
    throw new Error(
      `Cannot clone baseline policy while '${transition.operation} ${transition.exclusion.key}' needs repair. Re-run that policy command on '${srcEntry.name}' first.`,
    );
  }
  const agentName = srcEntry.agent || "openclaw";
  const baseline = policies.resolveAgentBaselinePolicy(agentName);
  if (!baseline) {
    throw new Error(`Cannot resolve the '${agentName}' baseline policy for snapshot restore.`);
  }
  const baselineExclusions = srcEntry.baselineExclusions ?? [];
  if (baselineExclusions.length === 0) return { policyPath: baseline.policyPath };

  const disabledChannels = new Set(registry.getDisabledMessagingChannelsFromEntry(srcEntry));
  const activeMessagingChannels = registry
    .getConfiguredMessagingChannelsFromEntry(srcEntry)
    .filter((channel) => !disabledChannels.has(channel));
  const { prepareInitialSandboxCreatePolicy } = await import("../../onboard/initial-policy");
  return prepareInitialSandboxCreatePolicy(baseline.policyPath, activeMessagingChannels, {
    agentName,
    baselineExclusions,
  });
}

// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Returns true on success; on failure, logs and throws SnapshotCommandError.
interface PreparedSnapshotCloneLaunch {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly createEnv: NodeJS.ProcessEnv;
  readonly sourceEntry: SandboxEntry | { name: string };
  readonly sourceObservabilityEnabled: boolean;
  readonly managedClone: PreparedManagedSnapshotClone | null;
  readonly destinationDashboardPort: number | null;
  readonly startupCommand: readonly string[];
  readonly intendedStartupCommand: readonly string[];
  readonly managedBootstrapIdentity: string | null;
  readonly managedBootstrapRuntimeProvider: ManagedBootstrapRuntimeProvider | null;
}

function prepareSnapshotCloneLaunch(
  dstName: string,
  srcEntry: SandboxEntry | { name: string },
  fromImage: string,
  createPolicyPath: string,
  dstDashboardPort: number | null,
  dashboardEnvArgs: readonly string[],
  managedClone: PreparedManagedSnapshotClone | null,
): PreparedSnapshotCloneLaunch {
  const openshellBin = getOpenshellBinary();
  const sourceObservabilityEnabled =
    (srcEntry as { observabilityEnabled?: boolean }).observabilityEnabled === true;
  const intendedStartupCommand = [
    "env",
    ...(managedClone
      ? managedClone.envArgs
      : [`NEMOCLAW_OBSERVABILITY=${sourceObservabilityEnabled ? "1" : "0"}`, ...dashboardEnvArgs]),
    "nemoclaw-start",
  ];
  const managedBootstrapIdentity = managedClone ? createManagedBootstrapIdentity() : null;
  const managedBootstrapRuntimeProvider = managedClone?.runtimeProvider ?? null;
  const startupCommand =
    managedClone && managedBootstrapIdentity
      ? renderManagedBootstrapHeldCommand(
          managedClone.rootApplyRequest,
          managedBootstrapIdentity,
          intendedStartupCommand,
        )
      : intendedStartupCommand;
  const createEnv = { ...process.env };
  delete createEnv.NEMOCLAW_OBSERVABILITY;
  delete createEnv[MANAGED_STARTUP_PROFILE_ENV];
  delete createEnv[MANAGED_STARTUP_CA_ENV];
  for (const provider of managedClone?.credentialProviders ?? []) {
    delete createEnv[provider.providerEnvKey];
  }

  const command = openshellBin;
  const commandArgs = [
    "sandbox",
    "create",
    "--name",
    dstName,
    "--from",
    fromImage,
    "--policy",
    createPolicyPath,
    "--auto-providers",
    ...(managedClone
      ? managedClone.credentialProviders.flatMap((provider) => [
          "--provider",
          provider.providerName,
        ])
      : []),
    "--",
    ...startupCommand,
  ];
  assertSandboxCreateArgvWithinTransportLimit([command, ...commandArgs]);
  return {
    command,
    commandArgs,
    createEnv,
    sourceEntry: srcEntry,
    sourceObservabilityEnabled,
    managedClone,
    destinationDashboardPort: dstDashboardPort,
    startupCommand,
    intendedStartupCommand,
    managedBootstrapIdentity,
    managedBootstrapRuntimeProvider,
  };
}

function createManagedSnapshotLifecycle(
  dstName: string,
  fromImage: string,
  launch: PreparedSnapshotCloneLaunch,
): ManagedBootstrapRuntimeCreateLifecycle | null {
  const managedClone = launch.managedClone;
  if (!managedClone) return null;
  const runtimeProvider = launch.managedBootstrapRuntimeProvider;
  const bootstrapIdentity = launch.managedBootstrapIdentity;
  if (!runtimeProvider || !bootstrapIdentity) {
    throw new Error("managed snapshot clone has no runtime provider");
  }
  const separator = fromImage.lastIndexOf("@");
  const repository = separator > 0 ? fromImage.slice(0, separator) : "";
  const manifestDigest = separator > 0 ? fromImage.slice(separator + 1) : "";
  if (!repository || !/^sha256:[a-f0-9]{64}$/u.test(manifestDigest)) {
    throw new Error("managed snapshot clone image is not one immutable digest reference");
  }
  const captureText = (args: string[], options?: Record<string, unknown>) =>
    captureOpenshell(args, options as { ignoreError?: boolean }).output ?? "";
  return runtimeProvider.createCreateLifecycle({
    bootstrapIdentity,
    request: managedClone.rootApplyRequest,
    image: {
      repository,
      manifestDigest: manifestDigest as `sha256:${string}`,
    },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: launch.intendedStartupCommand,
    expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox"],
    launchArgv: [launch.command, ...launch.commandArgs],
    heldWorkloadArgv: launch.startupCommand,
    route: "native",
    persistStartupCommand: true,
    sandboxName: dstName,
    sandboxGpuConfig: {
      mode: "0",
      hostGpuDetected: false,
      hostGpuPlatform: null,
      sandboxGpuEnabled: false,
      sandboxGpuDevice: null,
      errors: [],
    },
    requiredLimits: [],
    timeoutSecs: Math.ceil(OPENSHELL_PROBE_TIMEOUT_MS / 1000),
    onPatchFailure: (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
    network: {
      inferenceProvider: "",
      dockerDriverGateway: false,
      gatewayPort: 0,
    },
    dependencies: {
      runOpenshell,
      runCaptureOpenshell: captureText,
    },
  });
}

async function autoCreateSandboxFromSource(
  srcName: string,
  dstName: string,
  fromImage: string,
  launch: PreparedSnapshotCloneLaunch,
): Promise<void> {
  const {
    command,
    commandArgs,
    createEnv,
    sourceEntry,
    sourceObservabilityEnabled,
    managedClone,
    destinationDashboardPort,
  } = launch;
  const managedLifecycle = createManagedSnapshotLifecycle(dstName, fromImage, launch);
  const managedStartupPatch: ManagedBootstrapRuntimePatch | null = managedLifecycle?.patch ?? null;
  console.log(`  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`);
  const streamCloneCreate = () => {
    const [createExecutable, ...createExecutableArgs] = managedLifecycle?.launchArgv ?? [
      command,
      ...commandArgs,
    ];
    if (!createExecutable) {
      throw new Error("managed snapshot clone create executable is missing");
    }
    return streamSandboxCreate(createExecutable, createExecutableArgs, createEnv, {
      // Use a pre-built image, so skip build+push and jump to pod creation.
      initialPhase: "create",
      // Wait until the sandbox actually reaches Ready state, not just appears in the list.
      readyCheck: () => {
        const list = captureOpenshell(["sandbox", "list"], {
          ignoreError: true,
        });
        if (list.status !== 0) return false;
        return isSandboxReady(list.output || "", dstName);
      },
    });
  };
  await managedLifecycle?.prepareNetwork();
  let createResult: Awaited<ReturnType<typeof streamSandboxCreate>>;
  if (managedClone && managedLifecycle && launch.managedBootstrapIdentity) {
    const runtimeDriverId = launch.managedBootstrapRuntimeProvider?.driverId;
    if (!runtimeDriverId) throw new Error("managed snapshot clone has no runtime provider");
    const captureText = (args: string[], options?: Record<string, unknown>) =>
      captureOpenshell(args, options as { ignoreError?: boolean }).output ?? "";
    createResult = await managedLifecycle.runCreate(
      async ({ heldWorkloadArgv, bootstrapIdentity }) => {
        if (
          bootstrapIdentity !== launch.managedBootstrapIdentity ||
          heldWorkloadArgv.length !== launch.startupCommand.length ||
          heldWorkloadArgv.some((value, index) => value !== launch.startupCommand[index])
        ) {
          throw new Error("managed snapshot clone hold identity changed before create");
        }
        const streamed = await streamCloneCreate();
        if (streamed.status !== 0 && !streamed.forcedReady) {
          const tail = (streamed.output || "").slice(-600);
          throw new SnapshotCommandError(
            [
              `Failed to create sandbox '${dstName}' (exit ${streamed.status}).`,
              ...(tail ? [tail] : []),
            ],
            1,
          );
        }
        const list = captureText(["sandbox", "list"], { ignoreError: true });
        if (!isSandboxReady(list, dstName)) {
          throw new Error("managed snapshot clone did not reach authoritative Ready");
        }
        return {
          value: streamed,
          receipt: {
            sandbox: {
              sandboxName: dstName,
              sandboxId: resolveOpenShellSandboxId(dstName, captureText),
              driverId: runtimeDriverId,
            },
            ready: true,
            readyAt: new Date().toISOString(),
          },
        };
      },
    );
  } else {
    createResult = await streamCloneCreate();
  }
  await managedStartupPatch?.exitOnPatchError();

  if (createResult.status !== 0 && !createResult.forcedReady) {
    await managedStartupPatch?.rollbackManagedStartupAfterCreateFailure();
    console.error(`  Failed to create sandbox '${dstName}' (exit ${createResult.status}).`);
    const tail = (createResult.output || "").slice(-600);
    if (tail) console.error(tail);
    snapshotExit(1);
  }
  // Double-check Ready after stream exit.
  const verify = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (verify.status !== 0 || !isSandboxReady(verify.output || "", dstName)) {
    await managedStartupPatch?.rollbackManagedStartupAfterCreateFailure();
    console.error(`  Sandbox '${dstName}' did not reach Ready state after create.`);
    snapshotExit(1);
  }
  await managedStartupPatch?.commitAfterReady();

  // DNS proxy is only meaningful for the kubernetes driver (matches onboard.ts).
  const dnsScript = path.join(ROOT, "scripts", "setup-dns-proxy.sh");
  const srcDriver = (sourceEntry as { openshellDriver?: string | null }).openshellDriver;
  if (srcDriver === "kubernetes" && fs.existsSync(dnsScript)) {
    const srcGatewayName = resolveSandboxGatewayName(
      sourceEntry as { gatewayName?: string | null; gatewayPort?: number | null },
    );
    run(["bash", dnsScript, srcGatewayName, dstName], { ignoreError: true });
  }

  // Register dst in the NemoClaw registry, cloning most fields from src.
  // Policies are cleared here — the caller replays them from the snapshot
  // manifest after the restore succeeds and writes them back into this entry.
  registry.registerSandbox({
    ...sourceEntry,
    ...(managedClone ? managedClone.registryFields : {}),
    name: dstName,
    createdAt: new Date().toISOString(),
    policies: [],
    observabilityEnabled: sourceObservabilityEnabled,
    workload: managedClone ? managedClone.workload : (sourceEntry as SandboxEntry).workload,
    messaging: managedClone ? managedClone.messaging : (sourceEntry as SandboxEntry).messaging,
    // dst has its own lifecycle; don't inherit src's local NIM container
    // reference, or destroying dst would stop src's NIM.
    nimContainer: null,
    // No CUDA proof has run for dst (this auto-create path passes no GPU flags),
    // so clear src's proof rather than inheriting it — otherwise dst could show
    // `Sandbox GPU: enabled (CUDA verified)` based on another sandbox's run (#4231).
    sandboxGpuProof: null,
    dashboardPort: destinationDashboardPort,
    // The shared image keeps Hermes' image-baked internal listener port, but
    // the public WebUI port is a per-sandbox host resource and must follow the
    // clone's newly allocated dashboard port so rebuild validation converges.
    hermesDashboardPort:
      (sourceEntry as SandboxEntry).hermesDashboardEnabled === true
        ? destinationDashboardPort
        : (sourceEntry as SandboxEntry).hermesDashboardPort,
  });

  console.log(`  ${G}\u2713${R} Sandbox '${dstName}' created`);
}

// Delete an existing destination sandbox so `snapshot restore --to <dst> --force`
// can recreate it from the source's image. Stops the destination's NIM
// container, runs `openshell sandbox delete`, performs the destination-only
// cleanups that `sandboxDestroy` does (PID dir, per-sandbox messaging
// providers, shields state), then drops the NemoClaw registry entry. Throws
// SnapshotCommandError on failure so the caller does not proceed into a
// partially-deleted target.
//
// Host-shared cleanups that destroy.ts performs \u2014 Ollama auth proxy
// (`killStaleProxy`), host services (`cleanupSandboxServices` with
// `stopHostServices`), Ollama model unload, gateway teardown \u2014 are
// deliberately skipped here because they can also affect the source sandbox
// we are about to clone from.
function deleteSandboxForRestore(name: string): void {
  const sbMeta = registry.getSandbox(name);
  if (sbMeta?.nimContainer) {
    nim.stopNimContainerByName(sbMeta.nimContainer);
  } else {
    nim.stopNimContainer(name, { silent: true });
  }
  console.log(`  Deleting existing destination '${name}' before restore...`);
  withTimerBoundShieldsMutationLock(name, "delete snapshot restore destination", () => {
    if (readTimerMarker(name)) {
      shields.shieldsUp(name, {
        throwOnError: true,
        allowLegacyHermesProtocol: true,
      });
    }
    const providerCleanup = runSandboxProviderPreDeleteCleanup(name, {
      runOpenshell,
      // Snapshot restore treats detach failures as fatal below and emits only
      // generated provider names, so never echo untrusted gateway diagnostics.
      warn: () => {},
    });
    if (providerCleanup.failures.length > 0) {
      console.error(
        `  Failed to detach destination provider(s) before deleting '${name}': ` +
          providerCleanup.failures.map((failure) => failure.name).join(", "),
      );
      snapshotExit(1);
    }
    const deleteResult = runOpenshell(["sandbox", "delete", name], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
    if (deleteResult.status !== 0 && !alreadyGone) {
      // Any active timer was cleared only after shieldsUp verified the live
      // destination was hardened. Preserve that locked state on failure.
      console.error(
        `  Failed to delete '${name}' (exit ${deleteResult.status}). Aborting restore.`,
      );
      snapshotExit(1);
    }
    // Destination-only cleanup so the recreated sandbox does not inherit stale
    // host-side state or hit provider-name conflicts (Codex #3796 P2):
    // - /tmp/nemoclaw-services-<name>: PID dir for this sandbox's services
    // - OpenShell per-sandbox messaging bridge providers declared by channel
    //   manifests.
    // - shields-<name>.json + shields timer: per-sandbox shields artifacts
    try {
      fs.rmSync(`/tmp/nemoclaw-services-${name}`, {
        recursive: true,
        force: true,
      });
    } catch {
      // PID dir may not exist \u2014 ignore.
    }
    const hermesSuffixes = new Set<string>(HERMES_SANDBOX_PROVIDER_SUFFIXES);
    for (const suffix of SANDBOX_PROVIDER_SUFFIXES) {
      if (hermesSuffixes.has(suffix)) continue;
      runOpenshell(["provider", "delete", `${name}-${suffix}`], {
        ignoreError: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    const hasHermesBrokerIdentity =
      Boolean(sbMeta?.hermesInferenceProvider) ||
      (Array.isArray(sbMeta?.hermesToolGateways) && sbMeta.hermesToolGateways.length > 0);
    const hermesBroker = getHermesToolGatewayCloneBroker();
    const hermesCleanup = cleanupHermesSandboxProviders(name, hasHermesBrokerIdentity, {
      runOpenshell,
      removeHermesToolGatewayProviderState: () =>
        sbMeta ? hermesBroker.removeHermesToolGatewayProviderStateForSandboxEntry(sbMeta) : false,
    });
    if (
      hasHermesBrokerIdentity &&
      (!hermesCleanup.providerCleanupSucceeded || !hermesCleanup.brokerStateRemoved)
    ) {
      console.error(
        `  Destination '${name}' was deleted, but its identity-bound Hermes provider cleanup is incomplete.`,
      );
      console.error(
        `  Its registry ownership was preserved. Run '${CLI_NAME} ${name} destroy' to finish cleanup, then retry restore.`,
      );
      snapshotExit(1);
    }
    cleanupShieldsDestroyArtifacts(name);
    removeSandboxRegistryEntry(name);
  });
  console.log(`  ${G}\u2713${R} '${name}' deleted`);
}

function cleanupFailedSnapshotCloneTarget(name: string): void {
  const providerCleanup = runSandboxProviderPreDeleteCleanup(name, {
    runOpenshell,
    tolerateMissingSandbox: true,
    warn: () => {},
  });
  if (providerCleanup.failures.length > 0) {
    console.warn(
      `  Warning: could not detach all providers from failed clone '${name}': ` +
        providerCleanup.failures.map((failure) => failure.name).join(", "),
    );
  }
  const deleteResult = runOpenshell(["sandbox", "delete", name], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { alreadyGone } = getSandboxDeleteOutcome(deleteResult);
  if (deleteResult.status !== 0 && !alreadyGone) {
    console.warn(
      `  Warning: could not remove incomplete clone '${name}' before credential-provider rollback.`,
    );
  }
}

function listLiveSandboxesOnSandboxGateway(sandboxName: string): Set<string> | null {
  if (!selectSandboxGatewayIfRegistered(sandboxName)) return null;
  if (!probeGatewayRunning(sandboxName)) return null;
  const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (isLive.status !== 0) return null;
  return parseLiveSandboxNames(isLive.output || "");
}

function requireLiveSandboxesOnSandboxGateway(sandboxName: string, error: string): Set<string> {
  const liveNames = listLiveSandboxesOnSandboxGateway(sandboxName);
  if (!liveNames) {
    console.error(error);
    snapshotExit(1);
  }
  return liveNames;
}

function verifyRestoreDestinationOnOwnGateway(targetSandbox: string): void {
  const liveNames = requireLiveSandboxesOnSandboxGateway(
    targetSandbox,
    `  Cannot verify destination sandbox '${targetSandbox}' on its registered gateway. Aborting restore.`,
  );
  if (!liveNames.has(targetSandbox)) {
    console.error(
      `  Destination sandbox '${targetSandbox}' is registered locally, but is not present on its registered gateway.`,
    );
    console.error("  Aborting restore before deleting or overwriting local sandbox metadata.");
    snapshotExit(1);
  }
}

function isSnapshotCreationAllowedByShields(sandboxName: string): boolean {
  // Snapshot creation is a shields/policy boundary. Production builds should
  // always export this helper, but stale compiled artifacts, package-boundary
  // skew, or test doubles can present a missing CommonJS interop surface. There
  // is no safe runtime source fix once snapshot creation has started, so keep
  // this as permanent defense-in-depth and fail closed before backup side effects.
  const isShieldsDown = shields.isShieldsDown;
  if (typeof isShieldsDown !== "function") {
    console.error("  Cannot verify shields state. Refusing to create snapshot.");
    return false;
  }
  return isShieldsDown(sandboxName);
}

function shouldCheckDcodeActivity(sandboxName: string): boolean {
  const entry = registry.getSandbox(sandboxName);
  // Preserve the existing snapshot path for registered non-dcode sandboxes while
  // still probing missing-registry entries, where stale metadata is part of the risk.
  return !entry || entry.agent === DCODE_AGENT_NAME;
}

function isSnapshotCreationAllowedByDcodeActivity(sandboxName: string): boolean {
  // Invalid state: backing up .deepagents while dcode is actively mutating it can
  // produce a snapshot that later restores inconsistent agent state. The source
  // boundary available today is the live sandbox process table plus runtime
  // markers, because the managed dcode wrapper does not yet expose an atomic
  // quiescence lock that backupSandboxState can consume. Keep this guard
  // fail-closed for missing/unknown probe sentinels, OpenShell exec failures,
  // timeouts, and any detected-but-unverifiable runtime. Remove this workaround
  // when dcode exposes a wrapper-owned idle/active lock or equivalent snapshot
  // quiescence signal and the backup path checks that source directly.
  const execMarker = createSandboxExecMarker();
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      buildSandboxExecMarkedCommand(DCODE_BUSY_PROBE_SCRIPT, execMarker),
    ],
    {
      ignoreError: true,
      includeStreams: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    },
  );
  const probeCompleted = probe.status === 0 && !probe.error && !probe.signal;
  const commandStdout = probeCompleted
    ? extractSandboxExecCommandStdoutFromStreams(
        { stdout: probe.stdout, stderr: probe.stderr },
        execMarker,
      )
    : null;
  const probeState = commandStdout === null ? null : parseDcodeProbeState(commandStdout);
  if (
    probeState === DCODE_PROBE_STATE.idleDcodeRuntime ||
    probeState === DCODE_PROBE_STATE.noDcodeRuntime
  ) {
    return true;
  }
  if (probeState === DCODE_PROBE_STATE.active) {
    console.error(
      "  Sandbox is actively running a dcode task. Please retry after the task completes.",
    );
    return false;
  }

  console.error(
    `  Cannot verify whether sandbox '${sandboxName}' is actively running a dcode task. Refusing to create snapshot.`,
  );
  return false;
}

function runSnapshotCreate(
  sandboxName: string,
  request: Extract<SnapshotRequest, { kind: "create" }>,
): void {
  const liveNames = requireLiveSandboxesOnSandboxGateway(
    sandboxName,
    "  Failed to query live sandbox state from OpenShell.",
  );
  if (!liveNames.has(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' is not running. Cannot create snapshot.`);
    snapshotExit(1);
  }
  return withTimerBoundShieldsMutationLock(sandboxName, "create sandbox snapshot", () => {
    // Keep the shields check and backup in one timer-bound interval. Normal
    // auto-restore waits; at the absolute deadline it may preempt this process
    // and reclaim the token rather than changing policy/config mid-copy.
    if (!isSnapshotCreationAllowedByShields(sandboxName)) {
      console.error("  Cannot create snapshot while shields are up.");
      console.error(`  Run \`${CLI_NAME} ${sandboxName} shields down\` first, then retry.`);
      snapshotExit(1);
    }
    if (
      shouldCheckDcodeActivity(sandboxName) &&
      !isSnapshotCreationAllowedByDcodeActivity(sandboxName)
    ) {
      snapshotExit(1);
    }
    const label = request.name ? ` (--name ${request.name})` : "";
    console.log(`  Creating snapshot of '${sandboxName}'${label}...`);
    const result = sandboxState.backupSandboxState(sandboxName, {
      name: request.name ?? null,
    });
    if (result.success) {
      const manifest = result.manifest!;
      const entry = sandboxState.findBackup(sandboxName, manifest.timestamp).match ?? manifest;
      const v = formatSnapshotVersion(entry);
      const nameSuffix = entry.name ? ` name=${entry.name}` : "";
      const itemSummary = `${result.backedUpDirs.length} directories, ${result.backedUpFiles.length} files`;
      console.log(`  ${G}✓${R} Snapshot ${v}${nameSuffix} created (${itemSummary})`);
      console.log(`    ${manifest.backupPath}`);
      for (const line of formatSnapshotBaselineExclusionSummary(
        registry.getBaselineExclusions(sandboxName),
      )) {
        console.log(`    ${line}`);
      }
      return;
    }
    if (result.error) {
      console.error(`  ${result.error}`);
    } else {
      console.error("  Snapshot failed.");
      if (result.failedDirs.length > 0) {
        const failedDirs = formatFailedBackupItems(result.failedDirs, result.failedDirReasons);
        console.error(`  Failed directories: ${failedDirs}`);
      }
      if (result.failedFiles.length > 0) {
        console.error(`  Failed files: ${result.failedFiles.join(", ")}`);
      }
    }
    snapshotExit(1);
  });
}

function repairRestoredOpenClawConfigPerms(
  targetSandbox: string,
  result: ReturnType<typeof sandboxState.restoreSandboxState>,
): void {
  if (!result.restoredFiles.includes("openclaw.json")) return;
  try {
    const permRepair = shields.repairMutableConfigPerms(targetSandbox);
    if (permRepair.applied && permRepair.verified) {
      console.log(`  ${G}✓${R} OpenClaw config permissions restored`);
    } else if (!permRepair.applied && permRepair.skipReason === "unreadable") {
      console.warn(`  Warning: could not verify OpenClaw config permissions: ${permRepair.reason}`);
    } else if (permRepair.applied && !permRepair.verified) {
      console.warn(
        `  Warning: OpenClaw config permission repair incomplete: ${permRepair.errors.join("; ")}`,
      );
    }
  } catch (err) {
    console.warn(
      `  Warning: OpenClaw config permission repair errored: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function reconcileSnapshotPolicyPresets(
  targetSandbox: string,
  resolvedSnapshot: ReturnType<typeof sandboxState.getLatestBackup>,
): void {
  if (!resolvedSnapshot) return;
  const snapshotPolicyPresets = Array.isArray(resolvedSnapshot.policyPresets)
    ? resolvedSnapshot.policyPresets
    : null;
  const hasSnapshotPresetMetadata = snapshotPolicyPresets !== null;
  const snapshotCustomPolicies = Array.isArray(resolvedSnapshot.customPolicies)
    ? resolvedSnapshot.customPolicies
    : [];
  const snapshotCustomPolicyNames = new Set(
    snapshotCustomPolicies.map((entry) => entry.name.trim().toLowerCase()),
  );
  const snapshotPresets =
    snapshotPolicyPresets?.filter(
      (preset) => !snapshotCustomPolicyNames.has(preset.trim().toLowerCase()),
    ) ?? [];
  const targetEntry = registry.getSandbox(targetSandbox);
  // Custom reconciliation runs before this function. Only the registry state
  // that remains after that reconciliation can participate in ownership.
  const currentCustomPolicies = registry.getCustomPolicies(targetSandbox);
  const currentCustomPolicyNames = new Set(
    currentCustomPolicies.map((preset) => preset.name.trim().toLowerCase()),
  );
  const customPolicyNames = new Set([...snapshotCustomPolicyNames, ...currentCustomPolicyNames]);
  let customOwnsObservability: boolean;
  try {
    customOwnsObservability = OBSERVABILITY_POLICY_BINDING.hasLiveCustomOwner(
      targetSandbox,
      currentCustomPolicies.map((entry) => entry.content),
      policies,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `  Warning: could not verify custom ownership of '${OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET}' (${detail}); leaving live policy presets unchanged.`,
    );
    return;
  }
  const withoutBuiltinObservability = snapshotPresets.filter(
    (preset) => !OBSERVABILITY_POLICY_BINDING.matchesPreset(preset),
  );
  const shouldEnableBuiltinObservability =
    !customOwnsObservability &&
    isDcodeAgent(targetEntry?.agent) &&
    targetEntry?.observabilityEnabled === true &&
    normalizePolicyTierName(targetEntry.policyTier) !== "restricted";
  // getAppliedPresets includes custom-policy names for display/CLI parity.
  // Built-in preset reconciliation must not remove those; custom policy content
  // is reconciled separately below from registry.getCustomPolicies().
  const currentPresets = hasSnapshotPresetMetadata
    ? [...new Set(policies.getAppliedPresets(targetSandbox))].filter((preset: string) => {
        const normalized = preset.trim().toLowerCase();
        return (
          !OBSERVABILITY_POLICY_BINDING.matchesPreset(normalized) &&
          !customPolicyNames.has(normalized)
        );
      })
    : [];
  const recordedBuiltinObservability = (targetEntry?.policies ?? []).some((preset) =>
    OBSERVABILITY_POLICY_BINDING.matchesPreset(preset),
  );
  const setRecordedBuiltinObservability = (enabled: boolean, force = false): void => {
    const currentEntry = registry.getSandbox(targetSandbox);
    if (!currentEntry) return;
    const currentPolicies = currentEntry.policies ?? [];
    const currentlyRecorded = currentPolicies.some((preset) =>
      OBSERVABILITY_POLICY_BINDING.matchesPreset(preset),
    );
    if (!force && enabled === currentlyRecorded) return;
    registry.updateSandbox(targetSandbox, {
      policies: OBSERVABILITY_POLICY_BINDING.setAttribution(currentPolicies, enabled),
    });
  };
  if (customOwnsObservability) {
    setRecordedBuiltinObservability(false);
  }
  // Legacy snapshots predate generic preset metadata. Leave those unrelated
  // presets untouched, while still reconciling the managed observability
  // binding below from the target registry's authoritative enablement state.
  const toRemove = hasSnapshotPresetMetadata
    ? currentPresets.filter((preset: string) => !withoutBuiltinObservability.includes(preset))
    : [];
  const toAdd = hasSnapshotPresetMetadata
    ? withoutBuiltinObservability.filter((preset: string) => !currentPresets.includes(preset))
    : [];

  // A same-name custom policy does not own the built-in OTLP entry unless its
  // exact, overlapping content is both registered after custom reconciliation
  // and live in the gateway. Reconcile the built-in from exact content state,
  // never from a name/key-only match that could delete drifted operator policy.
  let builtinObservabilityContent: string | null = null;
  let builtinObservabilityState: "match" | "absent" | "drift" | null = null;
  if (!customOwnsObservability) {
    const loadedBinding = OBSERVABILITY_POLICY_BINDING.load(targetSandbox, policies);
    builtinObservabilityContent = loadedBinding.content;
    builtinObservabilityState = loadedBinding.state;
    const builtinState = builtinObservabilityState;
    if (builtinState === "absent" && shouldEnableBuiltinObservability) {
      toAdd.push(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET);
    } else if (builtinState === "absent" && recordedBuiltinObservability) {
      setRecordedBuiltinObservability(false);
    } else if (builtinState === "match" && !shouldEnableBuiltinObservability) {
      toRemove.push(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET);
    } else if (builtinState === "match" && !recordedBuiltinObservability) {
      setRecordedBuiltinObservability(true);
    } else if (builtinState === "drift" || builtinState === null) {
      const reason = builtinState === "drift" ? "has drifted" : "could not be inspected";
      console.warn(
        `  Warning: built-in preset '${OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET}' ${reason}; leaving its live policy content unchanged.`,
      );
    }
  }
  if (toRemove.length === 0 && toAdd.length === 0) return;

  const summary: string[] = [];
  if (toAdd.length > 0) summary.push(`add ${toAdd.join(", ")}`);
  if (toRemove.length > 0) summary.push(`remove ${toRemove.join(", ")}`);
  console.log(`  Reconciling policy presets on '${targetSandbox}': ${summary.join("; ")}`);

  const failed: string[] = [];
  for (const preset of toRemove) {
    if (OBSERVABILITY_POLICY_BINDING.matchesPreset(preset) && builtinObservabilityContent) {
      const removal = OBSERVABILITY_POLICY_BINDING.removeExact(
        targetSandbox,
        builtinObservabilityContent,
        policies,
        { knownBefore: builtinObservabilityState },
      );
      builtinObservabilityState = removal.after;
      if (removal.verifiedAbsent) {
        setRecordedBuiltinObservability(false);
      } else {
        // removePreset updates the registry on a reported success. Restore
        // attribution whenever exact absence was not proven so recovery does
        // not forget built-in policy that may still be live.
        setRecordedBuiltinObservability(true, true);
      }
      if (removal.failureDetail) failed.push(`${preset} (${removal.failureDetail})`);
      continue;
    }
    try {
      if (!policies.removePreset(targetSandbox, preset)) failed.push(`${preset} (remove failed)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${preset} (remove: ${message})`);
    }
  }
  for (const preset of toAdd) {
    try {
      if (!policies.applyPreset(targetSandbox, preset)) failed.push(`${preset} (apply failed)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${preset} (apply: ${message})`);
    }
  }
  if (failed.length > 0) {
    console.warn(`  Warning: could not reconcile preset(s): ${failed.join("; ")}`);
  }
}

function reconcileSnapshotCustomPolicies(
  targetSandbox: string,
  resolvedSnapshot: ReturnType<typeof sandboxState.getLatestBackup>,
): void {
  if (!resolvedSnapshot || !Array.isArray(resolvedSnapshot.customPolicies)) return;
  const snapshotCustom = resolvedSnapshot.customPolicies;
  const currentCustom = registry.getCustomPolicies(targetSandbox);
  const snapshotByName = new Map(snapshotCustom.map((entry) => [entry.name, entry]));
  const currentByName = new Map(currentCustom.map((entry) => [entry.name, entry]));
  const toRemove = currentCustom.filter((c) => !snapshotByName.has(c.name));
  const toAdd = snapshotCustom.filter((sp) => {
    const current = currentByName.get(sp.name);
    return !current || current.content !== sp.content || current.sourcePath !== sp.sourcePath;
  });
  if (toRemove.length === 0 && toAdd.length === 0) return;

  const summary: string[] = [];
  if (toAdd.length > 0) summary.push(`add ${toAdd.map((c) => c.name).join(", ")}`);
  if (toRemove.length > 0) summary.push(`remove ${toRemove.map((c) => c.name).join(", ")}`);
  console.log(`  Reconciling custom policies on '${targetSandbox}': ${summary.join("; ")}`);

  const failed: string[] = [];
  for (const entry of toRemove) {
    try {
      if (!policies.removePreset(targetSandbox, entry.name)) {
        failed.push(`${entry.name} (remove failed)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${entry.name} (remove: ${message})`);
    }
  }
  for (const entry of toAdd) {
    try {
      if (
        !policies.applyPresetContent(targetSandbox, entry.name, entry.content, {
          custom: { sourcePath: entry.sourcePath },
        })
      ) {
        failed.push(`${entry.name} (apply failed)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${entry.name} (apply: ${message})`);
    }
  }
  if (failed.length > 0) {
    console.warn(`  Warning: could not reconcile custom policy(ies): ${failed.join("; ")}`);
  }
}

async function runSnapshotRestore(
  sandboxName: string,
  request: Extract<SnapshotRequest, { kind: "restore" }>,
): Promise<void> {
  // `--to <dst>` restores the snapshot from sandboxName into a different
  // sandbox. If `dst` is not yet live, it is auto-created by cloning the
  // source sandbox's baked image. Without `--to`, restore targets
  // sandboxName itself
  const target = request.to ?? sandboxName;
  const targetSandbox =
    target === sandboxName ? sandboxName : validateName(target, "target sandbox name");
  const lockNames = targetSandbox === sandboxName ? [sandboxName] : [sandboxName, targetSandbox];
  const orderedNames = [...new Set(lockNames)].sort();
  const acquire = (index: number): Promise<void> =>
    index === orderedNames.length
      ? runSnapshotRestoreUnlocked(sandboxName, request, targetSandbox)
      : withSandboxMutationLock(orderedNames[index], () => acquire(index + 1));
  return acquire(0);
}

async function runSnapshotRestoreUnlocked(
  sandboxName: string,
  request: Extract<SnapshotRequest, { kind: "restore" }>,
  targetSandbox: string,
): Promise<void> {
  const sourceLiveNames = requireLiveSandboxesOnSandboxGateway(
    sandboxName,
    "  Failed to query live sandbox state from OpenShell.",
  );
  const isCrossSandboxRestore = targetSandbox !== sandboxName;
  let crossSandboxRestoreAgent: string | null = null;
  const targetEntry = isCrossSandboxRestore ? registry.getSandbox(targetSandbox) : null;
  const targetExists = sourceLiveNames.has(targetSandbox) || Boolean(targetEntry);
  if (targetEntry?.baselineExclusionTransition) {
    const transition = targetEntry.baselineExclusionTransition;
    console.error(
      `  Cannot replace destination '${targetSandbox}' while baseline policy '${transition.operation} ${transition.exclusion.key}' needs repair.`,
    );
    console.error(
      `  Re-run that policy command on '${targetSandbox}' before restoring into it with --force.`,
    );
    snapshotExit(1);
  }

  // #3756 P1 preflight: resolve the snapshot selector AND the source pod
  // image before any destructive action. A bad selector, missing snapshot,
  // or unresolvable source image must not be allowed to delete the
  // destination first and only fail afterwards.
  const selector = request.selector ?? null;
  let backupPath: string;
  let resolvedSnapshot: ReturnType<typeof sandboxState.getLatestBackup>;
  if (selector) {
    const { match } = sandboxState.findBackup(sandboxName, selector);
    if (!match) {
      console.error(`  No snapshot matching '${selector}' found for '${sandboxName}'.`);
      console.error("  Selector must be an exact version (v<N>), name, or timestamp.");
      console.error(`  Run: ${CLI_NAME} ${sandboxName} snapshot list`);
      snapshotExit(1);
    }
    backupPath = match.backupPath;
    resolvedSnapshot = match;
    const v = formatSnapshotVersion(match);
    const nameSuffix = match.name ? ` name=${match.name}` : "";
    console.log(`  Using snapshot ${v}${nameSuffix} (${match.timestamp})`);
  } else {
    const latest = sandboxState.getLatestBackup(sandboxName);
    if (!latest) {
      console.error(`  No snapshots found for '${sandboxName}'.`);
      snapshotExit(1);
    }
    backupPath = latest.backupPath;
    resolvedSnapshot = latest;
    const v = formatSnapshotVersion(latest);
    const nameSuffix = latest.name ? ` name=${latest.name}` : "";
    console.log(`  Using latest snapshot ${v}${nameSuffix} (${latest.timestamp})`);
  }

  if (!isCrossSandboxRestore) {
    // Self-restore: target is `sandboxName`. Cannot auto-create; the
    // source pod is the target, so it must already be live.
    if (!targetExists) {
      console.error(`  Sandbox '${targetSandbox}' is not running. Cannot restore snapshot.`);
      snapshotExit(1);
    }
  } else {
    // #3756: cross-sandbox restore into a destination that already exists
    // used to overlay onto the live filesystem silently. Refuse by default
    // *before* doing any source-side preflight, so the user sees the
    // precise "destination exists" error instead of a misleading
    // "source not found" or "cannot resolve image" message when both are
    // also broken.
    if (targetExists && !request.force) {
      console.error(`  Destination sandbox '${targetSandbox}' already exists.`);
      console.error(
        "  Restoring into an existing sandbox is unsupported because it would silently mutate its filesystem.",
      );
      console.error(
        `  Re-run with --force to delete '${targetSandbox}' and recreate it from the snapshot, or pick a different name.`,
      );
      snapshotExit(1);
    }
    // Cross-sandbox restore — whether dst exists (with --force) or not,
    // we must be able to clone the source's running pod image. Resolve it
    // upfront so a missing source / unresolvable image cannot delete the
    // destination first (#3756 P1).
    if (!sourceLiveNames.has(sandboxName)) {
      if (targetExists) {
        console.error(
          `  Cannot recreate '${targetSandbox}' from snapshot: source '${sandboxName}' not found.`,
        );
      } else {
        console.error(
          `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' not found.`,
        );
        console.error(`  Create '${targetSandbox}' manually with '${CLI_NAME} onboard'.`);
      }
      snapshotExit(1);
    }
    const srcEntry = registry.getSandbox(sandboxName) || { name: sandboxName };
    const fromImage = resolveSrcPodImage(sandboxName, srcEntry);
    if (!fromImage) {
      console.error(
        `  Cannot resolve image for source sandbox '${sandboxName}' — aborting before ` +
          (targetExists ? `deleting '${targetSandbox}'.` : `creating '${targetSandbox}'.`),
      );
      snapshotExit(1);
    }
    if (targetExists) {
      // --force confirmed above. Prompt for the destination name (unless
      // --yes or NEMOCLAW_NON_INTERACTIVE=1), then delete and recreate.
      const nonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE === "1";
      if (!request.yes && !nonInteractive) {
        const answer = (
          await askPrompt(
            `  This will DELETE sandbox '${targetSandbox}' and restore the snapshot into a fresh copy.\n` +
              `  Type '${targetSandbox}' to confirm: `,
          )
        ).trim();
        if (answer !== targetSandbox) {
          console.error("  Confirmation did not match — aborting.");
          snapshotExit(1);
        }
      }
    }
    const sourceGatewayName = resolveSandboxGatewayName(srcEntry);
    const createAndRegisterClone = async (): Promise<void> => {
      if (!targetExists && registry.getSandbox(targetSandbox)) {
        console.error(
          `  Destination sandbox '${targetSandbox}' was registered while this restore was waiting. Retry with --force only after reviewing that sandbox.`,
        );
        snapshotExit(1);
      }
      const lockedSourceEntry = registry.getSandbox(sandboxName);
      if (!lockedSourceEntry) {
        console.error(
          `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' has no durable inference route metadata.`,
        );
        snapshotExit(1);
      }
      crossSandboxRestoreAgent = lockedSourceEntry.agent || "openclaw";
      if (getSandboxEntryInference(lockedSourceEntry).kind !== "configured") {
        console.error(
          `  Cannot auto-create '${targetSandbox}': source '${sandboxName}' has no complete durable inference route.`,
        );
        snapshotExit(1);
      }
      const lockedFromImage = resolveSrcPodImage(sandboxName, lockedSourceEntry);
      if (!lockedFromImage) {
        console.error(
          `  Cannot resolve the current image for source sandbox '${sandboxName}' — aborting before changing '${targetSandbox}'.`,
        );
        snapshotExit(1);
      }
      const lockedGatewayName = resolveSandboxGatewayName(lockedSourceEntry);
      if (lockedGatewayName !== sourceGatewayName) {
        console.error(
          `  Source sandbox '${sandboxName}' changed OpenShell gateways while waiting to restore. Retry the command.`,
        );
        snapshotExit(1);
      }
      const compatibility = checkGatewayRouteCompatibility({
        gatewayName: sourceGatewayName,
        sandboxName: targetSandbox,
        route: lockedSourceEntry,
        sandboxes: registry.listSandboxes().sandboxes,
      });
      if (!compatibility.ok) {
        console.error(`  Error: ${formatGatewayRouteConflict(compatibility)}`);
        snapshotExit(1);
      }
      // Allocate the clone's dashboard port before any destructive action, so
      // dashboard-port-range exhaustion aborts before `deleteSandboxForRestore`
      // removes the existing `--force` destination — matching the pre-delete
      // validation the image and gateway-route checks above already do (#3756).
      const dstDashboardPort = allocateCloneDashboardPort(targetSandbox, lockedSourceEntry);
      const dashboardEnvArgs = resolveCloneDashboardEnvArgs(lockedSourceEntry, dstDashboardPort);
      let managedClone: PreparedManagedSnapshotClone | null;
      try {
        managedClone = await prepareManagedSnapshotClone(
          sandboxName,
          targetSandbox,
          lockedSourceEntry,
          lockedFromImage,
          dstDashboardPort,
          targetExists,
        );
      } catch (error) {
        console.error(
          `  Cannot prepare managed clone '${targetSandbox}': ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        console.error(
          `  Destination '${targetSandbox}' was not changed. Re-onboard the source before retrying this restore.`,
        );
        snapshotExit(1);
      }
      const clonePolicy = await prepareSnapshotClonePolicy(lockedSourceEntry);
      try {
        // Render and bound the complete argv before a forced restore can delete
        // the destination. Managed clone profile/CA transports therefore use
        // the same exec-safe argument gate as ordinary managed onboarding.
        const cloneLaunch = prepareSnapshotCloneLaunch(
          targetSandbox,
          lockedSourceEntry,
          lockedFromImage,
          clonePolicy.policyPath,
          dstDashboardPort,
          dashboardEnvArgs,
          managedClone,
        );
        // Keep the managed credential-provider graph lazy. Legacy/custom
        // snapshot operations must retain their narrow runtime and test seam.
        const managedProviderLifecycle = managedClone
          ? await import("./snapshot/managed-clone-providers")
          : null;
        let mutatedCredentialProviders: string[] = [];
        let cloneCreateAttempted = false;
        let stagedHermesBinding:
          | { readonly activationToken: string; readonly brokerToken: string }
          | undefined;
        let stagedHermesBroker: HermesToolGatewayCloneBroker | undefined;
        try {
          const hasHermesToolGateway = managedClone?.credentialProviders.some(
            (provider) => provider.source === "hermes-tool-gateway",
          );
          if (hasHermesToolGateway && managedClone) {
            // Recheck boot/control viability, then complete OAuth refresh and
            // agent-key mint into an identity-bound in-memory stage. Every
            // network/register failure therefore occurs before force deletion.
            stagedHermesBroker = getHermesToolGatewayCloneBroker();
            stagedHermesBroker.preflightHermesToolGatewayCloneBinding(targetSandbox);
            const refreshToken =
              managedClone.credentialEnvironment.NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN;
            if (!refreshToken) {
              throw new Error("Hermes destination refresh credential disappeared before staging");
            }
            stagedHermesBinding = stagedHermesBroker.stageHermesToolGatewayCloneBinding(
              targetSandbox,
              refreshToken,
            );
          }
          if (targetExists) {
            if (targetEntry) {
              verifyRestoreDestinationOnOwnGateway(targetSandbox);
            }
            deleteSandboxForRestore(targetSandbox);
            requireLiveSandboxesOnSandboxGateway(
              sandboxName,
              "  Failed to re-select source sandbox gateway after deleting destination.",
            );
          }
          mutatedCredentialProviders =
            managedProviderLifecycle?.provisionManagedCloneProviders(
              managedClone?.credentialProviders ?? [],
              {
                ...(managedClone
                  ? {
                      environment: {
                        ...process.env,
                        ...managedClone.credentialEnvironment,
                      },
                    }
                  : {}),
                runOpenshell,
                ...(targetExists ? { rollbackSandboxName: targetSandbox } : {}),
                ...(stagedHermesBinding === undefined ? {} : { stagedHermesBinding }),
              },
            ) ?? [];
          stagedHermesBinding = undefined;
          cloneCreateAttempted = true;
          await autoCreateSandboxFromSource(
            sandboxName,
            targetSandbox,
            lockedFromImage,
            cloneLaunch,
          );
          // The mutated providers are now attached to the successfully created
          // destination and owned by its rebound messaging plan.
          mutatedCredentialProviders = [];
        } catch (error) {
          if (stagedHermesBinding && stagedHermesBroker) {
            stagedHermesBroker.discardHermesToolGatewayCloneBinding(
              targetSandbox,
              stagedHermesBinding,
            );
          }
          if (cloneCreateAttempted) cleanupFailedSnapshotCloneTarget(targetSandbox);
          managedProviderLifecycle?.cleanupManagedCloneProviders(
            mutatedCredentialProviders,
            runOpenshell,
            targetSandbox,
          );
          throw error;
        }
      } finally {
        clonePolicy.cleanup?.();
      }
    };
    // Lock order is both sandbox names (sorted by the outer caller), host
    // dashboard, then gateway route. The host-wide lease stays held from port
    // selection until the clone is durably registered, including across
    // different gateways.
    await withDashboardPortReservationLock(() =>
      withGatewayRouteMutationLock(sourceGatewayName, createAndRegisterClone),
    );
  }
  withTimerBoundShieldsMutationLock(targetSandbox, "restore sandbox snapshot", () => {
    // Serialize filesystem restore, mutable-permission repair, and policy
    // reconciliation under the active timer generation. Normal auto-restore
    // waits; the absolute deadline may preempt this process and reclaim the
    // token, preventing policy/config mutation after lockdown resumes.
    if (targetSandbox !== sandboxName) {
      console.log(`  Restoring snapshot from '${sandboxName}' into '${targetSandbox}'...`);
    } else {
      console.log(`  Restoring snapshot into '${sandboxName}'...`);
    }
    const result = sandboxState.restoreSandboxState(targetSandbox, backupPath);
    if (result.success) {
      console.log(
        `  ${G}\u2713${R} Restored ${result.restoredDirs.length} directories, ${result.restoredFiles.length} files`,
      );
      printHermesGatewayRestoreHint(
        targetSandbox,
        registry.getSandbox(targetSandbox)?.agent,
        result.restoredFiles,
        resolvedSnapshot?.stateFiles ?? [],
      );
    } else {
      console.error(`  Restore failed.`);
      if (result.restoredDirs.length > 0) {
        console.error(`  Partial: ${result.restoredDirs.join(", ")}`);
      }
      if (result.failedDirs.length > 0) {
        console.error(`  Failed: ${result.failedDirs.join(", ")}`);
      }
      if (result.failedFiles.length > 0) {
        console.error(`  Failed files: ${result.failedFiles.join(", ")}`);
      }
      snapshotExit(1);
    }
    // Post-restore security-state reconciliation is best-effort by design: the
    // filesystem restore succeeded and old snapshots may target hosts where policy
    // providers or mutable-config repair are temporarily unavailable. Surface every
    // failure as a warning, but keep the restore result tied to state restoration.
    // #5027/#4538: openclaw.json restores via the generic copy strategy, which
    // lands it at 0640. Repair the mutable config contract when needed.
    repairRestoredOpenClawConfigPerms(targetSandbox, result);
    // Reconcile custom policy presets (applied via --from-file/--from-dir).
    // Skipped for legacy snapshots that predate the `customPolicies` field.
    reconcileSnapshotCustomPolicies(targetSandbox, resolvedSnapshot);
    // Reconcile built-in presets after custom content so same-name custom
    // policies are never transiently substituted with a built-in. The current
    // target observability bit and tier override historical built-in OTLP state.
    // Legacy snapshots skip unrelated generic presets but still reconcile the
    // managed observability binding from current target state.
    reconcileSnapshotPolicyPresets(targetSandbox, resolvedSnapshot);
  });
  if (isCrossSandboxRestore && crossSandboxRestoreAgent === "openclaw") {
    try {
      await establishRestoredSandboxGatewayPairing(targetSandbox);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new SnapshotCommandError([
        `State restored into '${targetSandbox}', but gateway pairing could not be verified.`,
        `Run \`${CLI_NAME} ${targetSandbox} connect\` to retry pairing before running an agent.`,
        `Details: ${detail}`,
      ]);
    }
  }
}

export async function runSandboxSnapshot(
  sandboxName: string,
  request: SnapshotRequest = { kind: "help" },
) {
  switch (request.kind) {
    case "create": {
      runSnapshotCreate(sandboxName, request);
      break;
    }
    case "list": {
      const backups = sandboxState.listBackups(sandboxName);
      if (backups.length === 0) {
        console.log(`  No snapshots found for '${sandboxName}'.`);
        return;
      }
      console.log(`  Snapshots for '${sandboxName}':`);
      console.log("");
      renderSnapshotTable(backups);
      console.log("");
      console.log(`  ${backups.length} snapshot(s). Restore with:`);
      console.log(`    ${CLI_NAME} ${sandboxName} snapshot restore [version|name|timestamp]`);
      break;
    }
    case "restore": {
      await runSnapshotRestore(sandboxName, request);
      break;
    }
    default:
      console.log(`  Usage:`);
      console.log(`    ${CLI_NAME} ${sandboxName} snapshot create [--name <name>]`);
      console.log(
        `                                             Create a snapshot (auto-versioned v1, v2, ...)`,
      );
      console.log(
        `    ${CLI_NAME} ${sandboxName} snapshot list            List available snapshots`,
      );
      console.log(
        `    ${CLI_NAME} ${sandboxName} snapshot restore [selector] [--to <dst>] [--force] [--yes|-y]`,
      );
      console.log(
        `                                             Restore by version (v1), name, or timestamp.`,
      );
      console.log(
        `                                             Omit selector to restore the most recent.`,
      );
      console.log(
        `                                             Use --to to restore into another sandbox; <dst> is auto-created if missing.`,
      );
      console.log(
        `                                             When <dst> already exists, pass --force to delete it and recreate from the snapshot (prompts unless --yes).`,
      );
      break;
  }
}
