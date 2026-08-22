// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dockerCapture } from "../../adapters/docker";
import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { formatFailedBackupItems } from "../../domain/backup-failure";
import { getSandboxDeleteOutcome } from "../../domain/sandbox/destroy";
import {
  HERMES_DASHBOARD_ENABLE_ENV,
  HERMES_DASHBOARD_INTERNAL_PORT_ENV,
  HERMES_DASHBOARD_PORT_ENV,
  HERMES_DASHBOARD_TUI_ENV,
} from "../../hermes-dashboard";
import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import * as nim from "../../inference/nim";
import { listMessagingProviderSuffixes } from "../../messaging/channels";
import {
  findAvailableDashboardPort,
  getRegistryOccupiedDashboardPorts,
  getRegistryOccupiedHermesApiPorts,
  withDashboardPortReservationLock,
} from "../../onboard/dashboard-port";
import { isValidForwardPort } from "../../onboard/dashboard-runtime";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import { findAvailableHermesApiPort, HERMES_API_PORT_ENV } from "../../onboard/hermes-api-port";
import { resolveHermesDashboardOnboardState } from "../../onboard/hermes-dashboard";
import {
  isDcodeAgent,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  OBSERVABILITY_POLICY_BINDING,
} from "../../onboard/observability-policy-presets";
import { normalizePolicyTierName } from "../../onboard/policy-tier-suppression";
import * as policies from "../../policy";
import { ROOT, run, shellQuote, validateName } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import { streamSandboxCreate } from "../../sandbox/create-stream";
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
import {
  cleanupShieldsDestroyArtifacts,
  removeSandboxRegistryEntryOutcome,
  requireSandboxDestructiveCleanupAuthority,
} from "./destroy";
import {
  establishRestoredSandboxGatewayPairing,
  waitForRestoredSandboxGatewaySupervisor,
} from "./restore-gateway-pairing";
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
  backupSandboxStateWithManagedAuthority,
  assertSandboxSnapshotCommandAvailable,
  confirmHostLocalInferenceAuthority,
  createSnapshotCloneLifecycle,
  confirmSandboxRuntimeRestore,
  fingerprintSandboxLiveIdentity,
  type PreparedHostLocalInferenceAuthority,
  type PreparedSandboxRuntimeRestore,
  prepareHostLocalInferenceAuthority,
  prepareManagedSnapshotProfileRestore,
  prepareSandboxHostLocalInferenceDestroyAuthority,
  prepareSandboxRuntimeRestore,
  readManagedSnapshotProfileAuthority,
  rejectManagedSnapshotCloneUntilRebind,
  requireCurrentSnapshotRuntimeProvider,
  retirePreparedHostLocalInferenceAuthority,
  type RuntimeProviderBundle,
} from "./snapshot/dependencies";
import { formatSnapshotBaselineExclusionSummary } from "./snapshot-baseline-exclusion-summary";
import { printHermesGatewayRestoreHint } from "./snapshot-hermes-gateway-hint";

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

function failUnregisteredSnapshotClone(sandboxName: string, gatewayName: string): never {
  throw new SnapshotCommandError([
    `  Sandbox '${sandboxName}' was created, but NemoClaw could not verify the same valid Ready identity from its owning gateway before registration.`,
    "  Snapshot state was not restored and the clone was not registered.",
    "  Remove the unregistered sandbox before retrying:",
    `    openshell sandbox delete -g ${shellQuote(gatewayName)} ${shellQuote(sandboxName)}`,
    "  Then rerun the original snapshot restore command.",
  ]);
}

function formatSnapshotVersion(b: unknown) {
  const snapshotVersion = (b as { snapshotVersion?: number }).snapshotVersion ?? 0;
  return `v${snapshotVersion}`;
}

export function requireSnapshotDestinationRegistryRemoval(
  name: string,
  removalOutcome: ReturnType<typeof removeSandboxRegistryEntryOutcome>,
): void {
  if (removalOutcome.status !== "blocked") return;
  // SOURCE_OF_TRUTH
  // Invalid state: a bypassing registry writer changed cleanup authority after
  // the locked pre-delete proof, leaving the destination absent while its
  // ownership row must be retained.
  // Source boundary: deleteSandboxForRestore proves provider/workload cleanup
  // authority under the destination lifecycle lock, then registry removal
  // rechecks that authority after the live delete.
  // Source-fix constraint: the current runtime API has no authenticated atomic
  // replace primitive and raw writers do not participate in NemoClaw's lock.
  // Regression proof: snapshot-restore-lifecycle.test.ts covers pre-delete
  // refusal; snapshot restore authority tests cover this retained-row stop.
  // Removal condition: an exact provider-native replace transaction supplies
  // durable delete, rollback, and cleanup receipts.
  console.error(
    `  Destination '${name}' is deleted, but local runtime ownership cleanup is incomplete.`,
  );
  console.error(
    "  The registry entry was preserved because provider/workload cleanup authority could not be proven.",
  );
  console.error(
    `  Run '${CLI_NAME} ${name} doctor --json'; restore trusted ownership metadata or resolve the runtime conflict, then retry. Do not rewrite a receipt to match a mutable name.`,
  );
  snapshotExit(1);
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

// Allocate the clone's own API port. The source owns the host forward for its
// port, and the sandbox exposes the API on the same number it is forwarded on,
// so a clone that inherits the source's port gets no inference forward, and its
// gateway restart never converges. Returns null for an agent that has no
// per-sandbox API port, so the clone's field stays unset. Callers must invoke
// this before any destructive step so range exhaustion aborts before the
// mutation.
function allocateCloneHermesApiPort(
  dstName: string,
  srcEntry: { name?: string; agent?: string | null },
): number | null {
  if (srcEntry.agent !== "hermes") return null;
  const forwards = captureOpenshell(["forward", "list"], { ignoreError: true });
  try {
    return findAvailableHermesApiPort(
      dstName,
      undefined,
      forwards.output || "",
      undefined,
      getRegistryOccupiedHermesApiPorts(dstName),
    );
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

async function prepareSnapshotClonePolicy(
  srcEntry: SandboxEntry,
  targetSandbox: string,
): Promise<{
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
    sandboxName: targetSandbox,
    baselineExclusions,
  });
}

// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Returns true on success; on failure, logs and throws SnapshotCommandError.
async function autoCreateSandboxFromSource(
  srcName: string,
  dstName: string,
  srcEntry: SandboxEntry | { name: string },
  sourceGatewayName: string,
  sourceGatewayPort: number,
  fromImage: string,
  createPolicyPath: string,
  dstDashboardPort: number | null,
  dashboardEnvArgs: readonly string[],
  dstHermesApiPort: number | null,
): Promise<void> {
  const cloneLifecycle = createSnapshotCloneLifecycle(
    dstName,
    sourceGatewayName,
    (sandboxName, gatewayName) => {
      const get = captureOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
        ignoreError: true,
      });
      const list = captureOpenshell(["sandbox", "list", "-g", gatewayName], {
        ignoreError: true,
      });
      return {
        state:
          get.status === 0 && list.status === 0 && isSandboxReady(list.output || "", sandboxName)
            ? ("ready" as const)
            : ("not_ready" as const),
        liveIdentityFingerprint:
          get.status === 0 ? fingerprintSandboxLiveIdentity(get.output || "") : null,
      };
    },
  );
  const openshellBin = getOpenshellBinary();
  const sourceObservabilityEnabled =
    (srcEntry as { observabilityEnabled?: boolean }).observabilityEnabled === true;
  const startupCommand = [
    "env",
    `NEMOCLAW_OBSERVABILITY=${sourceObservabilityEnabled ? "1" : "0"}`,
    ...dashboardEnvArgs,
    ...(dstHermesApiPort === null ? [] : [`${HERMES_API_PORT_ENV}=${dstHermesApiPort}`]),
    "nemoclaw-start",
  ];
  const createEnv = { ...process.env };
  delete createEnv.NEMOCLAW_OBSERVABILITY;
  let cloneHostLocalReservation: Pick<
    SandboxEntry,
    "hostLocalInferenceReceipt" | "hostLocalInferenceProvenance"
  > | null = null;
  const releaseCloneHostLocalReservation = (): void => {
    if (!cloneHostLocalReservation) return;
    const current = registry.getSandbox(dstName);
    if (
      current?.pendingRouteReservation === true &&
      current.hostLocalInferenceReceipt === cloneHostLocalReservation.hostLocalInferenceReceipt &&
      isDeepStrictEqual(
        current.hostLocalInferenceProvenance,
        cloneHostLocalReservation.hostLocalInferenceProvenance,
      )
    ) {
      registry.removeSandbox(dstName);
    }
    cloneHostLocalReservation = null;
  };

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
    "--",
    ...startupCommand,
  ];

  const sourceAuthority = srcEntry as SandboxEntry;
  if (sourceAuthority.hostLocalInferenceProvenance) {
    if (
      typeof sourceAuthority.hostLocalInferenceReceipt !== "string" ||
      typeof sourceAuthority.provider !== "string" ||
      typeof sourceAuthority.model !== "string" ||
      !isValidForwardPort(sourceAuthority.gatewayPort) ||
      typeof sourceAuthority.openshellDriver !== "string"
    ) {
      throw new SnapshotCommandError(
        "Source host-local inference lifecycle authority is incomplete.",
      );
    }
    const reserved = registry.reserveSandboxInferenceRoute(dstName, {
      provider: sourceAuthority.provider,
      model: sourceAuthority.model,
      endpointUrl: sourceAuthority.endpointUrl ?? null,
      endpointSource: sourceAuthority.endpointSource ?? null,
      credentialEnv: sourceAuthority.credentialEnv ?? null,
      preferredInferenceApi: sourceAuthority.preferredInferenceApi ?? null,
      gatewayName: sourceGatewayName,
      gatewayPort: sourceAuthority.gatewayPort,
      openshellDriver: sourceAuthority.openshellDriver,
      hostLocalInferenceReceipt: sourceAuthority.hostLocalInferenceReceipt,
      hostLocalInferenceProvenance: sourceAuthority.hostLocalInferenceProvenance,
    });
    if (!reserved) {
      throw new SnapshotCommandError(
        "Could not reserve the clone's exact host-local inference authority.",
      );
    }
    cloneHostLocalReservation = {
      hostLocalInferenceReceipt: sourceAuthority.hostLocalInferenceReceipt,
      hostLocalInferenceProvenance: sourceAuthority.hostLocalInferenceProvenance,
    };
  }

  console.log(`  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`);

  let createResult: Awaited<ReturnType<typeof streamSandboxCreate>>;
  try {
    createResult = await streamSandboxCreate(command, commandArgs, createEnv, {
      // Use a pre-built image, so skip build+push and jump to pod creation.
      initialPhase: "create",
      // Wait until the sandbox actually reaches Ready state, not just appears in the list.
      readyCheck: () => {
        const list = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
          ignoreError: true,
        });
        if (list.status !== 0) return false;
        return isSandboxReady(list.output || "", dstName);
      },
    });
  } catch (error) {
    releaseCloneHostLocalReservation();
    throw error;
  }

  if (createResult.status !== 0 && !createResult.forcedReady) {
    releaseCloneHostLocalReservation();
    console.error(`  Failed to create sandbox '${dstName}' (exit ${createResult.status}).`);
    const tail = (createResult.output || "").slice(-600);
    if (tail) console.error(tail);
    snapshotExit(1);
  }

  // Double-check Ready after stream exit.
  const verify = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
    ignoreError: true,
  });
  if (verify.status !== 0 || !isSandboxReady(verify.output || "", dstName)) {
    releaseCloneHostLocalReservation();
    failUnregisteredSnapshotClone(dstName, sourceGatewayName);
  }
  let lifecycleRegistration: ReturnType<typeof cloneLifecycle.capture>;
  try {
    lifecycleRegistration = cloneLifecycle.capture();
  } catch {
    releaseCloneHostLocalReservation();
    failUnregisteredSnapshotClone(dstName, sourceGatewayName);
  }

  // DNS proxy is only meaningful for the kubernetes driver (matches onboard.ts).
  const dnsScript = path.join(ROOT, "scripts", "setup-dns-proxy.sh");
  const srcDriver = (srcEntry as { openshellDriver?: string | null }).openshellDriver;
  if (srcDriver === "kubernetes" && fs.existsSync(dnsScript)) {
    const srcGatewayName = resolveSandboxGatewayName(
      srcEntry as { gatewayName?: string | null; gatewayPort?: number | null },
    );
    run(["bash", dnsScript, srcGatewayName, dstName], { ignoreError: true });
  }

  // Register dst in the NemoClaw registry, cloning most fields from src.
  // Policies are cleared here — the caller replays them from the snapshot
  // manifest after the restore succeeds and writes them back into this entry.
  let finalLifecycleRegistration: ReturnType<typeof cloneLifecycle.revalidate>;
  try {
    finalLifecycleRegistration = cloneLifecycle.revalidate(lifecycleRegistration);
  } catch {
    releaseCloneHostLocalReservation();
    failUnregisteredSnapshotClone(dstName, sourceGatewayName);
  }
  try {
    registry.registerSandbox({
      ...srcEntry,
      name: dstName,
      createdAt: new Date().toISOString(),
      policies: [],
      observabilityEnabled: sourceObservabilityEnabled,
      // dst has its own lifecycle; don't inherit src's local NIM container
      // reference, or destroying dst would stop src's NIM.
      nimContainer: null,
      // No CUDA proof has run for dst (this auto-create path passes no GPU flags),
      // so clear src's proof rather than inheriting it — otherwise dst could show
      // `Sandbox GPU: enabled (CUDA verified)` based on another sandbox's run (#4231).
      sandboxGpuProof: null,
      dashboardPort: dstDashboardPort,
      // The spread above carries the source's API port; the clone owns its own.
      hermesApiPort: dstHermesApiPort,
      // The shared image keeps Hermes' image-baked internal listener port, but
      // the public WebUI port is a per-sandbox host resource and must follow the
      // clone's newly allocated dashboard port so rebuild validation converges.
      hermesDashboardPort:
        (srcEntry as SandboxEntry).hermesDashboardEnabled === true
          ? dstDashboardPort
          : (srcEntry as SandboxEntry).hermesDashboardPort,
      // A legacy source may have only a gateway name (or neither binding
      // field). Register the new clone with the complete canonical binding so
      // stop/start, recovery, and later snapshots can address its gateway.
      gatewayName: sourceGatewayName,
      gatewayPort: sourceGatewayPort,
      ...finalLifecycleRegistration,
    });
    cloneHostLocalReservation = null;
  } catch {
    releaseCloneHostLocalReservation();
    failUnregisteredSnapshotClone(dstName, sourceGatewayName);
  }

  const sourceAgent = (srcEntry as SandboxEntry).agent || "openclaw";
  if (sourceAgent === "openclaw" && !waitForRestoredSandboxGatewaySupervisor(dstName)) {
    console.error(
      `  Sandbox '${dstName}' reached OpenShell Ready, but its managed OpenClaw supervisor did not become ready.`,
    );
    console.error("  Snapshot state was not restored into the incomplete clone.");
    snapshotExit(1);
  }

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
  withTimerBoundShieldsMutationLock(name, "delete snapshot restore destination", () => {
    const sbMeta = registry.getSandbox(name);
    if (!sbMeta) {
      console.error(
        `  Cannot delete destination '${name}': its durable runtime ownership entry disappeared.`,
      );
      snapshotExit(1);
    }
    let runtimeProvider: RuntimeProviderBundle;
    let hostLocalInferenceAuthority: PreparedHostLocalInferenceAuthority | null;
    try {
      runtimeProvider = requireSandboxDestructiveCleanupAuthority(name, sbMeta).provider;
      hostLocalInferenceAuthority = prepareSandboxHostLocalInferenceDestroyAuthority(
        runtimeProvider,
        sbMeta,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `  Cannot delete destination '${name}' because runtime cleanup authority is unproven: ${detail}`,
      );
      console.error(
        `  Run '${CLI_NAME} ${name} doctor --json' and resolve the recorded ownership conflict before retrying.`,
      );
      snapshotExit(1);
    }
    if (!hostLocalInferenceAuthority) {
      if (sbMeta.nimContainer) {
        nim.stopNimContainerByName(sbMeta.nimContainer);
      } else {
        nim.stopNimContainer(name, { silent: true });
      }
    }
    console.log(`  Deleting existing destination '${name}' before restore...`);
    if (readTimerMarker(name)) {
      shields.shieldsUp(name, {
        throwOnError: true,
        allowLegacyHermesProtocol: true,
      });
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
    if (hostLocalInferenceAuthority) {
      try {
        const current = registry.getSandbox(name);
        if (!current) throw new Error(`sandbox '${name}' is no longer registered`);
        retirePreparedHostLocalInferenceAuthority(
          runtimeProvider,
          current,
          hostLocalInferenceAuthority,
          registry.listSandboxes().sandboxes,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(
          `  Destination '${name}' is gone, but its host-local inference cleanup failed: ${detail}`,
        );
        console.error("  Local ownership state was preserved; retry the restore to reconcile it.");
        snapshotExit(1);
      }
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
    for (const suffix of listMessagingProviderSuffixes()) {
      runOpenshell(["provider", "delete", `${name}${suffix}`], {
        ignoreError: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    cleanupShieldsDestroyArtifacts(name);
    requireSnapshotDestinationRegistryRemoval(name, removeSandboxRegistryEntryOutcome(name));
  });
  console.log(`  ${G}\u2713${R} '${name}' deleted`);
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

function removeIncompleteSnapshot(sandboxName: string, backupPath: string): void {
  const removal = sandboxState.removeIncompleteSnapshot(backupPath);
  if (removal.removed) {
    console.error("  Removed the incomplete snapshot.");
    return;
  }
  console.error(
    `  The incomplete snapshot at '${backupPath}' could not be removed: ${removal.error}`,
  );
  console.error(
    `  It is listed by \`${CLI_NAME} ${sandboxName} snapshot list\`. Remove it before the next restore.`,
  );
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
    // Keep the shields check and backup in one timer-bound interval. At the
    // absolute deadline, auto-restore closes the outer lifecycle gate and waits
    // for this exact owner to finish before changing policy or config.
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
    const result = backupSandboxStateWithManagedAuthority(
      sandboxName,
      {
        name: request.name ?? null,
      },
      { getSandbox: registry.getSandbox },
    );
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
    const incompletePath = result.manifest?.backupPath;
    if (incompletePath) {
      removeIncompleteSnapshot(sandboxName, incompletePath);
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
        { knownBefore: builtinObservabilityState, removeOptions: { nonFatal: true } },
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
      // Post-restore policy reconciliation is best-effort by design: a failed
      // gateway policy mutation must be reported as a warning, not terminate
      // the restore before gateway pairing. Pass nonFatal so setPolicyFile
      // returns false on failure instead of exiting the process (#8210).
      if (!policies.removePreset(targetSandbox, preset, { nonFatal: true }))
        failed.push(`${preset} (remove failed)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${preset} (remove: ${message})`);
    }
  }
  for (const preset of toAdd) {
    try {
      if (!policies.applyPreset(targetSandbox, preset, { nonFatal: true }))
        failed.push(`${preset} (apply failed)`);
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
    return (
      !current ||
      current.content !== sp.content ||
      current.sourcePath !== sp.sourcePath ||
      current.trustedPrivatePins?.contentDigest !== sp.trustedPrivatePins?.contentDigest
    );
  });
  if (toRemove.length === 0 && toAdd.length === 0) return;

  const summary: string[] = [];
  if (toAdd.length > 0) summary.push(`add ${toAdd.map((c) => c.name).join(", ")}`);
  if (toRemove.length > 0) summary.push(`remove ${toRemove.map((c) => c.name).join(", ")}`);
  console.log(`  Reconciling custom policies on '${targetSandbox}': ${summary.join("; ")}`);

  const failed: string[] = [];
  for (const entry of toRemove) {
    try {
      // Best-effort like the built-in preset reconciliation above (#8210).
      if (!policies.removePreset(targetSandbox, entry.name, { nonFatal: true })) {
        failed.push(`${entry.name} (remove failed)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`${entry.name} (remove: ${message})`);
    }
  }
  for (const entry of toAdd) {
    try {
      const currentAuthority = currentByName.get(entry.name);
      const trustedPrivatePinCapability =
        currentAuthority?.content === entry.content && currentAuthority.trustedPrivatePins
          ? policies.replayTrustedPrivatePolicyPinCapability(
              currentAuthority.content,
              currentAuthority.trustedPrivatePins,
            )
          : undefined;
      if (
        !policies.applyPresetContent(targetSandbox, entry.name, entry.content, {
          custom: {
            sourcePath: entry.sourcePath,
            ...(trustedPrivatePinCapability ? { trustedPrivatePinCapability } : {}),
          },
          nonFatal: true,
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

function readCurrentManagedSnapshotProfileAuthority(entry: SandboxEntry | null) {
  return entry
    ? readManagedSnapshotProfileAuthority({
        sandboxName: entry.name,
        agentType: entry.agent ?? "",
        imageTag: entry.imageTag,
        fromDockerfile: entry.fromDockerfile,
        workload: entry.workload,
      })
    : null;
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
  assertSandboxSnapshotCommandAvailable(sandboxName, "sandbox:snapshot:restore");
  if (targetSandbox !== sandboxName) {
    assertSandboxSnapshotCommandAvailable(targetSandbox, "sandbox:snapshot:restore");
  }
  const orderedNames = [...new Set(lockNames)].sort();
  const acquire = (index: number): Promise<void> =>
    index === orderedNames.length
      ? Promise.resolve().then(() => {
          assertSandboxSnapshotCommandAvailable(sandboxName, "sandbox:snapshot:restore");
          if (targetSandbox !== sandboxName) {
            assertSandboxSnapshotCommandAvailable(targetSandbox, "sandbox:snapshot:restore");
          }
          return runSnapshotRestoreUnlocked(sandboxName, request, targetSandbox);
        })
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

  const snapshotProfileSource = {
    sandboxName,
    agentType: resolvedSnapshot.agentType,
    workload: resolvedSnapshot.workload,
  };
  const currentSourceEntry = registry.getSandbox(sandboxName);
  let hasManagedProfileAuthority = false;
  const hostLocalInferenceReceipt = resolvedSnapshot.hostLocalInferenceReceipt;
  const hostLocalInferenceProvenance = resolvedSnapshot.hostLocalInferenceProvenance;
  let snapshotRestoreAuthority: sandboxState.SnapshotRestoreAuthority | null = null;
  try {
    const snapshotAuthority = readManagedSnapshotProfileAuthority(snapshotProfileSource);
    hasManagedProfileAuthority = snapshotAuthority !== null;
    if (hasManagedProfileAuthority && !resolvedSnapshot.runtimeSnapshot) {
      throw new Error("managed snapshot is missing provider runtime authority");
    }
    const currentSourceAuthority = readCurrentManagedSnapshotProfileAuthority(currentSourceEntry);
    const currentTargetAuthority =
      targetEntry && targetEntry !== currentSourceEntry
        ? readCurrentManagedSnapshotProfileAuthority(targetEntry)
        : currentSourceAuthority;
    if (!hasManagedProfileAuthority && (currentSourceAuthority || currentTargetAuthority)) {
      throw new Error(
        "legacy snapshot lacks managed workload and provider runtime authority required by the current source or destination",
      );
    }
    if (isCrossSandboxRestore && hasManagedProfileAuthority) {
      rejectManagedSnapshotCloneUntilRebind(snapshotProfileSource, targetSandbox);
    }
    if (typeof hostLocalInferenceReceipt === "string") {
      if (!currentSourceEntry) {
        throw new Error("host-local inference snapshot source is no longer registered");
      }
      if (
        !isDeepStrictEqual(
          currentSourceEntry.hostLocalInferenceProvenance,
          hostLocalInferenceProvenance,
        )
      ) {
        throw new Error("snapshot inference provenance differs from the registered source");
      }
      const sourceProvider = requireCurrentSnapshotRuntimeProvider(currentSourceEntry);
      const preparedSource = prepareHostLocalInferenceAuthority(
        sourceProvider,
        currentSourceEntry,
        hostLocalInferenceReceipt,
      );
      if (!preparedSource) {
        throw new Error("snapshot inference receipt has no common lifecycle authority");
      }
    }
    if (hasManagedProfileAuthority || typeof hostLocalInferenceReceipt === "string") {
      snapshotRestoreAuthority = sandboxState.captureSnapshotRestoreAuthority(
        backupPath,
        resolvedSnapshot,
      );
      if (!snapshotRestoreAuthority) {
        throw new Error("selected snapshot content changed during restore preflight");
      }
    }
  } catch (error) {
    console.error(
      `  Cannot restore provider snapshot authority: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    );
    console.error(`  Destination '${targetSandbox}' was not changed.`);
    snapshotExit(1);
  }

  let preparedRuntimeRestore: PreparedSandboxRuntimeRestore | null = null;
  let preparedHostLocalInferenceRestore: PreparedHostLocalInferenceAuthority | null = null;
  if (!isCrossSandboxRestore) {
    // Self-restore: target is `sandboxName`. Cannot auto-create; the
    // source pod is the target, so it must already be live.
    if (!targetExists) {
      console.error(`  Sandbox '${targetSandbox}' is not running. Cannot restore snapshot.`);
      snapshotExit(1);
    }
    if (hasManagedProfileAuthority) {
      const currentTarget = registry.getSandbox(targetSandbox);
      if (!currentTarget || !resolvedSnapshot.runtimeSnapshot) {
        console.error(
          `  Cannot restore managed snapshot '${sandboxName}': target or provider runtime authority is missing.`,
        );
        snapshotExit(1);
      }
      try {
        const provider = requireCurrentSnapshotRuntimeProvider(currentTarget);
        const profileRestore = prepareManagedSnapshotProfileRestore(
          snapshotProfileSource,
          currentTarget,
          provider,
        );
        if (!profileRestore) {
          throw new Error("managed profile restore authority is missing");
        }
        preparedRuntimeRestore = prepareSandboxRuntimeRestore(
          provider,
          currentTarget,
          resolvedSnapshot.runtimeSnapshot,
          profileRestore.providerRestoreAuthority,
        );
      } catch (error) {
        console.error(
          `  Cannot preflight managed snapshot restore: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        snapshotExit(1);
      }
    }
    if (typeof hostLocalInferenceReceipt === "string") {
      const currentTarget = registry.getSandbox(targetSandbox);
      if (!currentTarget) {
        console.error(
          `  Cannot restore host-local inference snapshot '${sandboxName}': target authority is missing.`,
        );
        snapshotExit(1);
      }
      try {
        const provider = requireCurrentSnapshotRuntimeProvider(currentTarget);
        preparedHostLocalInferenceRestore = prepareHostLocalInferenceAuthority(
          provider,
          currentTarget,
          hostLocalInferenceReceipt,
        );
        if (!preparedHostLocalInferenceRestore) {
          throw new Error("snapshot inference receipt has no common lifecycle authority");
        }
      } catch (error) {
        console.error(
          `  Cannot preflight host-local inference snapshot restore: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        snapshotExit(1);
      }
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
    // Cross-sandbox restore — whether dst exists (with --force) or not, we
    // must be able to clone the source's image. Resolve it upfront so a
    // missing source / unresolvable image cannot delete the destination first
    // (#3756 P1). A source that is no longer running stays restorable while
    // its registry entry still records the image and inference route, because
    // that is the case a replacement sandbox exists to recover from.
    const srcEntry = registry.getSandbox(sandboxName) || { name: sandboxName };
    const fromImage = resolveSrcPodImage(sandboxName, srcEntry);
    if (!fromImage) {
      if (!sourceLiveNames.has(sandboxName)) {
        console.error(
          `  Cannot ${targetExists ? "recreate" : "auto-create"} '${targetSandbox}': source '${sandboxName}' is not running and its registry entry records no image.`,
        );
        console.error(`  Create '${targetSandbox}' manually with '${CLI_NAME} onboard'.`);
      } else {
        console.error(
          `  Cannot resolve image for source sandbox '${sandboxName}' — aborting before ` +
            (targetExists ? `deleting '${targetSandbox}'.` : `creating '${targetSandbox}'.`),
        );
      }
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
      const lockedGatewayPort = resolveGatewayPortFromName(lockedGatewayName);
      if (lockedGatewayPort === null) {
        console.error(
          `  Cannot resolve the gateway port for source sandbox '${sandboxName}' — aborting before changing '${targetSandbox}'.`,
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
      const dstHermesApiPort = allocateCloneHermesApiPort(targetSandbox, lockedSourceEntry);
      const dashboardEnvArgs = resolveCloneDashboardEnvArgs(lockedSourceEntry, dstDashboardPort);
      const clonePolicy = await prepareSnapshotClonePolicy(lockedSourceEntry, targetSandbox);
      try {
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
        await autoCreateSandboxFromSource(
          sandboxName,
          targetSandbox,
          lockedSourceEntry,
          lockedGatewayName,
          lockedGatewayPort,
          lockedFromImage,
          clonePolicy.policyPath,
          dstDashboardPort,
          dashboardEnvArgs,
          dstHermesApiPort,
        );
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
    if (typeof hostLocalInferenceReceipt === "string") {
      const currentTarget = registry.getSandbox(targetSandbox);
      if (!currentTarget) {
        console.error(
          `  Clone '${targetSandbox}' was created without durable host-local inference authority.`,
        );
        snapshotExit(1);
      }
      try {
        const provider = requireCurrentSnapshotRuntimeProvider(currentTarget);
        preparedHostLocalInferenceRestore = prepareHostLocalInferenceAuthority(
          provider,
          currentTarget,
          hostLocalInferenceReceipt,
        );
        if (!preparedHostLocalInferenceRestore) {
          throw new Error("snapshot inference receipt has no common lifecycle authority");
        }
      } catch (error) {
        console.error(
          `  Cannot re-prove clone '${targetSandbox}' against snapshot inference authority: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
        console.error(
          `  Removing incomplete clone '${targetSandbox}' while its exact provider ownership is still registered.`,
        );
        deleteSandboxForRestore(targetSandbox);
        snapshotExit(1);
      }
    }
  }
  withTimerBoundShieldsMutationLock(targetSandbox, "restore sandbox snapshot", () => {
    // Serialize filesystem restore, mutable-permission repair, and policy
    // reconciliation under the active timer generation. At the absolute
    // deadline, auto-restore keeps the outer lifecycle gate closed and waits
    // for this exact owner to finish before restoring lockdown.
    const validateProviderRestoreBeforeMutation =
      preparedRuntimeRestore || preparedHostLocalInferenceRestore
        ? () => {
            const currentTarget = registry.getSandbox(targetSandbox);
            if (!currentTarget) {
              throw new Error(`target '${targetSandbox}' is no longer registered`);
            }
            const provider = requireCurrentSnapshotRuntimeProvider(currentTarget);
            if (preparedRuntimeRestore) {
              const profileRestore = prepareManagedSnapshotProfileRestore(
                snapshotProfileSource,
                currentTarget,
                provider,
              );
              if (!profileRestore) {
                throw new Error("managed profile restore authority is missing");
              }
              const prepared = preparedRuntimeRestore;
              if (!prepared) throw new Error("managed runtime restore authority is missing");
              // The state layer invokes this after local tar staging and
              // immediately before its first remote filesystem mutation.
              preparedRuntimeRestore = prepareSandboxRuntimeRestore(
                provider,
                currentTarget,
                prepared.source,
                profileRestore.providerRestoreAuthority,
              );
            }
            if (typeof hostLocalInferenceReceipt === "string") {
              if (!preparedHostLocalInferenceRestore) {
                throw new Error("host-local inference restore authority is missing");
              }
              confirmHostLocalInferenceAuthority(
                provider,
                currentTarget,
                preparedHostLocalInferenceRestore,
              );
            }
          }
        : null;
    if (targetSandbox !== sandboxName) {
      console.log(`  Restoring snapshot from '${sandboxName}' into '${targetSandbox}'...`);
    } else {
      console.log(`  Restoring snapshot into '${sandboxName}'...`);
    }
    if (Boolean(snapshotRestoreAuthority) !== Boolean(validateProviderRestoreBeforeMutation)) {
      console.error(
        `  Cannot restore provider snapshot '${sandboxName}': content authority and the runtime mutation fence must both be present.`,
      );
      console.error(`  Destination '${targetSandbox}' was not changed.`);
      snapshotExit(1);
    }
    const result =
      snapshotRestoreAuthority && validateProviderRestoreBeforeMutation
        ? sandboxState.restoreSandboxState(targetSandbox, backupPath, {
            authority: snapshotRestoreAuthority,
            validateBeforeMutation: validateProviderRestoreBeforeMutation,
          })
        : sandboxState.restoreSandboxState(targetSandbox, backupPath);
    if (result.success) {
      if (preparedRuntimeRestore || preparedHostLocalInferenceRestore) {
        const currentTarget = registry.getSandbox(targetSandbox);
        if (!currentTarget) {
          console.error(
            `  Provider snapshot state was restored, but target '${targetSandbox}' is no longer registered.`,
          );
          snapshotExit(1);
        }
        try {
          const provider = requireCurrentSnapshotRuntimeProvider(currentTarget);
          if (preparedRuntimeRestore) {
            confirmSandboxRuntimeRestore(provider, currentTarget, preparedRuntimeRestore);
          }
          if (preparedHostLocalInferenceRestore) {
            confirmHostLocalInferenceAuthority(
              provider,
              currentTarget,
              preparedHostLocalInferenceRestore,
            );
          }
        } catch (error) {
          console.error(
            `  Provider snapshot state was restored, but provider restore proof failed: ${
              error instanceof Error ? error.message : String(error)
            }.`,
          );
          console.error("  Retry this exact snapshot after the runtime provider stabilizes.");
          snapshotExit(1);
        }
      }
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
      if (result.error) {
        console.error(`  Reason: ${result.error}`);
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
      assertSandboxSnapshotCommandAvailable(sandboxName, "sandbox:snapshot:create");
      await withSandboxMutationLock(sandboxName, () => {
        assertSandboxSnapshotCommandAvailable(sandboxName, "sandbox:snapshot:create");
        return runSnapshotCreate(sandboxName, request);
      });
      break;
    }
    case "list": {
      await withSandboxMutationLock(sandboxName, () => {
        assertSandboxSnapshotCommandAvailable(sandboxName, "sandbox:snapshot:list");
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
      });
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
