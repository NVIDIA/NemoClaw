// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { createCliOpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer-cli";
import {
  namedOpenShellGateway,
  type OpenShellSandboxError,
  type OpenShellSandboxObservation,
  type OpenShellSandboxObserver,
} from "../../adapters/openshell/sandbox-observer";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  captureOpenshell,
  captureResolvedOpenshell,
  getOpenshellBinary,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import {
  OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import { retryUntil, retryUntilAsync } from "../../core/retry";

import { spawnExitCode } from "../../core/process-exit";
import { shellQuote } from "../../core/shell-quote";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import {
  buildGatewayInferenceGetArgs,
  formatInferenceRouteDriftForDisplay,
  parseGatewayInference,
  planInferenceRouteReconcile,
  sanitizeRouteValueForDisplay,
} from "../../inference/config";
import { GatewayRouteConflictError } from "../../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { findReachableOllamaHost, probeLocalProviderHealth } from "../../inference/local";
import { ensureOllamaAuthProxy, probeOllamaAuthProxyHealth } from "../../inference/ollama/proxy";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
} from "../../openshell-gateway-endpoint-guard";
import { isWsl } from "../../platform";
import { ROOT } from "../../runner";
import * as sandboxVersion from "../../sandbox/version";
import { redact, redactFull } from "../../security/redact";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { runSetupDnsProxy } from "../dns";
import { runSandboxExecChild } from "./exec";
import { runConnectAutoPairApprovalPass } from "./auto-pair-approval";
import {
  exitOnMcpReconciliationRefusal,
  exitOnSecretBoundaryRefusal,
  printGatewayIntegrityRepairGuidance,
} from "./connect-boundary-refusal";
import { prepareHermesLightTerminalSkin } from "./connect-hermes-light-skin";
import {
  assertSandboxGatewayRouteCompatible,
  buildGatewayInferenceSetArgs,
  sandboxUsesLegacyClusterGateway,
} from "./connect-inference-gateway";
import {
  buildSandboxInferenceRouteProbeArgs,
  type InferenceRouteProbeAgent,
  parseSandboxInferenceRouteProbeResult,
} from "./connect-inference-route-probe";
import { preflightVllmModelEnvOrExit } from "./connect-vllm-preflight";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";
import {
  ensureLiveSandboxOrExit,
  assertHermesPortableLifecycleForConnect,
  buildHermesPortableCommandAuthority,
  type HermesPortableActiveLifecycleAuthority,
  getNamedGatewayLifecycleState,
  printGatewayLifecycleHint,
  qualifyHermesPortableAcceptedReadinessAuthority,
  qualifyPortableAgentLifecycleAuthority,
  qualifyHermesPortableOperatingCommandAuthority,
  requalifyPortableAgentSandboxAuthority,
  recoverPortableDemoSandboxLifecycleForConnect,
  isTerminalSandboxPhase,
  TERMINAL_SANDBOX_PHASES,
  requireHermesPortableActiveLifecycleAuthority,
  startStoppedSandboxContainerForProbeRecovery,
  withConnectSandboxLifecycleLock,
} from "./gateway-state";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { printGatewayWedgeDiagnostics } from "./gateway-wedge-diagnostics";
import {
  createProbeTimingRecorder,
  createBoundLaunchReadinessDeps,
  inspectLaunchReadiness,
  portableOpenClawPairingIncompleteMessage,
  type ProbeTimingRecorder,
  publicationFromDecision,
  publishLaunchReadiness,
  settlePortableOpenClawPairing,
  withLaunchReadinessMutationGate,
} from "./launch-readiness";
import type {
  HermesPortableCurrentnessTimingEvidence,
  HermesPortableLifecycleRecoveryTimingEvidence,
} from "../../onboard/experimental/hermes-portable-lifecycle";
import type { HermesPortableContainerInspectionTimingEvidence } from "../../onboard/experimental/hermes-portable-container";
import {
  checkAndRecoverSandboxProcesses,
  createHermesPortableForwardRecoveryInput,
  executeSandboxExecCommand,
  type GatewayRestartFailureLayer,
  HermesPortableForwardRecoveryError,
  type HermesPortableForwardRecoveryFailure,
  type HermesPortableForwardRecoveryTimingEvidence,
  type ManagedGatewayControlCompletion,
  prepareHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
  type PreparedHermesPortableForwardRecovery,
  resolveSandboxDashboardPort,
  resolveSandboxLaunchForwardPorts,
  waitForManagedGatewaySupervisor,
} from "./process-recovery";
import {
  classifyHermesPortableInferenceConnectRecoveryFailure,
  inspectHermesPortableInferenceReadinessRuntimeForConnectProbe,
  recoverHermesPortableInferenceForConnectProbe,
  type HermesPortableInferenceConnectRecoveryFailure,
} from "./probe/hermes-portable-inference-recovery";
import { runTerminalAgentConnectProbe } from "./terminal-connect-probe";
import { applyOpenShellVmDnsMonkeypatch, shouldApplyVmDnsMonkeypatch } from "./vm-dns-monkeypatch";

export { runConnectAutoPairApprovalPass, waitForManagedGatewaySupervisor };

const HERMES_READINESS_PUBLICATION_SETTLE_DELAYS_MS = [100, 250] as const;

async function publishHermesLaunchReadinessWithSettlement(
  publication: Parameters<typeof publishLaunchReadiness>[0],
  deps: Parameters<typeof publishLaunchReadiness>[1],
) {
  return retryUntilAsync(() => publishLaunchReadiness(publication, deps), {
    accept: (result) => result.kind !== "validation-failed" || result.category !== "health",
    retryDelaysMs: HERMES_READINESS_PUBLICATION_SETTLE_DELAYS_MS,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

export type SandboxConnectOptions = {
  probeOnly?: boolean;
  requireLaunchReadinessPublication?: boolean;
};

export type SandboxStartupRecoveryResult = ReturnType<typeof checkAndRecoverSandboxProcesses> & {
  recoveryFailureDetail?: string | null;
  recoveryFailureLayer?: GatewayRestartFailureLayer | null;
};

export function sanitizeSandboxStartupRecoveryDetail(raw: string): string {
  return redactFull(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

type SpawnLikeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
};

export type SandboxInferenceRouteProbe = {
  healthy: boolean;
  broken: boolean;
  httpStatus?: number;
  detail: string;
};

type InferenceRouteProbeOptions = {
  attempts?: number;
  delayMs?: number;
};

type SandboxInferenceRouteEnsureResult = {
  sandbox: SandboxEntry | null;
  routeHealthy: boolean | null;
};

export type SandboxInferenceRouteRepairResult = {
  healthy: boolean;
  repairAttempted: boolean;
  detail: string;
};

export type SandboxInferenceRouteRepairDeps = {
  isRepairDisabled?: () => boolean;
  probe: (sandboxName: string, options?: InferenceRouteProbeOptions) => SandboxInferenceRouteProbe;
  shouldApplyVmDnsMonkeypatch: (sb: SandboxEntry | null) => boolean;
  applyVmDnsMonkeypatch: (
    sandboxName: string,
    sb: SandboxEntry | null,
  ) => { ok: boolean; reason?: string };
  reapplyVmInferenceRoute: (
    sandboxName: string,
    sb: SandboxEntry | null,
  ) => SandboxInferenceRouteProbe | null;
  repairLegacyDnsProxy: (
    sandboxName: string,
    quiet: boolean,
  ) => { exitCode: number; message?: string | null };
  assertRouteCompatible?: (sandboxName: string, sb: SandboxEntry | null) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type ManagedInferenceRouteResetDeps = {
  verifyLocalInferenceRouteDependencies: (
    provider: string,
    options: { quiet?: boolean },
  ) => boolean;
  runInferenceSet: (provider: string, model: string) => { status: number | null };
  probe: (sandboxName: string, options?: InferenceRouteProbeOptions) => SandboxInferenceRouteProbe;
  printUnrecoverableInferenceRoute: (sandboxName: string, route: string, detail: string) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS = 3;
const INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS = 2_000;

const SANDBOX_CONNECT_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--probe-only",
  "--help",
  "-h",
]);

export function isSandboxConnectFlag(arg: string | undefined): boolean {
  return typeof arg === "string" && SANDBOX_CONNECT_FLAGS.has(arg);
}

export function printSandboxConnectHelp(sandboxName = "<name>"): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} ${sandboxName} connect [--probe-only]`);
  console.log("");
  console.log("  Options:");
  console.log(
    "    --probe-only                    Run recovery checks and exit without opening SSH",
  );
  console.log("    -h, --help                      Show this help");
  console.log("");
}

export function parseSandboxConnectArgs(
  sandboxName: string,
  actionArgs: string[],
): SandboxConnectOptions {
  const options: SandboxConnectOptions = {};
  for (const arg of actionArgs) {
    if (!isSandboxConnectFlag(arg)) {
      console.error(`  Unknown flag for connect: ${arg}`);
      printSandboxConnectHelp(sandboxName);
      process.exit(1);
    }
    switch (arg) {
      case "--dangerously-skip-permissions":
        console.error("  --dangerously-skip-permissions is not supported.");
        printSandboxConnectHelp(sandboxName);
        process.exit(1);
        break;
      case "--probe-only":
        options.probeOnly = true;
        break;
      case "--help":
      case "-h":
        printSandboxConnectHelp(sandboxName);
        process.exit(0);
        break;
    }
  }
  return options;
}

function exitOnForwardRecoveryFailure(
  sandboxName: string,
  agentName: string,
  port: number,
  detail?: string,
): never {
  console.error("");
  console.error(
    `  Probe failed: ${agentName} gateway is running in '${sandboxName}', but ${detail ?? "the dashboard/API host forward could not be restored"}.`,
  );
  console.error(
    `  Run \`nemoclaw ${sandboxName} recover\` after resolving the reported ForwardTcp error.`,
  );
  process.exit(1);
}

function exitOnGatewayRecoveryFailure(
  sandboxName: string,
  agentName: string,
  detail: string,
  operation: "Probe" | "Recovery" = "Probe",
  showWedgeDiagnostics = false,
): never {
  const safeDetail = sanitizeSandboxStartupRecoveryDetail(detail);
  const terminalPunctuation = /[.!?]$/u.test(safeDetail) ? "" : ".";
  console.error("");
  console.error(
    `  ${operation} failed: NemoClaw could not recover the ${agentName} gateway in '${sandboxName}'.`,
  );
  console.error(`  Recovery detail: ${safeDetail}${terminalPunctuation}`);
  if (showWedgeDiagnostics) {
    printGatewayWedgeDiagnostics(sandboxName, executeSandboxExecCommand);
    console.error("  Check /tmp/gateway.log inside the sandbox for details.");
  }
  process.exit(1);
}

async function settlePortablePairingOrExit(sandboxName: string): Promise<boolean> {
  const result = await settlePortableOpenClawPairing(sandboxName);
  if (result.kind === "incomplete") {
    console.error(`  ${portableOpenClawPairingIncompleteMessage(sandboxName, result.reason)}`);
    process.exit(1);
  }
  return result.kind === "settled";
}

async function runSandboxConnectProbe(
  sandboxName: string,
  {
    hermesPortable = false,
    hermesPortableCommandAuthority,
    probeOnly,
    probeTiming,
  }: {
    hermesPortable?: boolean;
    hermesPortableCommandAuthority?: HermesPortableReadinessCommandAuthority;
    probeOnly: true;
    probeTiming?: ProbeTimingRecorder;
  },
): Promise<void> {
  if (probeOnly !== true) throw new Error("connect recovery requires probe-only authority");
  const measure = <T>(stage: "forward" | "inference" | "pairing", operation: () => T): T =>
    probeTiming ? probeTiming.measure(stage, operation) : operation();
  const measureAsync = <T>(
    stage: "inference" | "pairing",
    operation: () => Promise<T>,
  ): Promise<T> => (probeTiming ? probeTiming.measureAsync(stage, operation) : operation());
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const agentName = agentRuntime.getAgentDisplayName(agent);
  if (hermesPortable) {
    if (probeOnly !== true) throw new Error("Hermes inference recovery requires probe-only mode");
    const route = measure("inference", () =>
      verifyOrRecoverHermesPortableInferenceRouteForProbeOnlyOrExit(sandboxName, agent, undefined, {
        commandAuthority: hermesPortableCommandAuthority,
        probeTiming,
      }),
    );
    if (!route.forwardsRecovered) {
      let authority: HermesPortableActiveLifecycleAuthority;
      try {
        authority = requireHermesPortableActiveLifecycleAuthority(
          sandboxName,
          undefined,
          portableAgentLifecycleAuthorityDeps(),
        );
      } catch {
        probeTiming?.setForwardAction("failed");
        probeTiming?.markFailureStage("forward");
        failHermesPortableForwardRecovery(sandboxName, "authority-drift");
      }
      recoverHermesPortableForwardsForConnectProbeOrExit(
        sandboxName,
        authority,
        probeTiming,
        hermesPortableCommandAuthority,
      );
    }
    console.log(
      `  Probe complete: ${agentName} passed receipt-owned authenticated health in '${sandboxName}'.`,
    );
    return;
  }
  if (agent && !agentRuntime.hasGatewayRuntime(agent)) {
    const routeResult = await measureAsync("inference", () =>
      ensureSandboxInferenceRoute(sandboxName, agent, { quiet: true }),
    );
    measure("inference", () =>
      runTerminalAgentConnectProbe({
        agent,
        agentName,
        capture: captureOpenshell,
        ensureInferenceRoute: () => routeResult,
        sandboxName,
      }),
    );
    return;
  }

  // Managed recovery runs quiet here, so its classified failure layer is the
  // only way this path can tell a retryable wedge apart from a deterministic
  // integrity refusal that no restart, recover, or connect can clear (#7801).
  let recoveryFailureLayer: GatewayRestartFailureLayer | null = null;
  const processCheck = checkAndRecoverSandboxProcesses(sandboxName, {
    quiet: true,
    probeTiming,
    onRecoveryFailureLayer: (layer) => {
      recoveryFailureLayer = layer;
    },
  });
  if (!processCheck.checked) {
    probeTiming?.markFailureStage("processes");
    console.error(
      `  Probe failed: could not inspect the ${agentName} gateway inside sandbox '${sandboxName}'.`,
    );
    process.exit(1);
  }
  if ("secretBoundaryRefused" in processCheck && processCheck.secretBoundaryRefused) {
    probeTiming?.markFailureStage("processes");
    exitOnSecretBoundaryRefusal(sandboxName, agentName, processCheck, "Probe");
  }
  if ("mcpReconciliationRefused" in processCheck && processCheck.mcpReconciliationRefused) {
    probeTiming?.markFailureStage("processes");
    exitOnMcpReconciliationRefusal(sandboxName, agentName, processCheck, "Probe");
  }
  if ("forwardRecoveryFailed" in processCheck && processCheck.forwardRecoveryFailed) {
    probeTiming?.markFailureStage("forward");
    const detail =
      "forwardRecoveryFailureDetail" in processCheck
        ? String(processCheck.forwardRecoveryFailureDetail)
        : undefined;
    exitOnForwardRecoveryFailure(
      sandboxName,
      agentName,
      resolveSandboxDashboardPort(sandboxName),
      detail,
    );
  }
  if ("recoveryFailureDetail" in processCheck && processCheck.recoveryFailureDetail) {
    probeTiming?.markFailureStage("processes");
    exitOnGatewayRecoveryFailure(
      sandboxName,
      agentName,
      String(processCheck.recoveryFailureDetail),
      "Probe",
      true,
    );
  }
  if (processCheck.wasRunning) {
    await measureAsync("inference", () => ensureSandboxInferenceRouteOrExit(sandboxName, agent));
    // Defense-in-depth scope-upgrade approval on the probe-only / `recover`
    // path (#4504): the gateway is up, so deterministically clear any pending
    // allowlisted CLI/webchat scope upgrade. Best-effort; never throws.
    if (!(await measureAsync("pairing", () => settlePortablePairingOrExit(sandboxName)))) {
      measure("pairing", () => runConnectAutoPairApprovalPass(sandboxName));
    }
    if (processCheck.forwardRecovered) {
      console.log(
        `  Probe complete: ${agentName} gateway is running in '${sandboxName}'; restored dashboard port forward.`,
      );
    } else {
      console.log(`  Probe complete: ${agentName} gateway is running in '${sandboxName}'.`);
    }
    return;
  }
  if (processCheck.recovered) {
    await measureAsync("inference", () => ensureSandboxInferenceRouteOrExit(sandboxName, agent));
    // Same defense-in-depth approval after a recovery (#4504); best-effort.
    if (!(await measureAsync("pairing", () => settlePortablePairingOrExit(sandboxName)))) {
      measure("pairing", () => runConnectAutoPairApprovalPass(sandboxName));
    }
    const managedControlCompletion =
      "managedControlCompletion" in processCheck
        ? (processCheck.managedControlCompletion as ManagedGatewayControlCompletion)
        : null;
    if (managedControlCompletion?.disposition === "already-running") {
      console.log(`  Probe complete: ${agentName} gateway is running in '${sandboxName}'.`);
    } else {
      console.log(`  Probe complete: recovered ${agentName} gateway in '${sandboxName}'.`);
    }
    return;
  }
  await measureAsync("inference", () => ensureSandboxInferenceRouteOrExit(sandboxName, agent));
  console.error(
    `  Probe failed: ${agentName} gateway is not running in '${sandboxName}' and automatic recovery failed.`,
  );
  probeTiming?.markFailureStage("processes");
  if (printGatewayIntegrityRepairGuidance(sandboxName, recoveryFailureLayer)) {
    process.exit(1);
  }
  // Surface the #4710 wedge signature: recovery ran with quiet=true, so this
  // is the operator's only window into a gateway that served briefly and
  // then dropped its listener.
  printGatewayWedgeDiagnostics(sandboxName, executeSandboxExecCommand);
  console.error("  Check /tmp/gateway.log inside the sandbox for details.");
  process.exit(1);
}

function failHermesPortableInferenceRoute(sandboxName: string, reason: string): never {
  console.error(
    `  Error: Hermes portable inference authority for '${sandboxName}' is ${reason}. Resume the existing portable onboarding transaction or run \`${CLI_NAME} ${sandboxName} doctor\` before retrying.`,
  );
  process.exit(1);
}

function failHermesPortableInferenceRecovery(
  sandboxName: string,
  failure: HermesPortableInferenceConnectRecoveryFailure,
): never {
  let detail: string;
  switch (failure) {
    case "runtime-restoration-unproved":
      detail =
        "NemoClaw could not prove restoration of the exact stopped managed inference runtime. Do not run another probe or launch until the recorded runtime state is inspected.";
      break;
    case "registry-restoration-unproved":
      detail =
        "NemoClaw could not prove restoration of the exact stopped Portable registry. Do not run another probe or launch until the recorded registry state is inspected.";
      break;
    case "authority-drift":
      detail =
        "Recorded managed inference authority changed during recovery. Do not run another probe or launch until the current Portable state is inspected.";
      break;
    case "recovery-failed":
      detail =
        "Managed inference recovery stopped without a verified result. Do not run another probe or launch until the current Portable state is inspected.";
      break;
    default:
      detail = `Managed inference recovery stopped at boundary ${failure}. Do not run another probe or launch until the current Portable state is inspected.`;
      break;
  }
  console.error(
    `  Error: Hermes Portable inference recovery for '${sandboxName}' failed. ${detail}`,
  );
  process.exit(1);
}

function failHermesPortableForwardRecovery(
  sandboxName: string,
  failure: HermesPortableForwardRecoveryFailure,
): never {
  const detail =
    failure === "restoration-unproved"
      ? "NemoClaw could not prove that the recovered host forwards returned to a stopped state. Do not run another probe or launch until the recorded forward state is inspected."
      : failure === "authority-drift"
        ? "Hermes Portable authority changed during host-forward recovery. Do not run another probe or launch until the current Portable state is inspected."
        : "The required recorded host forwards could not be restored. No launch-readiness evidence was published.";
  console.error(
    `  Error: Hermes Portable host-forward recovery for '${sandboxName}' failed. ${detail}`,
  );
  process.exit(1);
}

function failHermesPortableReadinessAuthority(sandboxName: string): never {
  console.error(
    `  Error: Hermes portable lifecycle authority for '${sandboxName}' is missing, incomplete, or changed during launch-readiness verification. No recovery was attempted.`,
  );
  process.exit(1);
}

function captureHermesPortableOpenShell(
  sandboxName: string,
  args: string[],
  options: { readonly includeStreams?: boolean; readonly timeout: number },
) {
  const commandAuthority = buildHermesPortableCommandAuthority(sandboxName);
  return captureResolvedOpenshell(args, {
    env: commandAuthority.env,
    openshellBinary: commandAuthority.executablePath,
    replaceEnv: true,
    ignoreError: true,
    ...options,
  });
}

type HermesPortableReadinessCommandAuthority = ReturnType<
  typeof qualifyHermesPortableOperatingCommandAuthority
>;

function probeTimingLaunchReadinessDeps(
  probeTiming?: ProbeTimingRecorder,
): NonNullable<Parameters<typeof inspectLaunchReadiness>[1]> {
  return probeTiming
    ? {
        recordObservationTiming: probeTiming.recordReadinessObservation,
        recordObservationFailure: probeTiming.recordReadinessObservationFailure,
      }
    : {};
}

function captureHermesPortableReadinessObservation(
  authority: HermesPortableReadinessCommandAuthority,
  args: string[],
  options: NonNullable<Parameters<typeof captureResolvedOpenshell>[1]> = {},
  assertCurrent = authority.assertCurrent,
) {
  assertCurrent();
  try {
    return captureResolvedOpenshell(args, {
      ...options,
      env: authority.env,
      openshellBinary: authority.executablePath,
      replaceEnv: true,
    });
  } finally {
    assertCurrent();
  }
}

function hermesPortableLaunchReadinessDeps(
  authority: HermesPortableReadinessCommandAuthority,
  probeTiming?: ProbeTimingRecorder,
  assertCurrent = authority.assertCurrent,
): NonNullable<Parameters<typeof inspectLaunchReadiness>[1]> {
  const capture = (
    args: string[],
    options: NonNullable<Parameters<typeof captureResolvedOpenshell>[1]> = {},
  ) => captureHermesPortableReadinessObservation(authority, args, options, assertCurrent);
  return {
    ...createBoundLaunchReadinessDeps(capture),
    ...probeTimingLaunchReadinessDeps(probeTiming),
  };
}

function portableAgentLifecycleAuthorityDeps() {
  return { readRegistry: registry.getSandbox };
}

type HermesPortableForwardConnectRecoveryInput = {
  readonly intent: "connect-probe-only";
  readonly sandboxName: string;
  readonly authority: HermesPortableActiveLifecycleAuthority;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
  readonly commandAuthority?: ReturnType<typeof qualifyHermesPortableOperatingCommandAuthority>;
};

function hermesPortableForwardInputForConnectProbe(
  input: HermesPortableForwardConnectRecoveryInput,
) {
  const expectedEntry = structuredClone(input.authority.entry);
  const assertRegistryCurrent = () => {
    const current = requireHermesPortableActiveLifecycleAuthority(
      input.sandboxName,
      input.authority,
      { readRegistry: input.readRegistry },
    );
    if (
      current.gatewayName !== input.authority.gatewayName ||
      !isDeepStrictEqual(current.entry, expectedEntry) ||
      !isDeepStrictEqual(input.readRegistry(input.sandboxName), expectedEntry)
    ) {
      throw new Error("Hermes Portable registry authority changed during forward recovery.");
    }
  };

  let commandAuthority: ReturnType<typeof qualifyHermesPortableOperatingCommandAuthority>;
  try {
    assertRegistryCurrent();
    commandAuthority =
      input.commandAuthority ?? qualifyHermesPortableOperatingCommandAuthority(input.sandboxName);
    commandAuthority.assertCurrent();
  } catch {
    throw new HermesPortableForwardRecoveryError("authority-drift");
  }
  const assertCommandCurrent = () => commandAuthority.assertCurrent();
  const assertProductCurrent = () => {
    assertRegistryCurrent();
    assertCommandCurrent();
  };
  let ports: number[] | null;
  try {
    ports = resolveSandboxLaunchForwardPorts(input.sandboxName);
  } catch {
    throw new HermesPortableForwardRecoveryError("forward-state-unavailable");
  }
  try {
    assertProductCurrent();
  } catch {
    throw new HermesPortableForwardRecoveryError("authority-drift");
  }
  if (!ports || ports.length === 0) {
    throw new HermesPortableForwardRecoveryError("forward-state-unavailable");
  }

  return createHermesPortableForwardRecoveryInput({
    assertCurrent: assertProductCurrent,
    assertRollbackCurrent: assertCommandCurrent,
    commandAuthority,
    gatewayName: input.authority.gatewayName,
    intent: input.intent,
    onTiming: writeHermesPortableForwardRecoveryTiming,
    ports,
    sandboxName: input.sandboxName,
  });
}

/** Restore the launch-readiness forwards through current Hermes command authority. */
function prepareHermesPortableForwardsForConnectProbe(
  input: HermesPortableForwardConnectRecoveryInput,
) {
  return prepareHermesPortableLaunchForwards(hermesPortableForwardInputForConnectProbe(input));
}

function writeHermesPortableForwardRecoveryTiming(
  evidence: HermesPortableForwardRecoveryTimingEvidence,
): void {
  console.log(
    `  Hermes Portable forward recovery timing: list=${String(evidence.listMs)}ms listCount=${String(evidence.listCount)} stop=${String(evidence.stopMs)}ms stopCount=${String(evidence.stopCount)} start=${String(evidence.startMs)}ms startCount=${String(evidence.startCount)} settle=${String(evidence.settleMs)}ms settleCount=${String(evidence.settleCount)} total=${String(evidence.totalMs)}ms result=${evidence.result}`,
  );
}

function writeHermesPortableCurrentnessTiming(
  evidence: HermesPortableCurrentnessTimingEvidence,
): void {
  console.log(
    `  Hermes Portable currentness timing: receiptRead=${String(evidence.receiptReadMs)}ms receiptReadCount=${String(evidence.receiptReadCount)} socketAuthority=${String(evidence.socketAuthorityMs)}ms socketAuthorityCount=${String(evidence.socketAuthorityCount)} openshellExecutable=${String(evidence.openshellExecutableMs)}ms openshellExecutableCount=${String(evidence.openshellExecutableCount)} podmanExecutable=${String(evidence.podmanExecutableMs)}ms podmanExecutableCount=${String(evidence.podmanExecutableCount)} podmanPathResolution=${String(evidence.podmanPathResolutionMs)}ms podmanPathResolutionCount=${String(evidence.podmanPathResolutionCount)} podmanCanonicalRealpath=${String(evidence.podmanCanonicalRealpathMs)}ms podmanCanonicalRealpathCount=${String(evidence.podmanCanonicalRealpathCount)} podmanDirectoryChain=${String(evidence.podmanDirectoryChainMs)}ms podmanDirectoryChainCount=${String(evidence.podmanDirectoryChainCount)} podmanExecutableMetadata=${String(evidence.podmanExecutableMetadataMs)}ms podmanExecutableMetadataCount=${String(evidence.podmanExecutableMetadataCount)} podmanContentRead=${String(evidence.podmanContentReadMs)}ms podmanContentReadCount=${String(evidence.podmanContentReadCount)} podmanContentHash=${String(evidence.podmanContentHashMs)}ms podmanContentHashCount=${String(evidence.podmanContentHashCount)} podmanAuthorityCompare=${String(evidence.podmanAuthorityCompareMs)}ms podmanAuthorityCompareCount=${String(evidence.podmanAuthorityCompareCount)} containerInspect=${String(evidence.containerInspectMs)}ms containerInspectCount=${String(evidence.containerInspectCount)} transactionCompare=${String(evidence.transactionCompareMs)}ms transactionCompareCount=${String(evidence.transactionCompareCount)}`,
  );
}

function writeHermesPortableInspectionTiming(
  evidence: HermesPortableContainerInspectionTimingEvidence,
): void {
  console.log(
    `  Hermes Portable inspection timing: preGuard=${String(evidence.preGuardMs)}ms preGuardCount=${String(evidence.preGuardCount)} podmanCapture=${String(evidence.podmanCaptureMs)}ms podmanCaptureCount=${String(evidence.podmanCaptureCount)} postGuard=${String(evidence.postGuardMs)}ms postGuardCount=${String(evidence.postGuardCount)} jsonParse=${String(evidence.jsonParseMs)}ms jsonParseCount=${String(evidence.jsonParseCount)} identityCompare=${String(evidence.identityCompareMs)}ms identityCompareCount=${String(evidence.identityCompareCount)}`,
  );
}

function writeHermesPortableLifecycleRecoveryTiming(
  evidence: HermesPortableLifecycleRecoveryTimingEvidence,
): void {
  console.log(
    `  Hermes Portable lifecycle recovery timing: entryQualification=${String(evidence.entryQualificationMs)}ms containerStart=${String(evidence.containerStartMs)}ms postStartCurrentness=${String(evidence.postStartCurrentnessMs)}ms execReady=${String(evidence.execReadyMs)}ms execReadyCurrentness=${String(evidence.execReadyCurrentnessMs)}ms execReadyCommand=${String(evidence.execReadyCommandMs)}ms execReadySleep=${String(evidence.execReadySleepMs)}ms preHealthCurrentness=${String(evidence.preHealthCurrentnessMs)}ms authenticatedHealth=${String(evidence.authenticatedHealthMs)}ms authenticatedHealthPodman=${String(evidence.authenticatedHealthPodmanMs)}ms authenticatedHealthOpenShell=${String(evidence.authenticatedHealthOpenShellMs)}ms authenticatedHealthSleep=${String(evidence.authenticatedHealthSleepMs)}ms startupLaunch=${String(evidence.startupLaunchMs)}ms healthPollCurrentness=${String(evidence.healthPollCurrentnessMs)}ms finalQualification=${String(evidence.finalQualificationMs)}ms rollback=${String(evidence.rollbackMs)}ms qualificationCount=${String(evidence.qualificationCount)} transactionCurrentnessCount=${String(evidence.transactionCurrentnessCount)} containerInspectionCount=${String(evidence.containerInspectionCount)} containerStartCount=${String(evidence.containerStartCount)} execReadyAttempts=${String(evidence.execReadyAttempts)} authenticatedHealthCount=${String(evidence.authenticatedHealthCount)} startupLaunchCount=${String(evidence.startupLaunchCount)} rollbackCount=${String(evidence.rollbackCount)} total=${String(evidence.totalMs)}ms containerAction=${evidence.containerAction} result=${evidence.result}`,
  );
}

/** Verify the launch-readiness forwards without starting or stopping them. */
function verifyHermesPortableForwardsForConnectProbe(
  input: HermesPortableForwardConnectRecoveryInput,
) {
  return verifyHermesPortableLaunchForwards(hermesPortableForwardInputForConnectProbe(input));
}

function recoverHermesPortableForwardsForConnectProbeOrExit(
  sandboxName: string,
  authority: HermesPortableActiveLifecycleAuthority,
  probeTiming?: ProbeTimingRecorder,
  commandAuthority?: ReturnType<typeof qualifyHermesPortableOperatingCommandAuthority>,
): void {
  try {
    const prepared = prepareHermesPortableForwardsForConnectProbeMeasured(
      sandboxName,
      authority,
      probeTiming,
      commandAuthority,
    );
    const forwardRecovery = prepared.release();
    probeTiming?.setForwardAction(forwardRecovery.kind === "restored" ? "restored" : "verified");
  } catch (error) {
    failHermesPortableForwardRecovery(
      sandboxName,
      error instanceof HermesPortableForwardRecoveryError ? error.failure : "recovery-failed",
    );
  }
}

function prepareHermesPortableForwardsForConnectProbeMeasured(
  sandboxName: string,
  authority: HermesPortableActiveLifecycleAuthority,
  probeTiming?: ProbeTimingRecorder,
  commandAuthority?: ReturnType<typeof qualifyHermesPortableOperatingCommandAuthority>,
) {
  try {
    const prepare = () =>
      prepareHermesPortableForwardsForConnectProbe({
        intent: "connect-probe-only",
        sandboxName,
        authority,
        readRegistry: registry.getSandbox,
        ...(commandAuthority ? { commandAuthority } : {}),
      });
    return probeTiming ? probeTiming.measure("forward", prepare) : prepare();
  } catch (error) {
    probeTiming?.setForwardAction("failed");
    probeTiming?.markFailureStage("forward");
    throw error instanceof HermesPortableForwardRecoveryError
      ? error
      : new HermesPortableForwardRecoveryError("recovery-failed");
  }
}

class HermesPortableInferenceRouteVerificationError extends Error {
  constructor(readonly reason: string) {
    super("Hermes Portable inference route verification failed");
  }
}

function refuseHermesPortableInferenceRoute(reason: string): never {
  throw new HermesPortableInferenceRouteVerificationError(reason);
}

/** Verify the recorded Hermes route without invoking repair or process exit. */
function verifyHermesPortableInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  expectedAuthority?: HermesPortableActiveLifecycleAuthority,
  commandAuthority?: HermesPortableReadinessCommandAuthority,
): SandboxEntry {
  let authority: ReturnType<typeof requireHermesPortableActiveLifecycleAuthority>;
  try {
    authority = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      expectedAuthority,
      portableAgentLifecycleAuthorityDeps(),
    );
  } catch {
    refuseHermesPortableInferenceRoute("missing or incomplete");
  }
  const sandbox = authority.entry;
  const inference = registry.getSandboxEntryInference(sandbox);
  if (inference.kind !== "configured") {
    refuseHermesPortableInferenceRoute("not configured");
  }
  assertNoOpenShellGatewayEndpointOverride();
  const routeAuthority = {
    gatewayName: sandbox.gatewayName,
    lifecycleGeneration: sandbox.lifecycleGeneration,
    provider: inference.provider,
    model: inference.model,
  } as const;
  const capture = (
    args: string[],
    options: { readonly includeStreams?: boolean; readonly timeout: number },
  ) =>
    commandAuthority
      ? captureHermesPortableReadinessObservation(commandAuthority, args, options)
      : captureHermesPortableOpenShell(sandboxName, args, options);
  const liveResult = capture(buildGatewayInferenceGetArgs(authority.gatewayName), {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (liveResult.status !== 0 || liveResult.error) {
    refuseHermesPortableInferenceRoute("unreachable");
  }
  const live = parseGatewayInference(liveResult.output);
  if (planInferenceRouteReconcile(live, inference).kind !== "aligned") {
    refuseHermesPortableInferenceRoute("different from its recorded provider or model");
  }
  const probe = parseSandboxInferenceRouteProbeResult(
    capture(buildSandboxInferenceRouteProbeArgs(sandboxName, agent, authority.gatewayName), {
      includeStreams: true,
      timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
    }),
  );
  if (
    !probe.healthy ||
    (inference.provider === "ollama-local" &&
      (probe.httpStatus === undefined || probe.httpStatus < 200 || probe.httpStatus >= 300))
  ) {
    refuseHermesPortableInferenceRoute("unreachable");
  }
  let finalAuthority: ReturnType<typeof requireHermesPortableActiveLifecycleAuthority>;
  try {
    finalAuthority = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      authority,
      portableAgentLifecycleAuthorityDeps(),
    );
  } catch {
    refuseHermesPortableInferenceRoute("changed during verification");
  }
  if (
    finalAuthority.entry.gatewayName !== routeAuthority.gatewayName ||
    finalAuthority.entry.lifecycleGeneration !== routeAuthority.lifecycleGeneration ||
    finalAuthority.entry.provider !== routeAuthority.provider ||
    finalAuthority.entry.model !== routeAuthority.model
  ) {
    refuseHermesPortableInferenceRoute("changed during verification");
  }
  return finalAuthority.entry;
}

/** Verify the recorded Hermes route without invoking any inference repair. */
function verifyHermesPortableInferenceRouteOrExit(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  expectedAuthority?: HermesPortableActiveLifecycleAuthority,
  commandAuthority?: HermesPortableReadinessCommandAuthority,
): SandboxEntry {
  try {
    return verifyHermesPortableInferenceRoute(
      sandboxName,
      agent,
      expectedAuthority,
      commandAuthority,
    );
  } catch (error) {
    failHermesPortableInferenceRoute(
      sandboxName,
      error instanceof HermesPortableInferenceRouteVerificationError ? error.reason : "unreachable",
    );
  }
}

type HermesPortableProbeRouteResult = {
  readonly forwardsRecovered: boolean;
};

type HermesPortableProbeRouteOptions = {
  readonly commandAuthority?: HermesPortableReadinessCommandAuthority;
  readonly probeTiming?: ProbeTimingRecorder;
  readonly validateVerified?: (entry: SandboxEntry) => void;
};

/** Verify the recorded route and resume published Ollama only for probe-only recovery. */
function verifyOrRecoverHermesPortableInferenceRouteForProbeOnlyOrExit(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  expectedAuthority?: HermesPortableActiveLifecycleAuthority,
  options: HermesPortableProbeRouteOptions = {},
): HermesPortableProbeRouteResult {
  let authority: HermesPortableActiveLifecycleAuthority;
  try {
    authority = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      expectedAuthority,
      portableAgentLifecycleAuthorityDeps(),
    );
  } catch {
    failHermesPortableInferenceRoute(sandboxName, "missing or incomplete");
  }
  if (authority.entry.provider !== "ollama-local") {
    const entry = verifyHermesPortableInferenceRouteOrExit(
      sandboxName,
      agent,
      authority,
      options.commandAuthority,
    );
    try {
      options.validateVerified?.(entry);
    } catch {
      failHermesPortableInferenceRoute(sandboxName, "changed during verification");
    }
    return { forwardsRecovered: false };
  }
  let verified: SandboxEntry | null = null;
  let preparedForwards: PreparedHermesPortableForwardRecovery | null = null;
  try {
    recoverHermesPortableInferenceForConnectProbe({
      sandboxName,
      authority,
      readRegistry: registry.getSandbox,
      assertCallerTransactionCurrent: options.commandAuthority?.assertTransactionCurrent,
      assertCallerCurrent: options.commandAuthority?.assertCurrent,
      ...(options.commandAuthority
        ? {
            runGatewayOpenshell: (
              _sandboxName: string,
              args: string[],
              captureOptions: { readonly env?: NodeJS.ProcessEnv; readonly timeout: number },
            ) => {
              if (captureOptions.env && Object.keys(captureOptions.env).length > 0) {
                throw new Error(
                  "Hermes Portable inference recovery rejected command environment drift.",
                );
              }
              return captureHermesPortableReadinessObservation(options.commandAuthority!, args, {
                ignoreError: true,
                includeStreams: true,
                timeout: captureOptions.timeout,
              });
            },
          }
        : {}),
      verifyRoute: () => {
        verified = verifyHermesPortableInferenceRoute(
          sandboxName,
          agent,
          authority,
          options.commandAuthority,
        );
        try {
          options.validateVerified?.(verified);
        } catch {
          refuseHermesPortableInferenceRoute("changed during verification");
        }
        return verified;
      },
      prepareProbeDependency: () => {
        preparedForwards = prepareHermesPortableForwardsForConnectProbeMeasured(
          sandboxName,
          authority,
          options.probeTiming,
          options.commandAuthority,
        );
        return preparedForwards;
      },
    });
  } catch (error) {
    if (error instanceof HermesPortableForwardRecoveryError) {
      failHermesPortableForwardRecovery(sandboxName, error.failure);
    }
    if (error instanceof HermesPortableInferenceRouteVerificationError) {
      failHermesPortableInferenceRoute(sandboxName, error.reason);
    }
    failHermesPortableInferenceRecovery(
      sandboxName,
      classifyHermesPortableInferenceConnectRecoveryFailure(error),
    );
  }
  const retainedForwards = preparedForwards as PreparedHermesPortableForwardRecovery | null;
  if (!verified || !retainedForwards) {
    failHermesPortableInferenceRoute(sandboxName, "unreachable");
  }
  options.probeTiming?.setForwardAction(
    retainedForwards.result.kind === "restored" ? "restored" : "verified",
  );
  return { forwardsRecovered: true };
}

const GATEWAY_UNAVAILABLE_RE =
  /No gateway configured|No active gateway|Connection refused|client error \(Connect\)|tcp connect error|Status:\s*Disconnected/i;

function isBlockingGatewayLifecycle(
  lifecycle: ReturnType<typeof getNamedGatewayLifecycleState>,
): boolean {
  if (lifecycle.state === "named_unreachable" || lifecycle.state === "named_unhealthy") {
    return true;
  }
  return lifecycle.state === "missing_named" && GATEWAY_UNAVAILABLE_RE.test(lifecycle.status || "");
}

function failConnectReadinessGatewayUnavailable(sandboxName: string, detailOutput = ""): never {
  console.error("");
  console.error(
    `  OpenShell gateway is not running or unreachable; cannot verify sandbox '${sandboxName}' readiness.`,
  );
  if (detailOutput.trim()) {
    console.error(detailOutput.trimEnd());
    printGatewayLifecycleHint(detailOutput, sandboxName, console.error);
  }
  console.error("  Recovery:");
  console.error(`    1. ${gatewayStartGuidance(getSandboxTargetGatewayName(sandboxName))}`);
  console.error(`    2. Retry: ${CLI_NAME} ${sandboxName} connect`);
  process.exit(1);
}

function failConnectReadinessObservation(sandboxName: string, error: OpenShellSandboxError): never {
  if (error.kind === "transport") {
    failConnectReadinessGatewayUnavailable(sandboxName, error.message);
  }

  console.error("");
  switch (error.kind) {
    case "authentication":
      console.error(
        `  OpenShell could not authenticate while checking sandbox '${sandboxName}' readiness.`,
      );
      console.error("  Restore authentication for the sandbox's recorded gateway, then retry.");
      break;
    case "schema":
      console.error(
        `  The OpenShell CLI and gateway schemas do not match; cannot verify sandbox '${sandboxName}' readiness.`,
      );
      console.error("  Use matching supported OpenShell CLI and gateway versions, then retry.");
      break;
    case "timeout":
      console.error(`  The OpenShell readiness request for sandbox '${sandboxName}' timed out.`);
      console.error("  Check gateway health and retry after it responds.");
      break;
    case "command":
      console.error(`  The OpenShell readiness request for sandbox '${sandboxName}' failed.`);
      console.error(
        `  Run \`${CLI_NAME} ${sandboxName} status\` to inspect the failure before retrying.`,
      );
      break;
  }
  console.error(`  ${error.message}`);
  process.exit(1);
}

// Fail fast with Docker-outage guidance instead of polling to the readiness
// timeout. Only fires for Docker-driver sandboxes whose `docker info` is
// failing (#4428).
function failConnectReadinessDockerRuntimeDown(sandboxName: string): never {
  console.error("");
  printDockerRuntimeDownGuidance(sandboxName, { writer: console.error, retryCommand: "connect" });
  process.exit(1);
}

function failIfGatewayBlocksConnectReadiness(sandboxName: string): void {
  const sb = registry.getSandbox(sandboxName);
  const lifecycle = getNamedGatewayLifecycleState(resolveSandboxGatewayName(sb));
  if (isBlockingGatewayLifecycle(lifecycle)) {
    failConnectReadinessGatewayUnavailable(
      sandboxName,
      lifecycle.status || lifecycle.gatewayInfo || "",
    );
  }
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  if (process.env.VITEST === "true" || process.env.NEMOCLAW_TEST_NO_SLEEP === "1") return;
  spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${milliseconds})`], {
    stdio: "ignore",
    timeout: milliseconds + 1_000,
  });
}

export function probeSandboxInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  { attempts = 1, delayMs = 0 }: InferenceRouteProbeOptions = {},
): SandboxInferenceRouteProbe {
  const attemptCount = Math.max(1, Math.floor(attempts));
  return retryUntil(
    () => {
      // Keep the shell string inside the sandbox: curl write-out, body capture,
      // and status classification must run as one bounded probe. sandboxName
      // remains an argv value, so no user input is interpolated into the script.
      const probe = captureOpenshell(buildSandboxInferenceRouteProbeArgs(sandboxName, agent), {
        ignoreError: true,
        includeStreams: true,
        timeout: OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS,
      });
      const parsed = parseSandboxInferenceRouteProbeResult(probe);
      return {
        healthy: parsed.healthy,
        broken: parsed.broken,
        httpStatus: parsed.httpStatus,
        detail: parsed.detail,
      };
    },
    {
      accept: (result) => result.healthy,
      retryDelaysMs: Array.from({ length: attemptCount - 1 }, () => delayMs),
      sleep: sleepSync,
    },
  );
}

function shouldUseLegacyDnsProxyRepair(sb: SandboxEntry | null): boolean {
  // The legacy repair patches CoreDNS inside an `openshell-cluster-<name>`
  // container, which only the k3s/kubernetes gateway runs. The docker driver
  // runs the gateway as `nemoclaw-openshell-gateway` with host networking, and
  // the vm driver has no cluster container either, so both recover the route via
  // `openshell inference set` instead of the cluster CoreDNS patch. Mirrors
  // usesGatewayMetadataProbe (snapshot.ts). (#3403)
  return sandboxUsesLegacyClusterGateway(sb);
}

function reapplyVmInferenceRoute(
  sandboxName: string,
  sb: SandboxEntry | null,
  agent: InferenceRouteProbeAgent,
  gatewayName: string,
): SandboxInferenceRouteProbe | null {
  const inference = sb ? registry.getSandboxEntryInference(sb) : null;
  if (inference?.kind !== "configured") return null;
  runOpenshell(buildGatewayInferenceSetArgs(gatewayName, inference.provider, inference.model), {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  return probeSandboxInferenceRoute(sandboxName, agent);
}

export function repairSandboxInferenceRouteWithDeps(
  sandboxName: string,
  sb: SandboxEntry | null,
  { quiet = false }: { quiet?: boolean } = {},
  deps: SandboxInferenceRouteRepairDeps,
): SandboxInferenceRouteRepairResult {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  deps.assertRouteCompatible?.(sandboxName, sb);
  const initialProbe = deps.probe(sandboxName);
  if (initialProbe.healthy) {
    return { healthy: true, repairAttempted: false, detail: initialProbe.detail };
  }
  if (deps.isRepairDisabled?.()) {
    return {
      healthy: false,
      repairAttempted: false,
      detail: `route repair disabled; ${initialProbe.detail}`,
    };
  }
  if (!initialProbe.broken) {
    return { healthy: false, repairAttempted: false, detail: initialProbe.detail };
  }
  if (!shouldUseLegacyDnsProxyRepair(sb)) {
    if (deps.shouldApplyVmDnsMonkeypatch(sb)) {
      if (!quiet) {
        log("");
        log(
          `  inference.local is unavailable inside '${sandboxName}'. Applying OpenShell VM DNS monkeypatch...`,
        );
      }
      const patch = deps.applyVmDnsMonkeypatch(sandboxName, sb);
      const patchedProbe = patch.ok
        ? deps.probe(sandboxName, {
            attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
            delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
          })
        : null;
      if (patchedProbe?.healthy) {
        if (!quiet) {
          log("  inference.local route repaired.");
        }
        return {
          healthy: true,
          repairAttempted: true,
          detail: patchedProbe.detail,
        };
      }
      if (!quiet) {
        if (!patch.ok && patch.reason) {
          error(`  Warning: OpenShell VM DNS monkeypatch did not apply: ${patch.reason}`);
        } else if (patchedProbe?.broken) {
          error(
            "  Warning: OpenShell VM DNS monkeypatch completed but inference.local is still unavailable.",
          );
        }
      }
    }

    if (!quiet) {
      log("");
      log(
        `  inference.local is unavailable inside '${sandboxName}'. Reapplying OpenShell inference route...`,
      );
    }
    const finalProbe = deps.reapplyVmInferenceRoute(sandboxName, sb);
    if (!quiet) {
      if (finalProbe?.healthy) {
        log("  inference.local route repaired.");
      } else if (finalProbe?.broken) {
        error(
          `  Warning: inference.local is still unavailable through the OpenShell ${sb?.openshellDriver || "non-legacy"} gateway path.`,
        );
      }
    }
    if (!finalProbe) {
      return {
        healthy: false,
        repairAttempted: true,
        detail: "missing sandbox provider or model",
      };
    }
    return {
      healthy: finalProbe.healthy,
      repairAttempted: true,
      detail: finalProbe.detail,
    };
  }

  if (!quiet) {
    log("");
    log(`  inference.local is unavailable inside '${sandboxName}'. Repairing sandbox DNS proxy...`);
  }
  const repair = deps.repairLegacyDnsProxy(sandboxName, quiet);
  if (repair.exitCode !== 0) {
    if (!quiet) {
      error("  Warning: failed to repair sandbox DNS proxy.");
      if (repair.message) error(`  ${repair.message}`);
    }
    return {
      healthy: false,
      repairAttempted: true,
      detail: repair.message || initialProbe.detail,
    };
  }

  const repairedProbe = deps.probe(sandboxName, {
    attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
    delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
  });
  if (!quiet) {
    if (repairedProbe.healthy) {
      log("  inference.local route repaired.");
    } else if (repairedProbe.broken) {
      error("  Warning: inference.local is still unavailable after DNS proxy repair.");
    }
  }
  return {
    healthy: repairedProbe.healthy,
    repairAttempted: true,
    detail: repairedProbe.detail,
  };
}

function repairSandboxInferenceRouteIfNeeded(
  sandboxName: string,
  sb: SandboxEntry | null,
  agent: InferenceRouteProbeAgent,
  gatewayName: string,
  { quiet = false }: { quiet?: boolean } = {},
): SandboxInferenceRouteRepairResult {
  return repairSandboxInferenceRouteWithDeps(
    sandboxName,
    sb,
    { quiet },
    {
      isRepairDisabled: () => process.env.NEMOCLAW_DISABLE_INFERENCE_ROUTE_REPAIR === "1",
      probe: (name, options) => probeSandboxInferenceRoute(name, agent, options),
      shouldApplyVmDnsMonkeypatch,
      applyVmDnsMonkeypatch: applyOpenShellVmDnsMonkeypatch,
      reapplyVmInferenceRoute: (name, sandbox) =>
        reapplyVmInferenceRoute(name, sandbox, agent, gatewayName),
      repairLegacyDnsProxy: (name, isQuiet) =>
        runSetupDnsProxy(
          { gatewayName, sandboxName: name },
          { log: isQuiet ? () => undefined : console.log },
        ),
      assertRouteCompatible: (name, sandbox) => {
        if (sandbox) assertSandboxGatewayRouteCompatible(name, sandbox, gatewayName);
      },
    },
  );
}

function verifyLocalInferenceRouteDependencies(
  provider: string,
  { quiet = false }: { quiet?: boolean } = {},
): boolean {
  const isOllamaLocal = provider === "ollama-local";
  if (isOllamaLocal) {
    findReachableOllamaHost();
    if (!isWsl()) {
      ensureOllamaAuthProxy();
    }
  }
  const localHealth = probeLocalProviderHealth(provider, {
    skipOllamaAuthProxySubprobe: isOllamaLocal,
  });
  if (!localHealth) return true;
  if (!localHealth.ok) {
    if (!quiet) {
      console.error(`  Error: ${localHealth.detail}`);
    }
    return false;
  }

  if (isOllamaLocal && !isWsl()) {
    const proxyHealth = probeOllamaAuthProxyHealth();
    if (!proxyHealth.ok) {
      if (!quiet) {
        console.error(`  Error: ${proxyHealth.detail}`);
      }
      return false;
    }
  }

  return true;
}

function printUnrecoverableInferenceRoute(
  sandboxName: string,
  route: string,
  detail: string,
  { repairAttempted = true }: { repairAttempted?: boolean } = {},
): void {
  const reason = repairAttempted
    ? `inference.local is still unavailable inside '${sandboxName}' after DNS and route repair.`
    : `the authoritative inference.local probe inside '${sandboxName}' did not return a trusted result.`;
  const boundedDetail = sanitizeRouteValueForDisplay(redact(detail))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  console.error(`  Error: ${reason}`);
  console.error(`  Route: ${route}`);
  if (boundedDetail) console.error(`  Last probe: ${boundedDetail}`);
  console.error(`  Run:  ${CLI_NAME} ${sandboxName} doctor`);
  console.error(
    repairAttempted
      ? "  Connect is stopping because the sandbox inference route is known to be broken."
      : "  Connect is stopping because the sandbox inference route is not known healthy.",
  );
}

export function resetManagedInferenceRouteWithDeps(
  sandboxName: string,
  sb: SandboxEntry,
  { detail, quiet = false }: { detail: string; quiet?: boolean },
  deps: ManagedInferenceRouteResetDeps,
): boolean {
  const log = deps.log ?? console.log;
  const inference = registry.getSandboxEntryInference(sb);
  if (inference.kind !== "configured") return false;
  const { provider, model } = inference;
  const route = `${sanitizeRouteValueForDisplay(provider)}/${sanitizeRouteValueForDisplay(model)}`;
  const fail = (failureDetail: string, message?: string): false => {
    if (!quiet) {
      if (message) (deps.error ?? console.error)(message);
      deps.printUnrecoverableInferenceRoute(sandboxName, route, failureDetail);
    }
    return false;
  };

  if (!deps.verifyLocalInferenceRouteDependencies(provider, { quiet })) {
    return fail(detail);
  }

  if (!quiet) log(`  Resetting inference route to ${route}.`);
  const resetResult = deps.runInferenceSet(provider, model);
  const resetFailed = resetResult.status !== 0;
  if (!resetFailed && !deps.verifyLocalInferenceRouteDependencies(provider, { quiet })) {
    return fail(detail);
  }

  const finalProbe = deps.probe(sandboxName, {
    attempts: INFERENCE_ROUTE_POST_REPAIR_PROBE_ATTEMPTS,
    delayMs: INFERENCE_ROUTE_POST_REPAIR_PROBE_DELAY_MS,
  });
  if (finalProbe.healthy) {
    if (!quiet) log("  inference.local route repaired.");
    return true;
  }

  return fail(
    resetFailed ? finalProbe.detail || detail : finalProbe.detail,
    resetFailed ? "  Error: failed to reset the OpenShell inference route." : undefined,
  );
}

function resetManagedInferenceRoute(
  sandboxName: string,
  sb: SandboxEntry,
  agent: InferenceRouteProbeAgent,
  gatewayName: string,
  { detail, quiet = false }: { detail: string; quiet?: boolean },
): boolean {
  return resetManagedInferenceRouteWithDeps(
    sandboxName,
    sb,
    { detail, quiet },
    {
      verifyLocalInferenceRouteDependencies,
      runInferenceSet: (provider, model) =>
        runOpenshell(buildGatewayInferenceSetArgs(gatewayName, provider, model), {
          ignoreError: true,
          timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
        }),
      probe: (name, options) => probeSandboxInferenceRoute(name, agent, options),
      printUnrecoverableInferenceRoute,
    },
  );
}

function ensureSandboxInferenceRouteUnlocked(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  { quiet = false }: { quiet?: boolean } = {},
): SandboxInferenceRouteEnsureResult {
  let sb: SandboxEntry | null = null;
  let inference: ReturnType<typeof registry.getSandboxEntryInference> | null = null;
  try {
    sb = registry.getSandbox(sandboxName);
    if (!sb) return { sandbox: null, routeHealthy: null };
    // This projection is total; the catch below handles only later gateway and repair failures.
    inference = registry.getSandboxEntryInference(sb);
    if (inference.kind !== "configured") return { sandbox: sb, routeHealthy: null };
    assertNoOpenShellGatewayEndpointOverride();
    const { provider, model } = inference;
    const gatewayName = resolveSandboxGatewayName(sb);
    // The live route exposes only provider/model. Prove the target's durable
    // custom endpoint/API identity before any route read, probe, or mutation.
    assertSandboxGatewayRouteCompatible(sandboxName, sb, gatewayName);
    const live = parseGatewayInference(
      captureOpenshell(buildGatewayInferenceGetArgs(gatewayName), {
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      }).output,
    );
    const plan = planInferenceRouteReconcile(live, { provider, model });
    if (plan.kind !== "aligned") {
      const recordedRoute = `${sanitizeRouteValueForDisplay(provider)}/${sanitizeRouteValueForDisplay(model)}`;
      if (plan.kind === "diverged") {
        // Shared gateway: re-point loudly (even when quiet) — silent revert was
        // #3726. Values sanitized: registry/gateway strings are untrusted.
        const display = formatInferenceRouteDriftForDisplay(
          plan.live,
          plan.recorded,
          `for sandbox '${sandboxName}'`,
        );
        const { liveProvider, liveModel } = display;
        console.error(`  ${YW}Warning: ${display.warning}${R}`);
        console.error(
          `  ${YW}Aligning the gateway to ${recordedRoute}. To keep ` +
            `${liveProvider}/${liveModel}, set it the supported way:${R}`,
        );
        console.error(
          `    ${CLI_NAME} inference set --provider ${shellQuote(liveProvider)} --model ${shellQuote(liveModel)} --sandbox ${shellQuote(sandboxName)}`,
        );
      } else if (!quiet) {
        // plan.kind === "repair": empty gateway, genuine repair — quiet-aware.
        console.log(`  Setting inference route to ${recordedRoute} for sandbox '${sandboxName}'`);
      }
      const swapResult = runOpenshell(buildGatewayInferenceSetArgs(gatewayName, provider, model), {
        ignoreError: true,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      });
      if (swapResult.status !== 0 && (plan.kind === "diverged" || !quiet)) {
        console.error(
          `  ${YW}Warning: failed to switch inference route — connect will proceed anyway.${R}`,
        );
      }
    }
    const repairResult = repairSandboxInferenceRouteIfNeeded(sandboxName, sb, agent, gatewayName, {
      quiet,
    });
    if (!repairResult.healthy && !repairResult.repairAttempted) {
      // Unavailable or malformed probe output is a permanent fail-closed
      // classification at the OpenShell exec/DNS/TLS/proxy boundary. There is
      // no trustworthy failure state to repair, so stop without mutating the
      // route and preserve the bounded probe evidence for doctor diagnostics.
      if (!quiet) {
        printUnrecoverableInferenceRoute(
          sandboxName,
          `${sanitizeRouteValueForDisplay(provider)}/${sanitizeRouteValueForDisplay(model)}`,
          repairResult.detail,
          { repairAttempted: false },
        );
      }
      return { sandbox: sb, routeHealthy: false };
    }
    let routeReady = repairResult.healthy;
    if (!routeReady && repairResult.repairAttempted) {
      routeReady = resetManagedInferenceRoute(sandboxName, sb, agent, gatewayName, {
        detail: repairResult.detail,
        quiet,
      });
      if (!routeReady) return { sandbox: sb, routeHealthy: false };
    }
    if (provider === "ollama-local") {
      if (!verifyLocalInferenceRouteDependencies(provider, { quiet })) {
        return { sandbox: sb, routeHealthy: false };
      }
      const finalProbe = probeSandboxInferenceRoute(sandboxName, agent);
      const strictRouteHealthy =
        finalProbe.healthy &&
        finalProbe.httpStatus !== undefined &&
        finalProbe.httpStatus >= 200 &&
        finalProbe.httpStatus < 300;
      if (!strictRouteHealthy) {
        if (!quiet) {
          printUnrecoverableInferenceRoute(
            sandboxName,
            `${sanitizeRouteValueForDisplay(provider)}/${sanitizeRouteValueForDisplay(model)}`,
            `inference.local/v1/models must return HTTP 2xx; ${finalProbe.detail}`,
            { repairAttempted: repairResult.repairAttempted },
          );
        }
        return { sandbox: sb, routeHealthy: false };
      }
    }
    return { sandbox: sb, routeHealthy: routeReady };
  } catch (error) {
    if (!sb || inference?.kind !== "configured") return { sandbox: sb, routeHealthy: null };
    if (error instanceof OpenShellGatewayEndpointOverrideError) {
      console.error(`  Error: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof GatewayRouteConflictError) {
      console.error(`  Error: ${error.message}`);
      process.exit(1);
    }
    const detail = error instanceof Error && error.message ? error.message : String(error);
    if (!quiet) {
      console.error(`  Error: failed to verify or repair inference route: ${detail}`);
      printUnrecoverableInferenceRoute(
        sandboxName,
        `${sanitizeRouteValueForDisplay(inference.provider)}/${sanitizeRouteValueForDisplay(inference.model)}`,
        detail,
        { repairAttempted: false },
      );
    }
    return { sandbox: sb, routeHealthy: false };
  }
}

async function ensureSandboxInferenceRoute(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<SandboxInferenceRouteEnsureResult> {
  const snapshot = registry.getSandbox(sandboxName);
  if (!snapshot) return { sandbox: null, routeHealthy: null };
  if (registry.getSandboxEntryInference(snapshot).kind !== "configured")
    return { sandbox: snapshot, routeHealthy: null };
  const gatewayName = resolveSandboxGatewayName(snapshot);
  return withGatewayRouteMutationLock(gatewayName, () => {
    const lockedSnapshot = registry.getSandbox(sandboxName);
    if (
      lockedSnapshot &&
      registry.getSandboxEntryInference(lockedSnapshot).kind === "configured" &&
      resolveSandboxGatewayName(lockedSnapshot) !== gatewayName
    ) {
      console.error(
        `  Error: sandbox '${sandboxName}' changed OpenShell gateways while waiting to verify its inference route. Retry the command.`,
      );
      process.exit(1);
    }
    return ensureSandboxInferenceRouteUnlocked(sandboxName, agent, { quiet });
  });
}

async function ensureSandboxInferenceRouteOrExit(
  sandboxName: string,
  agent: InferenceRouteProbeAgent,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<SandboxEntry | null> {
  const result = await ensureSandboxInferenceRoute(sandboxName, agent, { quiet });
  if (result.routeHealthy === false) {
    process.exit(1);
  }
  return result.sandbox;
}

function maybeEnsureHermesToolGatewayBroker(sb: SandboxEntry | null): void {
  if (
    !sb ||
    sb.agent !== "hermes" ||
    !Array.isArray(sb.hermesToolGateways) ||
    sb.hermesToolGateways.length === 0
  ) {
    return;
  }
  try {
    const hermesToolGatewayBroker = require("../../hermes-tool-gateway-broker");
    hermesToolGatewayBroker.ensureHermesToolGatewayBrokerForSandboxEntry(sb);
  } catch {
    /* non-fatal — managed-tool calls will surface broker guidance if needed */
  }
}

export function restoreSandboxStartupState(sandboxName: string): SandboxStartupRecoveryResult {
  let reportedRecoveryFailureDetail: string | null = null;
  let reportedRecoveryFailureLayer: GatewayRestartFailureLayer | null = null;
  const processCheck = checkAndRecoverSandboxProcesses(sandboxName, {
    quiet: true,
    onRecoveryFailureLayer: (layer, detail) => {
      reportedRecoveryFailureLayer = layer;
      reportedRecoveryFailureDetail = detail ?? null;
    },
  });
  const directRecoveryFailureDetail =
    "recoveryFailureDetail" in processCheck ? processCheck.recoveryFailureDetail : null;
  const recoveryFailureDetail = directRecoveryFailureDetail ?? reportedRecoveryFailureDetail;
  const recoveryFailureLayer = directRecoveryFailureDetail ? null : reportedRecoveryFailureLayer;
  return Object.assign(processCheck, { recoveryFailureDetail, recoveryFailureLayer });
}

function restoreInteractiveTerminal(): void {
  if (!process.stdin.isTTY) return;

  try {
    const stdin = process.stdin as typeof process.stdin & {
      setRawMode?: (mode: boolean) => unknown;
    };
    stdin.setRawMode?.(false);
  } catch {
    // Best-effort: still try `stty sane` below.
  }

  try {
    spawnSync("stty", ["sane"], {
      stdio: ["inherit", "ignore", "ignore"],
      cwd: ROOT,
      env: process.env,
    });
  } catch {
    // Terminal cleanup must never mask the original connect failure.
  }
}

function isLikelySshDisconnect(result: SpawnLikeResult): boolean {
  return result.status === 255 || result.signal === "SIGHUP" || result.signal === "SIGPIPE";
}

function exitWithConnectSpawnResult(sandboxName: string, result: SpawnLikeResult): void {
  if (isLikelySshDisconnect(result)) {
    restoreInteractiveTerminal();
    console.error("");
    console.error(`  Gateway connection lost. Reconnect with: ${CLI_NAME} ${sandboxName} connect`);
  }
  process.exit(spawnExitCode(result));
}

type WaitForSandboxReadyOptions = {
  allowInitialErrorAfterStart?: boolean;
  allowDockerRuntimeInspection?: boolean;
  observer?: OpenShellSandboxObserver;
  defaultTimeoutSec?: number;
  retryCommand?: string;
  successLogs?: readonly string[];
};

// OpenShell can transiently publish `Error` immediately after `sandbox start`
// before the same sandbox advances through `Provisioning` to `Ready`. Its list
// output exposes no structured transition reason. A caller opts into twenty
// three-second grace polls only after it starts the container; every other
// terminal phase still fails immediately, and a persistent Error fails after
// the bound. Remove this compatibility exception once OpenShell exposes a
// structured restart signal or guarantees that post-start recovery never emits
// the terminal Error phase.
const START_INITIAL_ERROR_GRACE_POLLS = 20;

// Readiness budget for the repair paths that wait for a restarted sandbox
// before they touch in-sandbox processes or host forwards. A cold agent boot on
// a constrained host can exceed the interactive budget, and `start` and
// `connect --probe-only` prove the same readiness for the same sandbox.
export const SANDBOX_REPAIR_READY_TIMEOUT_SEC = 300;

/** Wait for a sandbox to become ready, exiting with recovery guidance on terminal failure. */
export async function waitForSandboxReadyOrExit(
  sandboxName: string,
  {
    allowInitialErrorAfterStart = false,
    allowDockerRuntimeInspection = true,
    observer = createCliOpenShellSandboxObserver({
      capture: captureOpenshell,
      defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
    }),
    defaultTimeoutSec = 120,
    retryCommand = "connect",
    successLogs = [],
  }: WaitForSandboxReadyOptions = {},
): Promise<void> {
  const rawTimeout = process.env.NEMOCLAW_CONNECT_TIMEOUT;
  let timeout = defaultTimeoutSec;
  if (rawTimeout !== undefined) {
    const parsed = parseInt(rawTimeout, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      console.warn(
        `  Warning: invalid NEMOCLAW_CONNECT_TIMEOUT="${rawTimeout}", using default ${defaultTimeoutSec}s`,
      );
    } else {
      timeout = parsed;
    }
  }
  const interval = 3;
  const startedAt = Date.now();
  const deadline = startedAt + timeout * 1000;
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000);
  const remainingMs = () => Math.max(1, deadline - Date.now());
  const observeSandbox = async (): Promise<OpenShellSandboxObservation | null> => {
    // Gateway selection is process-global and another CLI can change it while
    // this command waits. Pin each poll to the registry-recorded owner so a
    // same-named sandbox on a sibling gateway cannot satisfy readiness.
    const result = await observer.listSandboxes({
      target: namedOpenShellGateway(gatewayName),
      timeoutMs: remainingMs(),
    });
    if (!result.ok) {
      if (result.error.kind === "timeout" && Date.now() >= deadline) return null;
      failConnectReadinessObservation(sandboxName, result.error);
    }
    return result.value.sandboxes.find((sandbox) => sandbox.name === sandboxName) ?? null;
  };

  const initial = await observeSandbox();
  if (initial?.readiness === "ready") return;

  const status = initial?.phase ?? null;
  if (status && /^unknown$/i.test(status)) {
    failIfGatewayBlocksConnectReadiness(sandboxName);
  }
  let remainingInitialErrorGracePolls =
    allowInitialErrorAfterStart && status === "Error" ? START_INITIAL_ERROR_GRACE_POLLS - 1 : 0;
  if (status && TERMINAL_SANDBOX_PHASES.has(status) && remainingInitialErrorGracePolls === 0) {
    console.error("");
    console.error(`  Sandbox '${sandboxName}' is in '${status}' state.`);
    console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
    console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
    process.exit(1);
  }
  if (allowDockerRuntimeInspection && isDockerRuntimeDown(sandboxName)) {
    failConnectReadinessDockerRuntimeDown(sandboxName);
  }

  console.log(`  Waiting for sandbox '${sandboxName}' to be ready...`);
  let ready = false;
  let everSeen = status !== null;
  while (Date.now() < deadline) {
    const sleepFor = Math.min(interval, remainingMs() / 1000);
    if (sleepFor <= 0) break;
    if (process.env.VITEST !== "true" && process.env.NEMOCLAW_TEST_NO_SLEEP !== "1") {
      await new Promise<void>((resolve) => setTimeout(resolve, sleepFor * 1000));
    }
    const poll = await observeSandbox();
    const elapsed = elapsedSec();
    if (poll?.readiness === "ready") {
      ready = true;
      break;
    }
    const parsedCur = poll?.phase ?? null;
    const cur = parsedCur || "unknown";
    if (parsedCur && /^unknown$/i.test(parsedCur)) {
      failIfGatewayBlocksConnectReadiness(sandboxName);
    }
    if (cur !== "unknown") everSeen = true;
    const waitingThroughInitialError = cur === "Error" && remainingInitialErrorGracePolls > 0;
    if (waitingThroughInitialError) {
      remainingInitialErrorGracePolls -= 1;
    } else {
      remainingInitialErrorGracePolls = 0;
    }
    if (TERMINAL_SANDBOX_PHASES.has(cur) && !waitingThroughInitialError) {
      console.error("");
      console.error(`  Sandbox '${sandboxName}' entered '${cur}' state.`);
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} logs --follow`);
      console.error(`  Run:  ${CLI_NAME} ${sandboxName} status`);
      process.exit(1);
    }
    if (allowDockerRuntimeInspection && isDockerRuntimeDown(sandboxName)) {
      failConnectReadinessDockerRuntimeDown(sandboxName);
    }
    if (!everSeen && elapsed >= 30) {
      console.error("");
      console.error(`  Sandbox '${sandboxName}' not found after ${elapsed}s.`);
      console.error("  Check: openshell sandbox list");
      process.exit(1);
    }
    process.stdout.write(`\r    Status: ${cur.padEnd(20)} (${elapsed}s elapsed)`);
  }

  if (!ready) {
    const suggestedTimeout = Math.max(300, timeout * 2);
    console.error("");
    console.error(`  Timed out after ${timeout}s waiting for sandbox '${sandboxName}'.`);
    console.error("  Check: openshell sandbox list");
    console.error(
      `  Override timeout: NEMOCLAW_CONNECT_TIMEOUT=${suggestedTimeout} ${CLI_NAME} ${sandboxName} ${retryCommand}`,
    );
    process.exit(1);
  }
  console.log(`\r    Status: ${"Ready".padEnd(20)} (${elapsedSec()}s elapsed)`);
  for (const line of successLogs) console.log(line);
}

/**
 * Shared prefix of every connect-style entry point: registry/route validation,
 * the express-vLLM model preflight, the owning-gateway pin, and the Docker
 * outage fast-fail. Runs before any probe or interactive work.
 */
async function runConnectEntryPreflight(
  sandboxName: string,
  {
    probeOnly,
    probeTiming,
    hermesPortableCommandAuthority,
    retainedHermesLifecycleRecovery,
    withinLifecycleFence,
  }: {
    probeOnly: boolean;
    probeTiming?: ProbeTimingRecorder;
    hermesPortableCommandAuthority?: HermesPortableReadinessCommandAuthority;
    retainedHermesLifecycleRecovery?: {
      readonly kind: "already-running" | "recovered";
      readonly assertCurrent: () => void;
    };
    withinLifecycleFence?: (route: {
      readonly hermesPortable: boolean;
      readonly hermesPortableCommandAuthority?: HermesPortableReadinessCommandAuthority;
      readonly requalify: () => void;
    }) => Promise<void>;
  },
): Promise<void> {
  const measure = <T>(stage: "authority" | "lifecycle" | "gateway", operation: () => T): T =>
    probeTiming ? probeTiming.measure(stage, operation) : operation();
  const measureAsync = <T>(stage: "gateway", operation: () => Promise<T>): Promise<T> =>
    probeTiming ? probeTiming.measureAsync(stage, operation) : operation();
  await withConnectSandboxLifecycleLock(sandboxName, async () => {
    let hermesPortable = false;
    let requalify = () => undefined;
    try {
      measure("authority", assertNoOpenShellGatewayEndpointOverride);
      const authority = measure("authority", () =>
        qualifyPortableAgentLifecycleAuthority(sandboxName, portableAgentLifecycleAuthorityDeps()),
      );
      hermesPortable = authority.kind === "hermes";
      if (hermesPortableCommandAuthority && !hermesPortable) {
        throw new Error("Hermes portable command authority disagrees with lifecycle authority");
      }
      if (hermesPortable) {
        measure("authority", () => hermesPortableCommandAuthority?.assertCurrent());
      }
      let hermesAuthority = hermesPortable
        ? measure("authority", () =>
            requireHermesPortableActiveLifecycleAuthority(
              sandboxName,
              undefined,
              portableAgentLifecycleAuthorityDeps(),
            ),
          )
        : null;
      const registered =
        hermesAuthority?.entry ?? measure("authority", () => registry.getSandbox(sandboxName));
      if (registered?.pendingRouteReservation === true) {
        throw new Error(
          `Sandbox '${sandboxName}' is still being created by onboarding. Wait for onboarding to finish or remove the incomplete sandbox before connecting.`,
        );
      }
      const gatewayName = registered
        ? resolveSandboxGatewayName(registered)
        : getSandboxTargetGatewayName(sandboxName);
      if (registered && registry.getSandboxEntryInference(registered).kind === "configured") {
        measure("authority", () =>
          assertSandboxGatewayRouteCompatible(sandboxName, registered, gatewayName),
        );
      }
      const initialRecovery = retainedHermesLifecycleRecovery
        ? measure("authority", () => {
            retainedHermesLifecycleRecovery.assertCurrent();
            return { kind: retainedHermesLifecycleRecovery.kind } as const;
          })
        : measure("lifecycle", () =>
            hermesPortableCommandAuthority
              ? recoverPortableDemoSandboxLifecycleForConnect(
                  sandboxName,
                  registered,
                  gatewayName,
                  hermesPortableCommandAuthority,
                  hermesPortable && probeTiming
                    ? { onComplete: writeHermesPortableLifecycleRecoveryTiming }
                    : undefined,
                  hermesPortable && probeTiming
                    ? { onComplete: writeHermesPortableCurrentnessTiming }
                    : undefined,
                  hermesPortable && probeTiming
                    ? { onComplete: writeHermesPortableInspectionTiming }
                    : undefined,
                )
              : hermesPortable && probeTiming
                ? recoverPortableDemoSandboxLifecycleForConnect(
                    sandboxName,
                    registered,
                    gatewayName,
                    undefined,
                    { onComplete: writeHermesPortableLifecycleRecoveryTiming },
                    { onComplete: writeHermesPortableCurrentnessTiming },
                    { onComplete: writeHermesPortableInspectionTiming },
                  )
                : recoverPortableDemoSandboxLifecycleForConnect(
                    sandboxName,
                    registered,
                    gatewayName,
                  ),
          );
      probeTiming?.setLifecycleAction(
        initialRecovery.kind === "recovered"
          ? "recovered"
          : initialRecovery.kind === "already-running"
            ? "reused"
            : "skipped",
      );
      if (hermesPortable && initialRecovery.kind === "not-installed") {
        probeTiming?.setLifecycleAction("failed");
        probeTiming?.markFailureStage("lifecycle");
        throw new Error("Hermes portable lifecycle authority disappeared during connect");
      }
      if (hermesAuthority) {
        const currentAuthority = hermesAuthority;
        measure("authority", () => hermesPortableCommandAuthority?.assertCurrent());
        hermesAuthority = measure("authority", () =>
          requireHermesPortableActiveLifecycleAuthority(
            sandboxName,
            currentAuthority,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
      }
      requalify = () => {
        if (!hermesAuthority) {
          if (
            measure(
              "authority",
              () =>
                qualifyPortableAgentLifecycleAuthority(
                  sandboxName,
                  portableAgentLifecycleAuthorityDeps(),
                ).kind,
            ) === authority.kind
          ) {
            return;
          }
          throw new Error("portable lifecycle receipt authority changed during connect");
        }
        const currentAuthority = hermesAuthority;
        hermesAuthority = measure("authority", () =>
          requireHermesPortableActiveLifecycleAuthority(
            sandboxName,
            currentAuthority,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
        measure("authority", () => hermesPortableCommandAuthority?.assertCurrent());
        if (!probeOnly) {
          const activeAuthority = hermesAuthority;
          const currentGateway = resolveSandboxGatewayName(activeAuthority.entry);
          const recovery = measure("lifecycle", () =>
            hermesPortableCommandAuthority
              ? recoverPortableDemoSandboxLifecycleForConnect(
                  sandboxName,
                  activeAuthority.entry,
                  currentGateway,
                  hermesPortableCommandAuthority,
                  probeTiming
                    ? { onComplete: writeHermesPortableLifecycleRecoveryTiming }
                    : undefined,
                  probeTiming ? { onComplete: writeHermesPortableCurrentnessTiming } : undefined,
                  probeTiming ? { onComplete: writeHermesPortableInspectionTiming } : undefined,
                )
              : hermesPortable && probeTiming
                ? recoverPortableDemoSandboxLifecycleForConnect(
                    sandboxName,
                    activeAuthority.entry,
                    currentGateway,
                    undefined,
                    { onComplete: writeHermesPortableLifecycleRecoveryTiming },
                    { onComplete: writeHermesPortableCurrentnessTiming },
                    { onComplete: writeHermesPortableInspectionTiming },
                  )
                : recoverPortableDemoSandboxLifecycleForConnect(
                    sandboxName,
                    activeAuthority.entry,
                    currentGateway,
                  ),
          );
          if (recovery.kind === "not-installed") {
            probeTiming?.setLifecycleAction("failed");
            probeTiming?.markFailureStage("lifecycle");
            throw new Error("Hermes portable lifecycle authority disappeared during connect");
          }
          const recoveredAuthority = activeAuthority;
          hermesAuthority = measure("authority", () =>
            requireHermesPortableActiveLifecycleAuthority(
              sandboxName,
              recoveredAuthority,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          measure("authority", () => hermesPortableCommandAuthority?.assertCurrent());
        }
      };
    } catch (error) {
      probeTiming?.markFailureStage("authority");
      console.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    // probe-only / recover can restart receipt-owned local inference, but they
    // never select, install, or pull a model. Skip the express-vLLM model
    // preflight because it only steers installation and can reject recovery on
    // a stale NEMOCLAW_VLLM_MODEL.
    if (!probeOnly && !hermesPortable) preflightVllmModelEnvOrExit();
    if (!hermesPortable) {
      const live = await measureAsync("gateway", () =>
        ensureLiveSandboxOrExit(sandboxName, {
          allowNonReadyPhase: true,
          gatewayRecovery: probeOnly ? "observe" : "recover",
        }),
      );
      const livePhase = live.phase ?? null;
      if (
        livePhase &&
        livePhase !== "Ready" &&
        livePhase !== "Running" &&
        !isTerminalSandboxPhase(livePhase) &&
        isDockerRuntimeDown(sandboxName)
      ) {
        probeTiming?.markFailureStage("gateway");
        failConnectReadinessDockerRuntimeDown(sandboxName);
      }
    }
    await withinLifecycleFence?.({
      hermesPortable,
      ...(hermesPortableCommandAuthority ? { hermesPortableCommandAuthority } : {}),
      requalify,
    });
    requalify();
  });
}

/** Print version and active-session hints on both interactive launch paths. */
export function printInteractiveSessionHints(sandboxName: string): void {
  // Version staleness check — warn but don't block
  try {
    const versionCheck = sandboxVersion.checkAgentVersion(sandboxName);
    if (versionCheck.isStale) {
      for (const line of sandboxVersion.formatStalenessWarning(sandboxName, versionCheck)) {
        console.error(line);
      }
    }
  } catch {
    /* non-fatal — don't block connect on version check failure */
  }

  // Active session hint — inform if already connected in another terminal
  try {
    const opsBinConnect = resolveOpenshell();
    if (opsBinConnect) {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBinConnect));
      if (sessionResult.detected && sessionResult.sessions.length > 0) {
        const count = sessionResult.sessions.length;
        console.log(
          `  ${D}Note: ${count} existing SSH session${count > 1 ? "s" : ""} to '${sandboxName}' detected (another terminal).${R}`,
        );
      }
    }
  } catch {
    /* non-fatal — don't block connect on session detection failure */
  }
}

/** Preserve session setup after the complete preflight or lease acceptance. */
export function completeInteractiveSessionSetup(
  sandboxName: string,
  sb: SandboxEntry | null,
  runApprovalPass = runConnectAutoPairApprovalPass,
): void {
  maybeEnsureHermesToolGatewayBroker(sb);
  const gatewayName = sb ? resolveSandboxGatewayName(sb) : getSandboxTargetGatewayName(sandboxName);
  runApprovalPass(sandboxName, gatewayName);
}

/** Preserve session setup after launch readiness accepts a trusted agent identity. */
export function completeReadinessQualifiedInteractiveSessionSetup(
  sandboxName: string,
  agent: AgentDefinition,
  sb: SandboxEntry | null,
  runApprovalPass = runConnectAutoPairApprovalPass,
  resolveFallbackGateway = getSandboxTargetGatewayName,
): void {
  maybeEnsureHermesToolGatewayBroker(sb);
  if (sb && agent.name === "openclaw") return;
  const gatewayName = sb ? resolveSandboxGatewayName(sb) : resolveFallbackGateway(sandboxName);
  runApprovalPass(sandboxName, gatewayName);
}

/**
 * Run the complete interactive preflight before SSH or agent launch, including
 * process recovery, readiness polling, inference-route repair, and session
 * setup. Any `process.exit(...)` ends the process as it does on `connect`.
 */
export async function prepareInteractiveSession(sandboxName: string): Promise<{
  agent: AgentDefinition | null;
  sb: SandboxEntry | null;
  hermesPortable: boolean;
}> {
  const prepared: {
    value: {
      agent: AgentDefinition | null;
      sb: SandboxEntry | null;
      hermesPortable: boolean;
    } | null;
  } = { value: null };
  await runConnectEntryPreflight(sandboxName, {
    probeOnly: false,
    withinLifecycleFence: async ({ hermesPortable, requalify }) => {
      if (!hermesPortable) {
        printInteractiveSessionHints(sandboxName);
        const processCheck = checkAndRecoverSandboxProcesses(sandboxName);
        if ("secretBoundaryRefused" in processCheck && processCheck.secretBoundaryRefused) {
          const agentName = agentRuntime.getAgentDisplayName(
            agentRuntime.getSessionAgent(sandboxName),
          );
          exitOnSecretBoundaryRefusal(sandboxName, agentName, processCheck, "Connect");
        }
        if ("mcpReconciliationRefused" in processCheck && processCheck.mcpReconciliationRefused) {
          const agentName = agentRuntime.getAgentDisplayName(
            agentRuntime.getSessionAgent(sandboxName),
          );
          exitOnMcpReconciliationRefusal(sandboxName, agentName, processCheck, "Connect");
        }
        const recoveryFailureDetail =
          "recoveryFailureDetail" in processCheck && processCheck.recoveryFailureDetail
            ? String(processCheck.recoveryFailureDetail)
            : processCheck.checked &&
                processCheck.wasRunning === false &&
                processCheck.recovered === false
              ? "the gateway recovery attempt did not complete"
              : null;
        if (recoveryFailureDetail) {
          const agentName = agentRuntime.getAgentDisplayName(
            agentRuntime.getSessionAgent(sandboxName),
          );
          exitOnGatewayRecoveryFailure(sandboxName, agentName, recoveryFailureDetail, "Recovery");
        }
      }
      // Ensure Ollama auth proxy is running (recovers from host reboots)
      if (!hermesPortable) ensureOllamaAuthProxy();
      await waitForSandboxReadyOrExit(sandboxName, {
        allowDockerRuntimeInspection: !hermesPortable,
        observer: hermesPortable
          ? createCliOpenShellSandboxObserver({
              capture: (args, captureOptions) =>
                captureHermesPortableOpenShell(sandboxName, args, captureOptions),
              defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
            })
          : undefined,
        successLogs: ["  Sandbox is ready. Connecting..."],
      });
      requalify();
      // ── Inference route swap (#1248, #3390) ───────────────────────
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const sb = hermesPortable
        ? verifyHermesPortableInferenceRouteOrExit(sandboxName, agent)
        : await ensureSandboxInferenceRouteOrExit(sandboxName, agent);
      requalify();
      if (!hermesPortable && !(await settlePortablePairingOrExit(sandboxName))) {
        completeInteractiveSessionSetup(sandboxName, sb);
      }
      prepared.value = { agent, sb, hermesPortable };
    },
  });
  if (!prepared.value) throw new Error("interactive connect lifecycle did not complete");
  return prepared.value;
}

export async function connectSandbox(
  sandboxName: string,
  options: SandboxConnectOptions = {},
): Promise<void> {
  const probeTiming = options.probeOnly ? createProbeTimingRecorder() : undefined;
  const finishOnExit = (code: number): void => {
    probeTiming?.finishOnExit(
      code === 0 ? "ready" : "failed",
      probeTiming.activeStage() ?? undefined,
    );
  };
  if (probeTiming) process.once("exit", finishOnExit);
  try {
    const started = await withConnectSandboxLifecycleLock(sandboxName, async () => {
      const prepared = await prepareConnectSandboxWithinLifecycleFence(
        sandboxName,
        options,
        probeTiming,
      );
      if (!prepared) return null;
      return {
        completion: runSandboxExecChild(prepared.binary, prepared.args, {
          hostCwd: ROOT,
          stdin: true,
          ...(prepared.hostEnv ? { hostEnv: prepared.hostEnv } : {}),
        }),
      };
    });
    if (!started) {
      probeTiming?.finish("ready");
      return;
    }

    // Start the selected child under the lifecycle lock, then release the lock
    // before waiting for an interactive shell that can remain open indefinitely.
    const result = await started.completion;
    result.releaseSignals?.();
    exitWithConnectSpawnResult(sandboxName, result);
  } catch (error) {
    probeTiming?.finish("failed", probeTiming.activeStage() ?? undefined);
    throw error;
  } finally {
    if (probeTiming) process.off("exit", finishOnExit);
  }
}

type PreparedConnectChild = {
  binary: string;
  args: string[];
  hostEnv?: NodeJS.ProcessEnv;
};

async function prepareConnectSandboxWithinLifecycleFence(
  sandboxName: string,
  { probeOnly = false, requireLaunchReadinessPublication = true }: SandboxConnectOptions,
  probeTiming?: ProbeTimingRecorder,
): Promise<PreparedConnectChild | null> {
  if (probeOnly) {
    let portableAuthorityReady = false;
    let hermesMissingFastPathEligible = false;
    let hermesReadinessAuthority: {
      readonly active: HermesPortableActiveLifecycleAuthority;
      readonly command: HermesPortableReadinessCommandAuthority;
    } | null = null;
    let retainedHermesLifecycleRecovery: {
      readonly kind: "already-running" | "recovered";
      readonly assertCurrent: () => void;
    } | null = null;
    let initialPortableAuthority: ReturnType<typeof qualifyPortableAgentLifecycleAuthority>;
    try {
      initialPortableAuthority = probeTiming!.measure("authority", () =>
        qualifyPortableAgentLifecycleAuthority(sandboxName, portableAgentLifecycleAuthorityDeps()),
      );
    } catch {
      probeTiming!.markFailureStage("authority");
      failHermesPortableReadinessAuthority(sandboxName);
    }
    if (initialPortableAuthority.kind === "hermes") {
      try {
        let active = probeTiming!.measure("authority", () =>
          requireHermesPortableActiveLifecycleAuthority(
            sandboxName,
            undefined,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
        let qualified;
        let recoveredLifecycle:
          | {
              readonly kind: "already-running" | "recovered";
              readonly assertReceiptCurrent: () => void;
            }
          | undefined;
        try {
          qualified = probeTiming!.measure("authority", () =>
            qualifyHermesPortableAcceptedReadinessAuthority(sandboxName),
          );
          hermesMissingFastPathEligible = qualified.kind === "current";
        } catch {
          // A stopped receipt-owned Hermes container can be restarted before
          // its operating authority is ready to answer. Re-enter the existing
          // proof-backed requalification and lifecycle recovery exactly once;
          // executable, socket, receipt, container, or policy drift still
          // fails inside those authorities before another readiness read.
          const requalified = probeTiming!.measure("authority", () =>
            requalifyPortableAgentSandboxAuthority(
              sandboxName,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          portableAuthorityReady = true;
          if (requalified.kind === "not-installed" || requalified.kind === "not-hermes") {
            throw new Error("Hermes portable lifecycle authority changed during probe");
          }
          active = probeTiming!.measure("authority", () =>
            requireHermesPortableActiveLifecycleAuthority(
              sandboxName,
              active,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          const registered = active.entry;
          requalified.assertCurrent();
          const recovery = probeTiming!.measure("lifecycle", () =>
            recoverPortableDemoSandboxLifecycleForConnect(
              sandboxName,
              registered,
              resolveSandboxGatewayName(registered),
              undefined,
              { onComplete: writeHermesPortableLifecycleRecoveryTiming },
              { onComplete: writeHermesPortableCurrentnessTiming },
              { onComplete: writeHermesPortableInspectionTiming },
            ),
          );
          if (recovery.kind === "not-installed") {
            probeTiming!.setLifecycleAction("failed");
            throw new Error("Hermes portable lifecycle authority disappeared during probe");
          }
          probeTiming!.setLifecycleAction(recovery.kind === "recovered" ? "recovered" : "reused");
          recoveredLifecycle = {
            kind: recovery.kind,
            assertReceiptCurrent: requalified.assertCurrent,
          };
          active = probeTiming!.measure("authority", () =>
            requireHermesPortableActiveLifecycleAuthority(
              sandboxName,
              active,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          qualified = probeTiming!.measure("authority", () =>
            qualifyHermesPortableAcceptedReadinessAuthority(sandboxName, {
              priorReceiptAuthority: requalified,
            }),
          );
          hermesMissingFastPathEligible =
            requalified.kind === "already-current" && qualified.kind === "current";
        }
        if (qualified.kind === "requalification-required") {
          const requalified = probeTiming!.measure("authority", () =>
            requalifyPortableAgentSandboxAuthority(
              sandboxName,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          if (requalified.kind === "not-installed" || requalified.kind === "not-hermes") {
            throw new Error("Hermes portable lifecycle authority changed during probe");
          }
          active = probeTiming!.measure("authority", () =>
            requireHermesPortableActiveLifecycleAuthority(
              sandboxName,
              active,
              portableAgentLifecycleAuthorityDeps(),
            ),
          );
          qualified = probeTiming!.measure("authority", () =>
            qualifyHermesPortableAcceptedReadinessAuthority(sandboxName, {
              priorReceiptAuthority: requalified,
            }),
          );
          if (qualified.kind === "requalification-required") {
            throw new Error("Hermes portable schema-6 authority was not published during probe");
          }
        }
        probeTiming!.measure("authority", qualified.commandAuthority.assertCurrent);
        portableAuthorityReady = true;
        hermesReadinessAuthority = {
          active,
          command: qualified.commandAuthority,
        };
        if (recoveredLifecycle) {
          const retainedActive = active;
          const retainedCommand = qualified.commandAuthority;
          retainedHermesLifecycleRecovery = {
            kind: recoveredLifecycle.kind,
            assertCurrent: () => {
              recoveredLifecycle.assertReceiptCurrent();
              retainedCommand.assertCurrent();
              const current = requireHermesPortableActiveLifecycleAuthority(
                sandboxName,
                retainedActive,
                portableAgentLifecycleAuthorityDeps(),
              );
              if (!isDeepStrictEqual(current.entry, retainedActive.entry)) {
                throw new Error("Hermes portable lifecycle authority changed after recovery");
              }
            },
          };
        }
      } catch {
        probeTiming!.markFailureStage("authority");
        failHermesPortableReadinessAuthority(sandboxName);
      }
    }
    let readiness: Awaited<ReturnType<typeof inspectLaunchReadiness>>;
    try {
      readiness = await probeTiming!.measureAsync("readiness", () =>
        inspectLaunchReadiness(
          sandboxName,
          hermesReadinessAuthority
            ? hermesPortableLaunchReadinessDeps(hermesReadinessAuthority.command, probeTiming)
            : probeTimingLaunchReadinessDeps(probeTiming),
        ),
      );
      probeTiming!.recordReadinessDecision(readiness.category);
      const currentReadinessAuthority = hermesReadinessAuthority;
      if (currentReadinessAuthority) {
        probeTiming!.measure("authority", currentReadinessAuthority.command.assertCurrent);
        probeTiming!.measure("authority", () =>
          requireHermesPortableActiveLifecycleAuthority(
            sandboxName,
            currentReadinessAuthority.active,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
      }
    } catch (error) {
      if (hermesReadinessAuthority) {
        probeTiming!.markFailureStage("authority");
        failHermesPortableReadinessAuthority(sandboxName);
      }
      throw error;
    }
    let publication: Awaited<ReturnType<typeof publishLaunchReadiness>>;
    while (true) {
      if (readiness.kind === "accepted") {
        const acceptedReadiness = readiness;
        const authority = probeTiming!.measure("authority", () =>
          qualifyPortableAgentLifecycleAuthority(
            sandboxName,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
        probeTiming!.setLifecycleAction("reused");
        if (authority.kind === "hermes") {
          const acceptedHermesAuthority = hermesReadinessAuthority;
          if (!acceptedHermesAuthority) {
            probeTiming!.markFailureStage("authority");
            failHermesPortableReadinessAuthority(sandboxName);
          }
          let activeAuthority: HermesPortableActiveLifecycleAuthority;
          try {
            activeAuthority = probeTiming!.measure("authority", () =>
              requireHermesPortableActiveLifecycleAuthority(
                sandboxName,
                acceptedHermesAuthority.active,
                portableAgentLifecycleAuthorityDeps(),
              ),
            );
            if (!isDeepStrictEqual(activeAuthority.entry, acceptedReadiness.sb)) {
              throw new Error("Hermes portable registry authority changed during probe");
            }
            probeTiming!.measure("authority", acceptedHermesAuthority.command.assertCurrent);
          } catch {
            probeTiming!.markFailureStage("authority");
            failHermesPortableReadinessAuthority(sandboxName);
          }
          recoverHermesPortableForwardsForConnectProbeOrExit(
            sandboxName,
            activeAuthority,
            probeTiming,
            acceptedHermesAuthority.command,
          );
        } else if (hermesReadinessAuthority) {
          probeTiming!.markFailureStage("authority");
          failHermesPortableReadinessAuthority(sandboxName);
        }
        console.log(`  Probe complete: launch readiness is healthy for '${sandboxName}'.`);
        return null;
      }
      if (!portableAuthorityReady) {
        probeTiming!.measure("authority", () =>
          requalifyPortableAgentSandboxAuthority(
            sandboxName,
            portableAgentLifecycleAuthorityDeps(),
          ),
        );
        portableAuthorityReady = true;
      }
      // Refuse recovery only when a prior epoch might exist and could not be
      // durably rotated. When the authority and receipt are both securely
      // absent but new authority creation fails (fenceFailed without
      // recoveryBlocked), the documented contract runs the complete preflight
      // and recovery and reports the publication failure afterwards, exactly
      // as `launch` does for the same decision (#9280).
      if (
        readiness.fenceFailed &&
        readiness.authorityUnsupported !== true &&
        readiness.recoveryBlocked
      ) {
        probeTiming!.markFailureStage("readiness");
        console.error(
          "  Probe failed: complete probe and recovery did not run because prior launch-readiness evidence could not be fenced. Repair the current user's secure OS runtime authority and NemoClaw state permissions, then retry.",
        );
        process.exit(1);
      }
      const publicationRequest = publicationFromDecision(sandboxName, readiness);
      const gated = await withLaunchReadinessMutationGate(publicationRequest, async () => {
        if (
          readiness.category === "missing" &&
          hermesMissingFastPathEligible &&
          hermesReadinessAuthority?.active.entry.provider === "ollama-local" &&
          typeof hermesReadinessAuthority.active.entry.hostLocalInferenceReceipt === "string"
        ) {
          const retainedAuthority = hermesReadinessAuthority;
          const assertBaseCurrent = (): void => {
            probeTiming!.measure("authority", retainedAuthority.command.assertTransactionCurrent);
            const current = probeTiming!.measure("authority", () =>
              requireHermesPortableActiveLifecycleAuthority(
                sandboxName,
                retainedAuthority.active,
                portableAgentLifecycleAuthorityDeps(),
              ),
            );
            if (!isDeepStrictEqual(current.entry, retainedAuthority.active.entry)) {
              throw new Error(
                "Hermes portable registry authority changed during readiness recapture",
              );
            }
          };
          let runtime: ReturnType<
            typeof inspectHermesPortableInferenceReadinessRuntimeForConnectProbe
          >;
          try {
            runtime = probeTiming!.measure("inference", () =>
              inspectHermesPortableInferenceReadinessRuntimeForConnectProbe({
                intent: "connect-probe-only",
                sandboxName,
                entry: retainedAuthority.active.entry,
                operatingReceipt: retainedAuthority.command.receipt,
                readRegistry: registry.getSandbox,
                assertCallerCurrent: assertBaseCurrent,
                env: retainedAuthority.command.env,
              }),
            );
          } catch {
            probeTiming!.markFailureStage("authority");
            failHermesPortableReadinessAuthority(sandboxName);
          }
          if (runtime.kind === "running-current") {
            let forward: ReturnType<typeof verifyHermesPortableForwardsForConnectProbe>;
            try {
              runtime.assertCurrent();
              forward = probeTiming!.measure("forward", () =>
                verifyHermesPortableForwardsForConnectProbe({
                  intent: "connect-probe-only",
                  sandboxName,
                  authority: retainedAuthority.active,
                  readRegistry: registry.getSandbox,
                  commandAuthority: retainedAuthority.command,
                }),
              );
              runtime.assertCurrent();
            } catch (error) {
              failHermesPortableForwardRecovery(
                sandboxName,
                error instanceof HermesPortableForwardRecoveryError
                  ? error.failure
                  : "authority-drift",
              );
            }
            if (forward.kind === "healthy") {
              const publicationDeps = {
                ...hermesPortableLaunchReadinessDeps(
                  retainedAuthority.command,
                  probeTiming,
                  retainedAuthority.command.assertTransactionCurrent,
                ),
                assertPublicationCurrent: runtime.assertCurrent,
              };
              runtime.assertCurrent();
              const fastPublication = await probeTiming!.measureAsync("publication", () =>
                publishLaunchReadiness(publicationRequest, publicationDeps),
              );
              runtime.assertCurrent();
              if (fastPublication.kind === "published") {
                probeTiming!.setLifecycleAction("reused");
                probeTiming!.setForwardAction("verified");
                return fastPublication;
              }
              if (
                fastPublication.kind !== "validation-failed" ||
                fastPublication.category !== "health"
              ) {
                return fastPublication;
              }
            }
          }
        }
        await runConnectEntryPreflight(sandboxName, {
          probeOnly: true,
          probeTiming,
          ...(hermesReadinessAuthority
            ? { hermesPortableCommandAuthority: hermesReadinessAuthority.command }
            : {}),
          ...(retainedHermesLifecycleRecovery ? { retainedHermesLifecycleRecovery } : {}),
          withinLifecycleFence: async ({
            hermesPortable,
            hermesPortableCommandAuthority,
            requalify,
          }) => {
            // Restart a stopped container before the readiness wait. Without this step,
            // OpenShell keeps reporting the stopped sandbox until the wait expires (#8967).
            const startedStoppedContainer = hermesPortable
              ? false
              : probeTiming!.measure("lifecycle", () =>
                  startStoppedSandboxContainerForProbeRecovery(sandboxName),
                );
            await probeTiming!.measureAsync("gateway", () =>
              waitForSandboxReadyOrExit(sandboxName, {
                allowInitialErrorAfterStart: startedStoppedContainer,
                allowDockerRuntimeInspection: !hermesPortable,
                observer: hermesPortable
                  ? createCliOpenShellSandboxObserver({
                      capture: (args, captureOptions) =>
                        hermesPortableCommandAuthority
                          ? captureHermesPortableReadinessObservation(
                              hermesPortableCommandAuthority,
                              args,
                              captureOptions,
                            )
                          : captureHermesPortableOpenShell(sandboxName, args, captureOptions),
                      defaultTimeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
                    })
                  : undefined,
                defaultTimeoutSec: SANDBOX_REPAIR_READY_TIMEOUT_SEC,
                retryCommand: "connect --probe-only",
              }),
            );
            // Re-pin and re-observe the owning gateway after a potentially long wait
            // before any in-sandbox process or host-forward mutation. The readiness
            // polls are already scoped to the owning gateway; this also catches
            // registry changes.
            if (!hermesPortable) {
              await probeTiming!.measureAsync("gateway", () =>
                ensureLiveSandboxOrExit(sandboxName, { gatewayRecovery: "observe" }),
              );
            }
            requalify();
            await runSandboxConnectProbe(sandboxName, {
              hermesPortable,
              ...(hermesPortableCommandAuthority ? { hermesPortableCommandAuthority } : {}),
              probeOnly: true,
              probeTiming,
            });
            if (!hermesPortable) {
              probeTiming!.measure("gateway", () =>
                waitForSandboxReadyOrExit(sandboxName, {
                  allowInitialErrorAfterStart: true,
                  allowDockerRuntimeInspection: false,
                  defaultTimeoutSec: SANDBOX_REPAIR_READY_TIMEOUT_SEC,
                  retryCommand: "connect --probe-only",
                }),
              );
            }
            requalify();
          },
        });
        const retainedCommand = hermesReadinessAuthority?.command;
        if (retainedCommand) {
          probeTiming!.measure("authority", retainedCommand.assertCurrent);
        }
        const published = await probeTiming!.measureAsync("publication", () =>
          (retainedCommand
            ? publishHermesLaunchReadinessWithSettlement
            : publishLaunchReadiness)(
            publicationRequest,
            retainedCommand
              ? hermesPortableLaunchReadinessDeps(retainedCommand, probeTiming)
              : probeTimingLaunchReadinessDeps(probeTiming),
          ),
        );
        if (retainedCommand) {
          probeTiming!.measure("authority", retainedCommand.assertCurrent);
        }
        return published;
      });
      if (gated.kind === "changed") {
        if (hermesReadinessAuthority) {
          try {
            let active = probeTiming!.measure("authority", () =>
              requireHermesPortableActiveLifecycleAuthority(
                sandboxName,
                undefined,
                portableAgentLifecycleAuthorityDeps(),
              ),
            );
            const qualified = probeTiming!.measure("authority", () =>
              qualifyHermesPortableAcceptedReadinessAuthority(sandboxName),
            );
            if (qualified.kind === "requalification-required") {
              throw new Error("Hermes portable schema-6 authority changed during probe");
            }
            probeTiming!.measure("authority", qualified.commandAuthority.assertCurrent);
            readiness = await probeTiming!.measureAsync("readiness", () =>
              inspectLaunchReadiness(
                sandboxName,
                hermesPortableLaunchReadinessDeps(qualified.commandAuthority, probeTiming),
              ),
            );
            probeTiming!.measure("authority", qualified.commandAuthority.assertCurrent);
            active = probeTiming!.measure("authority", () =>
              requireHermesPortableActiveLifecycleAuthority(
                sandboxName,
                active,
                portableAgentLifecycleAuthorityDeps(),
              ),
            );
            hermesReadinessAuthority = { active, command: qualified.commandAuthority };
          } catch {
            probeTiming!.markFailureStage("authority");
            failHermesPortableReadinessAuthority(sandboxName);
          }
        } else {
          readiness = await probeTiming!.measureAsync("readiness", () =>
            inspectLaunchReadiness(sandboxName, probeTimingLaunchReadinessDeps(probeTiming)),
          );
        }
        probeTiming!.recordReadinessDecision(readiness.category);
        continue;
      }
      if (gated.kind === "unsafe") {
        probeTiming!.markFailureStage("publication");
        console.error(
          "  Probe failed: complete probe and recovery did not run because the current launch-readiness epoch could not be safely revalidated. Repair the current user's secure OS runtime authority and NemoClaw state permissions, then retry.",
        );
        process.exit(1);
      }
      publication = gated.value;
      break;
    }
    if (publication.kind === "validation-failed") {
      probeTiming!.markFailureStage("publication");
      const failedCheck = publication.failedCheck
        ? ` because the ${publication.failedCheck} failed`
        : ` due to ${publication.category}`;
      console.error(`  Probe failed: final launch-readiness validation failed${failedCheck}.`);
      process.exit(1);
    }
    if (publication.kind === "evidence-failed") {
      if (!requireLaunchReadinessPublication) return null;
      // A platform without a per-user runtime authority (macOS) can never
      // store launch-readiness evidence. The probe and recovery still
      // succeeded, and `launch` runs the complete preflight without the
      // evidence, so a permanent platform gap must not turn a successful
      // probe into a nonzero exit (#9278).
      if (readiness.kind === "fallback" && readiness.authorityUnsupported === true) {
        console.log(
          "  Note: launch-readiness evidence is unavailable on this platform; the next launch runs the complete preflight.",
        );
        return null;
      }
      probeTiming!.markFailureStage("publication");
      console.error(
        "  Probe failed: complete probe and recovery succeeded, but final launch-readiness evidence could not be verified or published.",
      );
      process.exit(1);
    }
    return null;
  }

  const { agent, sb, hermesPortable } = await prepareInteractiveSession(sandboxName);

  // Print a one-shot hint before dropping the user into the sandbox
  // shell so a fresh user knows the first thing to type. Without this,
  // `nemoclaw <name> connect` lands on a bare bash prompt and users
  // ask "now what?" — see #465. Suppress the hint when stdout isn't a
  // TTY so scripted callers don't get noise in their pipelines.
  if (
    process.stdout.isTTY &&
    !["1", "true"].includes(String(process.env.NEMOCLAW_NO_CONNECT_HINT || ""))
  ) {
    console.log("");
    // Same resolver `launch` uses, so the hint cannot drift from the command
    // that `nemoclaw launch <name>` actually runs (#6006).
    void agentRuntime.getInteractiveAgentCommand(agent, sb?.agent);
    console.log(`  ${G}✓${R} Connecting to sandbox '${sandboxName}'`);
    console.log(`  ${D}Inside the sandbox, run the configured command to start chatting.${R}`);
    console.log(
      `  ${D}Type \`/exit\` to leave the chat, then \`exit\` to return to the host shell.${R}`,
    );
    // The policy-denial breadcrumb (#5978) is emitted once by the in-sandbox
    // `nemoclaw-policy-denial-hint` stanza when this connect shell sources
    // /tmp/nemoclaw-proxy-env.sh. We deliberately do NOT also print it here:
    // doing so duplicated the hint in the normal connect flow, and the stanza
    // already shows the real sandbox name on supported OpenShell (it reads
    // OPENSHELL_SANDBOX) and covers every other interactive entry path too.
    console.log("");
  }
  let hermesAuthority = hermesPortable
    ? requireHermesPortableActiveLifecycleAuthority(
        sandboxName,
        undefined,
        portableAgentLifecycleAuthorityDeps(),
      )
    : null;
  const requalifyPortableDisposition = () => {
    if (hermesAuthority) {
      hermesAuthority = requireHermesPortableActiveLifecycleAuthority(
        sandboxName,
        hermesAuthority,
        portableAgentLifecycleAuthorityDeps(),
      );
      return;
    }
    if (
      qualifyPortableAgentLifecycleAuthority(sandboxName, portableAgentLifecycleAuthorityDeps())
        .kind === "hermes"
    ) {
      throw new Error("Hermes portable lifecycle authority appeared during interactive connect");
    }
  };
  const requalifyHermesPortableForConnect = (): {
    readonly env: NodeJS.ProcessEnv;
    readonly executablePath: string;
    readonly gatewayName: string;
  } => {
    requalifyPortableDisposition();
    const qualified = hermesAuthority;
    if (!qualified) {
      throw new Error("Hermes portable registry authority changed before interactive connect");
    }
    const gatewayName = resolveSandboxGatewayName(qualified.entry);
    const recovery = recoverPortableDemoSandboxLifecycleForConnect(
      sandboxName,
      qualified.entry,
      gatewayName,
    );
    if (recovery.kind === "not-installed") {
      throw new Error("Hermes portable lifecycle authority disappeared before interactive connect");
    }
    hermesAuthority = requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      qualified,
      portableAgentLifecycleAuthorityDeps(),
    );
    return { ...buildHermesPortableCommandAuthority(sandboxName), gatewayName };
  };
  requalifyPortableDisposition();
  if (!hermesPortable) prepareHermesLightTerminalSkin(sandboxName, agent, process.env);
  requalifyPortableDisposition();
  const portableAuthority = hermesPortable ? requalifyHermesPortableForConnect() : null;
  const connectArgs = portableAuthority
    ? ["sandbox", "connect", "-g", portableAuthority.gatewayName, sandboxName]
    : ["sandbox", "connect", sandboxName];
  return {
    binary: portableAuthority?.executablePath ?? getOpenshellBinary(),
    args: connectArgs,
    ...(portableAuthority ? { hostEnv: portableAuthority.env } : {}),
  };
}
