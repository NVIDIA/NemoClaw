// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dockerCapture } from "../../adapters/docker";
import {
  namedOpenShellGateway,
  cliOpenShellSandboxPolicyReader,
} from "../../adapters/openshell/sandbox-policy-cli";
import {
  captureOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import {
  createCliOpenShellSandboxLifecycleFromRunner,
  createCliOpenShellSandboxLookupFromRunner,
  sleepOpenShellLifecycleMs,
  waitForSandboxDeleteAbsence,
} from "../../adapters/openshell/sandbox-lifecycle-cli";
import {
  fingerprintOpenShellSandboxId,
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  observeCreatedOpenShellSandboxId,
  settleCreatedOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import { formatFailedBackupItems } from "../../domain/backup-failure";
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
import { deleteSandboxProviderRegistrations } from "../../onboard/sandbox-provider-cleanup";
import { withDashboardPortReservationLock } from "../../onboard/dashboard-port";
import { isValidForwardPort } from "../../onboard/dashboard-runtime";
import {
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "../../onboard/gateway-binding";
import { resolveHermesDashboardOnboardState } from "../../onboard/hermes-dashboard";
import {
  cleanupTempDir,
  createExactTempFileCleanup,
  secureTempFile,
} from "../../onboard/temp-files";
import { ROOT, run, shellQuote, validateName } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import { repairMutableConfigPerms } from "../../sandbox/mutable-config-perms";
import { isSandboxReady } from "../../state/gateway";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../state/mcp-lifecycle-lock-acquisition";
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
  removeSandboxRegistryEntryOutcome,
  requireSandboxDestructiveCleanupAuthority,
} from "./destroy";
import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";
import {
  buildSandboxExecMarkedCommand,
  createSandboxExecMarker,
  extractSandboxExecCommandStdoutFromStreams,
} from "../../adapters/sandbox/sandbox-exec-output";
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
  isSandboxPolicyCredentialFree,
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
import {
  allocateSnapshotCloneForwardPorts,
  snapshotCloneHermesApiEnvArgs,
} from "./snapshot/forward-port-allocation";
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

function failUnregisteredSnapshotClone(
  sandboxName: string,
  gatewayName: string,
  ambiguousCreateAttemptNonce?: string,
): never {
  if (ambiguousCreateAttemptNonce) {
    throw new SnapshotCommandError([
      `  OpenShell did not confirm whether sandbox '${sandboxName}' was created, and NemoClaw could not reconcile one exact Ready identity.`,
      `  Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${ambiguousCreateAttemptNonce}`,
      "  Snapshot state was not restored. The exact route and create-attempt record remain protected.",
      "  Do not submit another create attempt until OpenShell confirms this labelled sandbox is absent or identifies the retained sandbox for cleanup.",
      `  Inspect: openshell sandbox list -g ${shellQuote(gatewayName)} --selector ${shellQuote(`${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${ambiguousCreateAttemptNonce}`)} --output json`,
    ]);
  }
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
  _targetSandbox: string,
): Promise<{
  policyPath: string;
  cleanup?: () => boolean;
}> {
  const gatewayName = resolveSandboxGatewayName(srcEntry);
  const policyRead = await cliOpenShellSandboxPolicyReader.readSandboxPolicy({
    target: namedOpenShellGateway(gatewayName),
    sandboxName: srcEntry.name,
    scope: "base",
  });
  if (!policyRead.ok) {
    throw new SnapshotCommandError([
      `Cannot read the live OpenShell policy for source sandbox '${srcEntry.name}'.`,
      policyRead.error.message,
      "Restore access to the source sandbox's OpenShell gateway, then retry the original snapshot restore command.",
    ]);
  }
  const policy = policyRead.value.document;
  if (!isSandboxPolicyCredentialFree(policy)) {
    throw new SnapshotCommandError([
      `Cannot prepare a snapshot clone policy for source sandbox '${srcEntry.name}' because its live OpenShell policy contains a literal credential value.`,
      "Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry the original snapshot restore command.",
    ]);
  }
  const policyPath = secureTempFile("nemoclaw-clone-policy", ".yaml");
  try {
    fs.writeFileSync(policyPath, policy, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return {
      policyPath,
      cleanup: createExactTempFileCleanup(policyPath, "nemoclaw-clone-policy"),
    };
  } catch (error) {
    cleanupTempDir(policyPath, "nemoclaw-clone-policy");
    throw error;
  }
}

// Used by `snapshot restore --to <dst>` when dst does not exist yet: reuses
// the source's baked image so the user does not have to re-run onboarding.
// Leaves a verified pending registration on success. The caller publishes it
// only after the clone-policy handoff file has been securely removed.
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
): Promise<SandboxEntry> {
  const openshellBin = getOpenshellBinary();
  const createAttemptNonce = randomBytes(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH / 2).toString(
    "hex",
  );
  let createdSandboxId: string | null = null;
  const captureCreatedIdentity = (args: string[], options?: Record<string, unknown>): string => {
    const result = captureOpenshell(args, {
      ...options,
      openshellBinary: openshellBin,
      ignoreError: true,
    });
    if (result.status !== 0) {
      throw new Error(`Command failed with status ${String(result.status ?? 1)}`);
    }
    return result.output || "";
  };
  const bindCreatedSandboxId = (sandboxId: string): string => {
    if (createdSandboxId && createdSandboxId !== sandboxId) {
      throw new Error("OpenShell create-attempt identity changed before clone registration.");
    }
    createdSandboxId = sandboxId;
    return sandboxId;
  };
  const settleCreatedSandboxId = (): string =>
    bindCreatedSandboxId(
      settleCreatedOpenShellSandboxId({
        sandboxName: dstName,
        gatewayName: sourceGatewayName,
        createAttemptNonce,
        runCaptureOpenshell: captureCreatedIdentity,
        priorSandboxId: createdSandboxId,
        sleep: sleepOpenShellLifecycleMs,
      }),
    );
  const observeCreatedClone = () => {
    const list = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
      ignoreError: true,
      openshellBinary: openshellBin,
    });
    const observation = observeCreatedOpenShellSandboxId(
      {
        sandboxName: dstName,
        gatewayName: sourceGatewayName,
        createAttemptNonce,
        runCaptureOpenshell: captureCreatedIdentity,
      },
      OPENSHELL_PROBE_TIMEOUT_MS,
    );
    if (observation.state !== "matched") {
      return {
        state: "not_ready" as const,
        liveIdentityFingerprint: null,
      };
    }
    const sandboxId = bindCreatedSandboxId(observation.sandboxId);
    return {
      state:
        list.status === 0 && isSandboxReady(list.output || "", dstName)
          ? ("ready" as const)
          : ("not_ready" as const),
      liveIdentityFingerprint: fingerprintOpenShellSandboxId(sandboxId),
    };
  };
  const cloneLifecycle = createSnapshotCloneLifecycle(
    dstName,
    sourceGatewayName,
    observeCreatedClone,
  );
  const sourceObservabilityEnabled =
    (srcEntry as { observabilityEnabled?: boolean }).observabilityEnabled === true;
  const startupCommand = [
    "env",
    `NEMOCLAW_OBSERVABILITY=${sourceObservabilityEnabled ? "1" : "0"}`,
    ...dashboardEnvArgs,
    ...snapshotCloneHermesApiEnvArgs(dstHermesApiPort),
    "nemoclaw-start",
  ];
  const createEnv = { ...process.env };
  delete createEnv.NEMOCLAW_OBSERVABILITY;
  const sourceAuthority = srcEntry as SandboxEntry;
  if (
    sourceAuthority.hostLocalInferenceProvenance &&
    (typeof sourceAuthority.hostLocalInferenceReceipt !== "string" ||
      typeof sourceAuthority.provider !== "string" ||
      typeof sourceAuthority.model !== "string" ||
      !isValidForwardPort(sourceAuthority.gatewayPort) ||
      typeof sourceAuthority.openshellDriver !== "string")
  ) {
    throw new SnapshotCommandError(
      "Source host-local inference lifecycle authority is incomplete.",
    );
  }
  const cloneRouteReservation = {
    provider: sourceAuthority.provider ?? null,
    model: sourceAuthority.model ?? null,
    endpointUrl: sourceAuthority.endpointUrl ?? null,
    endpointSource: sourceAuthority.endpointSource ?? null,
    credentialEnv: sourceAuthority.credentialEnv ?? null,
    preferredInferenceApi: sourceAuthority.preferredInferenceApi ?? null,
    gatewayName: sourceGatewayName,
    gatewayPort: sourceAuthority.gatewayPort ?? undefined,
    openshellDriver: sourceAuthority.openshellDriver ?? undefined,
    reservationSessionId: createAttemptNonce,
    ...(sourceAuthority.hostLocalInferenceReceipt !== undefined
      ? { hostLocalInferenceReceipt: sourceAuthority.hostLocalInferenceReceipt }
      : {}),
    ...(sourceAuthority.hostLocalInferenceProvenance
      ? {
          hostLocalInferenceProvenance: sourceAuthority.hostLocalInferenceProvenance,
        }
      : {}),
  };
  let cloneRouteReservationSessionId: string | null = null;
  const reserveCloneRoute = (requireAbsent: boolean): void => {
    if (cloneRouteReservationSessionId) return;
    const reserved = requireAbsent
      ? registry.reserveSandboxInferenceRoute(dstName, cloneRouteReservation, {
          requireAbsent: true,
        })
      : registry.reserveSandboxInferenceRoute(dstName, cloneRouteReservation);
    if (!reserved) {
      throw new SnapshotCommandError(
        `Could not retain clone route authority for '${dstName}' because its registry row changed.`,
      );
    }
    cloneRouteReservationSessionId = createAttemptNonce;
  };
  const releaseCloneRouteReservation = (): void => {
    if (!cloneRouteReservationSessionId) return;
    const current = registry.getSandbox(dstName);
    if (
      current?.pendingRouteReservation === true &&
      current.reservationSessionId === cloneRouteReservationSessionId
    ) {
      registry.removeSandboxRouteReservationIfCurrent(current);
    }
    cloneRouteReservationSessionId = null;
  };

  if (sourceAuthority.hostLocalInferenceProvenance) {
    try {
      reserveCloneRoute(false);
    } catch {
      throw new SnapshotCommandError(
        "Could not reserve the clone's exact host-local inference authority.",
      );
    }
  }

  console.log(`  '${dstName}' does not exist. Creating from '${srcName}' image (${fromImage})...`);

  const sandboxLifecycle = createCliOpenShellSandboxLifecycleFromRunner(runOpenshell, {
    resolveBinary: () => openshellBin,
  });
  let readyCheckIdentityError: Error | null = null;
  const createRequest = Object.freeze({
    sandboxName: dstName,
    target: Object.freeze({ kind: "named" as const, gatewayName: sourceGatewayName }),
    source: Object.freeze({ reference: fromImage }),
    policyPath: createPolicyPath,
    autoProviders: true,
    labels: Object.freeze({ [NEMOCLAW_CREATE_ATTEMPT_LABEL]: createAttemptNonce }),
    startupCommand: Object.freeze([...startupCommand]),
    environment: Object.freeze({ ...createEnv }),
  });
  let createResult: Awaited<ReturnType<typeof sandboxLifecycle.createSandbox>>;
  try {
    createResult = await sandboxLifecycle.createSandbox(createRequest, {
      // Use a pre-built image, so skip build+push and jump to pod creation.
      initialPhase: "create",
      // Wait until this exact nonce-owned sandbox reaches Ready, not just any
      // same-name sandbox visible in the gateway list.
      readyCheck: () => {
        const list = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
          ignoreError: true,
          openshellBinary: openshellBin,
        });
        if (list.status !== 0 || !isSandboxReady(list.output || "", dstName)) return false;
        const observation = observeCreatedOpenShellSandboxId(
          {
            sandboxName: dstName,
            gatewayName: sourceGatewayName,
            createAttemptNonce,
            runCaptureOpenshell: captureCreatedIdentity,
          },
          OPENSHELL_PROBE_TIMEOUT_MS,
        );
        if (observation.state === "invalid") {
          readyCheckIdentityError = new Error(
            `OpenShell create-attempt identity is invalid (${observation.diagnostic}).`,
          );
          return true;
        }
        if (observation.state === "pending") return false;
        try {
          bindCreatedSandboxId(observation.sandboxId);
        } catch (error) {
          readyCheckIdentityError =
            error instanceof Error
              ? error
              : new Error("OpenShell create-attempt identity changed.");
          return true;
        }
        return true;
      },
    });
  } catch (error) {
    releaseCloneRouteReservation();
    throw error;
  }

  if (createResult.status !== 0 && !createResult.forcedReady && !createResult.ambiguous) {
    releaseCloneRouteReservation();
    console.error(`  Failed to create sandbox '${dstName}' (exit ${createResult.status}).`);
    const tail = (createResult.output || "").slice(-600);
    if (tail) console.error(tail);
    snapshotExit(1);
  }

  try {
    if (readyCheckIdentityError) throw readyCheckIdentityError;
    settleCreatedSandboxId();
  } catch {
    reserveCloneRoute(true);
    failUnregisteredSnapshotClone(dstName, sourceGatewayName, createAttemptNonce);
  }
  let lifecycleRegistration: ReturnType<typeof cloneLifecycle.capture>;
  try {
    lifecycleRegistration = cloneLifecycle.capture();
  } catch {
    reserveCloneRoute(true);
    failUnregisteredSnapshotClone(dstName, sourceGatewayName, createAttemptNonce);
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
    reserveCloneRoute(true);
    failUnregisteredSnapshotClone(dstName, sourceGatewayName, createAttemptNonce);
  }
  const cloneSourceEntry = srcEntry as SandboxEntry;
  let pendingCloneRegistration: SandboxEntry;
  try {
    pendingCloneRegistration = registry.registerSandbox(
      {
        ...cloneSourceEntry,
        name: dstName,
        createdAt: new Date().toISOString(),
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
      },
      undefined,
      {
        pending: true,
        ...(cloneRouteReservationSessionId ? { reservationSessionId: createAttemptNonce } : {}),
      },
    );
  } catch {
    releaseCloneRouteReservation();
    failUnregisteredSnapshotClone(dstName, sourceGatewayName);
  }

  // The pending registry row now owns any retained route reservation.
  // Keep it unpublished until the caller completes sensitive-file cleanup.
  cloneRouteReservationSessionId = null;
  return pendingCloneRegistration;
}

// Delete an existing destination sandbox so `snapshot restore --to <dst> --force`
// can recreate it from the source's image. Stops the destination's NIM
// container, runs `openshell sandbox delete`, performs the destination-only
// cleanups that `sandboxDestroy` does (PID dir and per-sandbox messaging
// providers), then drops the NemoClaw registry entry. Throws
// SnapshotCommandError on failure so the caller does not proceed into a
// partially-deleted target.
//
// Host-shared cleanups that destroy.ts performs \u2014 Ollama auth proxy
// (`killStaleProxy`), host services (`cleanupSandboxServices` with
// `stopHostServices`), Ollama model unload, gateway teardown \u2014 are
// deliberately skipped here because they can also affect the source sandbox
// we are about to clone from.
async function deleteSandboxForRestore(name: string): Promise<void> {
  await withMcpLifecycleLock(name, async () => {
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
    const gatewayName = resolveSandboxGatewayName(sbMeta);
    const deleteResult = await createCliOpenShellSandboxLifecycleFromRunner(
      runOpenshell,
    ).deleteSandbox({
      sandboxName: name,
      target: { kind: "named", gatewayName },
    });
    if (deleteResult.kind === "failed" && !deleteResult.ambiguous) {
      console.error(
        `  Failed to delete '${name}' (exit ${deleteResult.exitCode ?? 1}). Aborting restore.`,
      );
      snapshotExit(1);
    }
    if (deleteResult.kind !== "absent") {
      const convergence = await waitForSandboxDeleteAbsence(
        name,
        gatewayName,
        createCliOpenShellSandboxLookupFromRunner(runOpenshell),
      );
      if (!convergence.confirmed) {
        console.error(
          `  OpenShell did not confirm that destination '${name}' is absent. Aborting restore.`,
        );
        snapshotExit(1);
      }
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
    try {
      fs.rmSync(`/tmp/nemoclaw-services-${name}`, {
        recursive: true,
        force: true,
      });
    } catch {
      // PID dir may not exist \u2014 ignore.
    }
    await deleteSandboxProviderRegistrations(name, "messaging", {
      runOpenshell,
    });
    requireSnapshotDestinationRegistryRemoval(name, removeSandboxRegistryEntryOutcome(name));
  });
  console.log(`  ${G}\u2713${R} '${name}' deleted`);
}

async function listLiveSandboxesOnSandboxGateway(sandboxName: string): Promise<Set<string> | null> {
  if (!(await selectSandboxGatewayIfRegistered(sandboxName))) return null;
  if (!(await probeGatewayRunning(sandboxName))) return null;
  const isLive = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (isLive.status !== 0) return null;
  return parseLiveSandboxNames(isLive.output || "");
}

async function requireLiveSandboxesOnSandboxGateway(
  sandboxName: string,
  error: string,
): Promise<Set<string>> {
  const liveNames = await listLiveSandboxesOnSandboxGateway(sandboxName);
  if (!liveNames) {
    console.error(error);
    snapshotExit(1);
  }
  return liveNames;
}

async function verifyRestoreDestinationOnOwnGateway(targetSandbox: string): Promise<void> {
  const liveNames = await requireLiveSandboxesOnSandboxGateway(
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

type PendingSnapshotCloneRecovery = "not-pending" | "finalized" | "removed";

function isSnapshotCloneCreateAttemptNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH &&
    /^[0-9a-f]+$/u.test(value)
  );
}

function isPendingAmbiguousSnapshotClone(entry: SandboxEntry | null): entry is SandboxEntry & {
  pendingRouteReservation: true;
  reservationSessionId: string;
} {
  return Boolean(
    entry &&
    registry.isRouteOnlySandboxReservation(entry) &&
    isSnapshotCloneCreateAttemptNonce(entry.reservationSessionId),
  );
}

function pendingSnapshotCloneRouteMatchesSource(
  pending: SandboxEntry,
  sourceEntry: SandboxEntry,
  sourceGatewayName: string,
): boolean {
  return (
    pending.gatewayName === sourceGatewayName &&
    (pending.gatewayPort ?? null) === (sourceEntry.gatewayPort ?? null) &&
    (pending.openshellDriver ?? null) === (sourceEntry.openshellDriver ?? null) &&
    pending.hostLocalInferenceReceipt === sourceEntry.hostLocalInferenceReceipt &&
    isDeepStrictEqual(
      pending.hostLocalInferenceProvenance,
      sourceEntry.hostLocalInferenceProvenance,
    ) &&
    (pending.provider ?? null) === (sourceEntry.provider ?? null) &&
    (pending.model ?? null) === (sourceEntry.model ?? null) &&
    (pending.endpointUrl ?? null) === (sourceEntry.endpointUrl ?? null) &&
    (pending.endpointSource ?? null) === (sourceEntry.endpointSource ?? null) &&
    (pending.credentialEnv ?? null) === (sourceEntry.credentialEnv ?? null) &&
    (pending.preferredInferenceApi ?? null) === (sourceEntry.preferredInferenceApi ?? null)
  );
}

function retainedAmbiguousSnapshotCloneError(
  targetSandbox: string,
  sourceGatewayName: string,
  createAttemptNonce: string,
  detail: string,
): SnapshotCommandError {
  const label = `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}`;
  return new SnapshotCommandError([
    `Cannot release the retained route reservation for '${targetSandbox}': ${detail}.`,
    `Create-attempt label: ${label}`,
    "Do not retry the create until OpenShell confirms that both the labelled sandbox and destination name are absent.",
    `Inspect: openshell sandbox list -g ${shellQuote(sourceGatewayName)} --selector ${shellQuote(label)} --output json`,
  ]);
}

function reconcileAmbiguousSnapshotCloneReservation(
  targetSandbox: string,
  pending: SandboxEntry & { reservationSessionId: string },
  sourceEntry: SandboxEntry,
  sourceGatewayName: string,
): PendingSnapshotCloneRecovery {
  const createAttemptNonce = pending.reservationSessionId;
  if (!pendingSnapshotCloneRouteMatchesSource(pending, sourceEntry, sourceGatewayName)) {
    throw retainedAmbiguousSnapshotCloneError(
      targetSandbox,
      sourceGatewayName,
      createAttemptNonce,
      "its inference route no longer matches the snapshot source",
    );
  }
  const observation = observeCreatedOpenShellSandboxId(
    {
      sandboxName: targetSandbox,
      gatewayName: sourceGatewayName,
      createAttemptNonce,
      runCaptureOpenshell: (args, options) => {
        const result = captureOpenshell(args, { ...options, ignoreError: true });
        if (result.status !== 0) {
          throw new Error(`Command failed with status ${String(result.status ?? 1)}`);
        }
        return result.output || "";
      },
    },
    OPENSHELL_PROBE_TIMEOUT_MS,
  );
  if (observation.state !== "pending" || observation.sandboxId !== null) {
    const detail =
      observation.state === "invalid"
        ? `the create-attempt selector is inconclusive (${observation.diagnostic})`
        : "OpenShell still reports a sandbox for the create-attempt label";
    throw retainedAmbiguousSnapshotCloneError(
      targetSandbox,
      sourceGatewayName,
      createAttemptNonce,
      detail,
    );
  }
  const list = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
    ignoreError: true,
  });
  if (list.status !== 0) {
    throw retainedAmbiguousSnapshotCloneError(
      targetSandbox,
      sourceGatewayName,
      createAttemptNonce,
      "the owning gateway could not confirm destination-name absence",
    );
  }
  if (parseLiveSandboxNames(list.output || "").has(targetSandbox)) {
    throw retainedAmbiguousSnapshotCloneError(
      targetSandbox,
      sourceGatewayName,
      createAttemptNonce,
      "OpenShell still reports the destination name",
    );
  }
  if (!registry.removeSandboxRouteReservationIfCurrent(pending)) {
    throw retainedAmbiguousSnapshotCloneError(
      targetSandbox,
      sourceGatewayName,
      createAttemptNonce,
      "the retained route reservation changed during reconciliation",
    );
  }
  return "removed";
}

async function reconcilePendingSnapshotClone(
  targetSandbox: string,
  sourceEntry: SandboxEntry,
  sourceGatewayName: string,
): Promise<PendingSnapshotCloneRecovery> {
  const pending = registry.getSandbox(targetSandbox);
  if (!pending || pending.pendingRouteReservation !== true) {
    return "not-pending";
  }
  if (isPendingAmbiguousSnapshotClone(pending)) {
    return reconcileAmbiguousSnapshotCloneReservation(
      targetSandbox,
      pending,
      sourceEntry,
      sourceGatewayName,
    );
  }
  if (registry.isRouteOnlySandboxReservation(pending)) return "not-pending";
  if (
    pending.gatewayName !== sourceGatewayName ||
    pending.imageTag !== sourceEntry.imageTag ||
    typeof pending.lifecycleGeneration !== "string" ||
    typeof pending.lifecycleLiveIdentityFingerprint !== "string"
  ) {
    throw new SnapshotCommandError(
      `Pending clone '${targetSandbox}' does not match this snapshot restore. Re-run with --force only after reviewing that sandbox.`,
    );
  }

  const list = captureOpenshell(["sandbox", "list", "-g", sourceGatewayName], {
    ignoreError: true,
  });
  if (list.status !== 0) {
    throw new SnapshotCommandError(
      `Cannot reconcile pending clone '${targetSandbox}' because its owning gateway could not be queried.`,
    );
  }
  const liveNames = parseLiveSandboxNames(list.output || "");
  if (!liveNames.has(targetSandbox)) {
    await deleteSandboxForRestore(targetSandbox);
    return "removed";
  }

  const get = captureOpenshell(["sandbox", "get", "-g", sourceGatewayName, targetSandbox], {
    ignoreError: true,
  });
  if (get.status !== 0) {
    throw new SnapshotCommandError(
      `Cannot reconcile pending clone '${targetSandbox}' because its live identity could not be read.`,
    );
  }
  const liveIdentityFingerprint = fingerprintSandboxLiveIdentity(get.output || "");
  if (liveIdentityFingerprint !== pending.lifecycleLiveIdentityFingerprint) {
    await deleteSandboxForRestore(targetSandbox);
    return "removed";
  }
  if (!isSandboxReady(list.output || "", targetSandbox)) {
    throw new SnapshotCommandError(
      `Pending clone '${targetSandbox}' has the expected identity but is not Ready yet. Retry after it becomes Ready.`,
    );
  }
  const sessionCanFinalize =
    pending.reservationSessionId === undefined ||
    isSnapshotCloneCreateAttemptNonce(pending.reservationSessionId);
  const finalized =
    sessionCanFinalize && registry.finalizePendingSandboxRegistrationIfCurrent(pending);
  if (!finalized) {
    throw new SnapshotCommandError(
      `Pending clone '${targetSandbox}' changed while its registration was being finalized. Retry the restore.`,
    );
  }
  console.log(`  ${G}\u2713${R} Recovered pending clone '${targetSandbox}'`);
  return "finalized";
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
  if (sandboxState.removeSandboxStateBackup(sandboxName, backupPath)) {
    console.error("  Removed the incomplete snapshot.");
    return;
  }
  console.error(`  The incomplete snapshot at '${backupPath}' could not be removed.`);
  console.error(
    `  It is excluded from \`${CLI_NAME} ${sandboxName} snapshot list\` and snapshot restore selection. Remove it only after the original sandbox or a complete snapshot contains every required state item.`,
  );
}

async function runSnapshotCreate(
  sandboxName: string,
  request: Extract<SnapshotRequest, { kind: "create" }>,
): Promise<void> {
  const liveNames = await requireLiveSandboxesOnSandboxGateway(
    sandboxName,
    "  Failed to query live sandbox state from OpenShell.",
  );
  if (!liveNames.has(sandboxName)) {
    console.error(`  Sandbox '${sandboxName}' is not running. Cannot create snapshot.`);
    snapshotExit(1);
  }
  return withMcpLifecycleLockSync(sandboxName, () => {
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

function requireRestoredOpenClawConfigPerms(
  targetSandbox: string,
  result: Awaited<ReturnType<typeof sandboxState.restoreSandboxState>>,
): void {
  if (!result.restoredFiles.includes("openclaw.json")) return;
  let failure: string;
  try {
    const permRepair = repairMutableConfigPerms(targetSandbox);
    if (permRepair.applied && permRepair.verified) {
      console.log(`  ${G}✓${R} OpenClaw config permissions restored`);
      return;
    }
    failure = permRepair.applied
      ? permRepair.errors.join("; ") || "permission verification failed"
      : permRepair.reason;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  throw new SnapshotCommandError([
    `State restored into '${targetSandbox}', but OpenClaw config permissions could not be verified.`,
    `Run \`${CLI_NAME} ${targetSandbox} doctor --fix\`, then rerun \`${CLI_NAME} ${targetSandbox} doctor\` before running an agent.`,
    `Details: ${failure}`,
  ]);
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
  const sourceLiveNames = await requireLiveSandboxesOnSandboxGateway(
    sandboxName,
    "  Failed to query live sandbox state from OpenShell.",
  );
  const isCrossSandboxRestore = targetSandbox !== sandboxName;
  let crossSandboxRestoreAgent: string | null = null;
  const targetEntry = isCrossSandboxRestore ? registry.getSandbox(targetSandbox) : null;
  let targetExists = sourceLiveNames.has(targetSandbox) || Boolean(targetEntry);
  const hasPendingCreatedClone =
    targetEntry?.pendingRouteReservation === true &&
    !registry.isRouteOnlySandboxReservation(targetEntry);
  const hasPendingAmbiguousClone = isPendingAmbiguousSnapshotClone(targetEntry);
  const hasPendingSnapshotClone = hasPendingCreatedClone || hasPendingAmbiguousClone;

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
    if (targetExists && !request.force && !hasPendingSnapshotClone) {
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
    if (targetExists && !hasPendingSnapshotClone) {
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
      const pendingRecovery = await reconcilePendingSnapshotClone(
        targetSandbox,
        lockedSourceEntry,
        lockedGatewayName,
      );
      if (pendingRecovery === "finalized") return;
      if (pendingRecovery === "removed") targetExists = false;
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
      let clonePorts: Awaited<ReturnType<typeof allocateSnapshotCloneForwardPorts>>;
      try {
        clonePorts = await allocateSnapshotCloneForwardPorts({
          destinationName: targetSandbox,
          executable: getOpenshellBinary(),
          gatewayName: lockedGatewayName,
          gatewayPort: lockedGatewayPort,
          source: lockedSourceEntry,
        });
      } catch (error) {
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        snapshotExit(1);
      }
      const { dashboardPort: dstDashboardPort, hermesApiPort: dstHermesApiPort } = clonePorts;
      const dashboardEnvArgs = resolveCloneDashboardEnvArgs(lockedSourceEntry, dstDashboardPort);
      let clonePolicy = await prepareSnapshotClonePolicy(lockedSourceEntry, targetSandbox);
      let cloneCreatedPending = false;
      let pendingCloneRegistration: SandboxEntry | null = null;
      try {
        const refreshedClonePolicy = await prepareSnapshotClonePolicy(
          lockedSourceEntry,
          targetSandbox,
        );
        if (clonePolicy.cleanup && !clonePolicy.cleanup()) {
          refreshedClonePolicy.cleanup?.();
          throw new SnapshotCommandError([
            `Could not securely replace temporary clone policy '${clonePolicy.policyPath}'.`,
            "Inspect the task-owned temporary directory before retrying the snapshot restore command.",
          ]);
        }
        clonePolicy = refreshedClonePolicy;
        if (targetExists) {
          if (targetEntry) {
            await verifyRestoreDestinationOnOwnGateway(targetSandbox);
          }
          await deleteSandboxForRestore(targetSandbox);
          await requireLiveSandboxesOnSandboxGateway(
            sandboxName,
            "  Failed to re-select source sandbox gateway after deleting destination.",
          );
        }
        pendingCloneRegistration = await autoCreateSandboxFromSource(
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
        cloneCreatedPending = true;
      } finally {
        if (clonePolicy.cleanup && !clonePolicy.cleanup()) {
          if (cloneCreatedPending) {
            throw new SnapshotCommandError([
              `Temporary clone policy '${clonePolicy.policyPath}' could not be securely removed after '${targetSandbox}' was created.`,
              `Destination '${targetSandbox}' remains registered as a pending clone. Snapshot state was not restored.`,
              "Inspect and remove the task-owned temporary policy file before continuing.",
              `Then rerun the same restore without --force so NemoClaw can reconcile '${targetSandbox}' and continue without deleting or recreating it.`,
            ]);
          }
          throw new SnapshotCommandError([
            `Could not securely remove temporary clone policy '${clonePolicy.policyPath}'.`,
            "Inspect the task-owned temporary directory before retrying the snapshot restore command.",
          ]);
        }
      }
      const finalized =
        pendingCloneRegistration !== null &&
        registry.finalizePendingSandboxRegistrationIfCurrent(pendingCloneRegistration);
      if (!finalized) {
        throw new SnapshotCommandError([
          `Pending clone '${targetSandbox}' changed while NemoClaw finalized its registration.`,
          "Snapshot state was not restored. The current registry row was preserved.",
          `Inspect '${targetSandbox}' before retrying. Retry without --force only when it remains the matching pending clone.`,
        ]);
      }
      console.log(`  ${G}\u2713${R} Sandbox '${targetSandbox}' created`);
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
        await deleteSandboxForRestore(targetSandbox);
        snapshotExit(1);
      }
    }
  }
  await withMcpLifecycleLock(targetSandbox, async () => {
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
    if (Boolean(snapshotRestoreAuthority) !== Boolean(validateProviderRestoreBeforeMutation)) {
      console.error(
        `  Cannot restore provider snapshot '${sandboxName}': content authority and the runtime mutation fence must both be present.`,
      );
      console.error(`  Destination '${targetSandbox}' was not changed.`);
      snapshotExit(1);
    }
    if (targetSandbox !== sandboxName) {
      console.log(`  Restoring snapshot from '${sandboxName}' into '${targetSandbox}'...`);
    } else {
      console.log(`  Restoring snapshot into '${sandboxName}'...`);
    }
    const result =
      snapshotRestoreAuthority && validateProviderRestoreBeforeMutation
        ? await sandboxState.restoreSandboxState(targetSandbox, backupPath, {
            authority: snapshotRestoreAuthority,
            validateBeforeMutation: validateProviderRestoreBeforeMutation,
          })
        : await sandboxState.restoreSandboxState(targetSandbox, backupPath);
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
      requireRestoredOpenClawConfigPerms(targetSandbox, result);
      console.log(
        `  ${G}\u2713${R} Restored ${result.restoredDirs.length} directories, ${result.restoredFiles.length} files`,
      );
      printHermesGatewayRestoreHint(
        targetSandbox,
        registry.getSandbox(targetSandbox)?.agent,
        result.restoredFiles,
        resolvedSnapshot?.stateFiles ?? [],
        CLI_NAME,
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
