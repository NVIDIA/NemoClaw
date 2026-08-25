// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import {
  detectOpenShellStateRpcResultIssue,
  type OpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { type AgentDefinition, getAgentRuntimeKind, loadAgent } from "../../agent/defs";
import { retryUntilAsync } from "../../core/retry";

import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import {
  type GatewayInference,
  parseGatewayInference,
  planInferenceRouteReconcile,
  type RecordedInferenceRoute,
} from "../../inference/config";
import {
  type ProviderHealthProbeOptions,
  type ProviderHealthStatus,
  probeProviderHealth,
} from "../../inference/health";
import type { ServingProfileProvenance } from "../../inference/serving/types";
import {
  type DcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "../../onboard/dcode-auto-approval";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { getBaselineExclusionRuntimeStatus } from "../../policy";
import type { BaselineExclusionRuntimeStatus } from "../../policy/baseline-exclusion";
import { redact } from "../../security/redact";
import * as registry from "../../state/registry";
import {
  buildGatewayInferenceGetArgs,
  canSandboxGatewayRouteRealign,
} from "./connect-inference-gateway";
import { getSandboxDockerRuntime } from "./docker-health";
import type { SandboxGatewayState } from "./gateway-state";
import { getReconciledSandboxGatewayState, getSandboxGatewayStateForStatus } from "./gateway-state";
import {
  buildSandboxInferenceRouteHealth,
  type ProbeSandboxInferenceInvocation,
  probeSandboxInferenceGatewayHealth,
  runSandboxInferenceInvocationProbe,
} from "./inference-route-health";
import {
  getSandboxStatusPreflight,
  type SandboxStatusFailureLayer,
  type SandboxStatusPreflightResult,
  withoutTerminalPhasePreflight,
} from "./status-preflight";
import {
  probeTerminalRuntimeCgroupOom,
  type TerminalRuntimeOomProbeResult,
} from "./terminal-runtime-health";

type ProbeProviderHealth = (
  provider: string,
  options?: ProviderHealthProbeOptions,
) => ProviderHealthStatus | null;
type ProbeSandboxInferenceGatewayHealth = typeof probeSandboxInferenceGatewayHealth;
type DelayInferenceRecoveryProbe = (delayMs: number) => Promise<void>;

const RECOVERED_INFERENCE_PROBE_ATTEMPTS = 3;
const RECOVERED_INFERENCE_PROBE_DELAY_MS = 2_000;

/**
 * Honest serving-process state while the self-report response and probe
 * contracts remain undefined. Do not add a checked result until both contracts
 * and their failure mapping are implemented together.
 */
export type ServingProcessHealth = { checked: false };

export function getSandboxStatusInferenceHealth(
  gatewayPresent: boolean,
  currentProvider: unknown,
  currentModel: unknown,
  probeProviderHealthImpl: ProbeProviderHealth = probeProviderHealth,
): ProviderHealthStatus | null {
  if (!gatewayPresent || typeof currentProvider !== "string") return null;
  return probeProviderHealthImpl(currentProvider, {
    model: typeof currentModel === "string" ? currentModel : undefined,
  });
}

/**
 * Gate around `getSandboxStatusInferenceHealth` that short-circuits when the
 * caller has already classified a pre-snapshot failure (docker daemon down,
 * sandbox container stopped, dashboard port held). Returns null without
 * touching the provider probe so the remote-provider reachability request is
 * never issued in those cases.
 */
export function maybeGetSandboxStatusInferenceHealth(
  suppressInferenceProbe: boolean,
  gatewayPresent: boolean,
  currentProvider: unknown,
  currentModel: unknown,
  probeProviderHealthImpl?: ProbeProviderHealth,
): ProviderHealthStatus | null {
  if (suppressInferenceProbe) return null;
  return getSandboxStatusInferenceHealth(
    gatewayPresent,
    currentProvider,
    currentModel,
    probeProviderHealthImpl,
  );
}

/** True when the authoritative inference route must make status exit nonzero. */
export function isInferenceHealthFailing(inferenceHealth: ProviderHealthStatus | null): boolean {
  return Boolean(inferenceHealth && (!inferenceHealth.probed || !inferenceHealth.ok));
}

/** Validate user-editable mount state before it reaches JSON or terminal output. */
export function normalizeSandboxStatusHostMounts(value: unknown): registry.SandboxHostMount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Persisted host mount state must be an array; repair the local state first.");
  }
  return value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof (candidate as Record<string, unknown>).source !== "string" ||
      typeof (candidate as Record<string, unknown>).target !== "string" ||
      (candidate as Record<string, unknown>).readOnly !== true
    ) {
      throw new Error(
        "Persisted state contains an invalid read-only host mount; repair the local state first.",
      );
    }
    const { source, target } = candidate as { source: string; target: string };
    if (
      registry.hasUnsafeHostMountTerminalText(source) ||
      registry.hasUnsafeHostMountTerminalText(target)
    ) {
      throw new Error(
        "Persisted state contains a host mount with unsafe terminal control characters; repair the local state first.",
      );
    }
    return { source, target, readOnly: true };
  });
}

export interface SandboxStatusReport {
  schemaVersion: 1;
  name: string;
  found: boolean;
  agent: string;
  agentDisplayName: string;
  agentRuntime: "gateway" | "terminal" | "unknown";
  dcodeAutoApprovalMode: DcodeAutoApprovalMode | null;
  agentLoadError?: string;
  model: string;
  provider: string;
  servingProfileProvenance: ServingProfileProvenance | null;
  recordedRoute: RecordedInferenceRoute | null;
  liveRoute: GatewayInference | null;
  routeDrift: SandboxStatusRouteDrift | null;
  phase: string | null;
  /** Receipt-owned Hermes portable lifecycle phase when schema-5 authority is present. */
  portableLifecyclePhase?: "pending" | "configuring" | "active";
  gatewayState: string;
  inferenceHealth: ProviderHealthStatus | null;
  rpcIssue: { kind: "image_drift" | "host_process_drift" | "protobuf_mismatch" } | null;
  hostGpuDetected: boolean;
  sandboxGpuEnabled: boolean;
  sandboxGpuMode: string | null;
  sandboxGpuDevice: string | null;
  // Last recorded CUDA-usability proof so `status` can distinguish a configured
  // GPU from a proven-usable one instead of reporting any GPU as healthy (#4231).
  sandboxGpuProof: registry.SandboxGpuProofResult | null;
  hostMounts: registry.SandboxHostMount[];
  openshellDriver: string;
  openshellVersion: string;
  policies: string[];
  /** Baseline network policy keys the operator has excluded, replayed on rebuild. */
  baselineExclusions: string[];
  /** Observed enforcement state for each recorded baseline exclusion. */
  baselineExclusionStates: Array<{ key: string; status: BaselineExclusionRuntimeStatus }>;
  /** Interrupted cross-system policy mutation that must be reconciled before rebuild. */
  baselineExclusionTransition: {
    operation: registry.BaselineExclusionTransitionOperation;
    key: string;
  } | null;
  failureLayer: SandboxStatusFailureLayer | null;
  terminalRuntimeHealth: TerminalRuntimeOomProbeResult | null;
  /**
   * Whether serving-process health was checked. Null when the sandbox is not
   * reachable or the agent runtime is not gateway-based. This remains
   * `checked: false` until a self-report probe contract is implemented.
   */
  servingProcessHealth: ServingProcessHealth | null;
  /**
   * Whether the resolved docker-driver sandbox container is paused
   * (`docker pause`). `false` for non-docker-driver sandboxes or when no
   * container is found. A paused container can report `Phase: Error`
   * upstream while the sandbox is intact — see #4495.
   */
  dockerPaused: boolean;
}

export interface SandboxStatusRouteDrift {
  live: GatewayInference;
  recorded: RecordedInferenceRoute;
  canConnect: boolean;
}

export interface SandboxStatusSnapshot {
  sb: registry.SandboxEntry | null;
  lookup: SandboxGatewayState;
  rpcIssue: OpenShellStateRpcIssue | null;
  currentModel: string;
  currentProvider: string;
  recordedRoute: RecordedInferenceRoute | null;
  liveRoute: GatewayInference | null;
  routeDrift: SandboxStatusRouteDrift | null;
  inferenceHealth: ProviderHealthStatus | null;
  terminalRuntimeHealth: TerminalRuntimeOomProbeResult | null;
  servingProcessHealth: ServingProcessHealth | null;
  /** Refreshed after Docker recovery so callers do not render stale stopped-container state. */
  postRecoveryPreflight?: SandboxStatusPreflightResult;
}

export interface SandboxStatusAgentInfo {
  agentName: string;
  agentDisplayName: string;
  agentRuntime: "gateway" | "terminal" | "unknown";
  agentLoadError?: string;
  agentDefinition: AgentDefinition | null;
}

export function resolveSandboxStatusDcodeAutoApprovalMode(
  sandbox: registry.SandboxEntry | null,
): DcodeAutoApprovalMode | null {
  if (sandbox?.agent !== "langchain-deepagents-code") return null;
  return normalizeDcodeAutoApprovalMode(sandbox.dcodeAutoApprovalMode);
}

export function resolveSandboxStatusAgent(agentName = "openclaw"): SandboxStatusAgentInfo {
  let agentDisplayName = agentName === "openclaw" ? "OpenClaw" : agentName;
  let agentRuntime: SandboxStatusAgentInfo["agentRuntime"] = "gateway";
  let agentLoadError: string | undefined;
  let agentDefinition: AgentDefinition | null = null;
  try {
    const agent = loadAgent(agentName);
    agentDisplayName = agent.displayName;
    agentRuntime = getAgentRuntimeKind(agent);
    agentDefinition = agentName === "openclaw" ? null : agent;
  } catch (err) {
    if (agentName !== "openclaw") {
      agentRuntime = "unknown";
      agentLoadError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    agentName,
    agentDisplayName,
    agentRuntime,
    ...(agentLoadError ? { agentLoadError } : {}),
    agentDefinition,
  };
}

type ReconcileSandboxGatewayState = (sandboxName: string) => Promise<SandboxGatewayState>;
type ProbeTerminalRuntimeHealth = (sandboxName: string) => TerminalRuntimeOomProbeResult;
type RecoverSandboxProcesses =
  (typeof import("./status/process-recovery"))["checkAndRecoverSandboxProcesses"];
type SandboxProcessRecoveryResult = ReturnType<RecoverSandboxProcesses>;

type SandboxProcessRecoveryFailure = {
  layer:
    | "inspection"
    | "secret-boundary"
    | "mcp-reconciliation"
    | "gateway-recovery"
    | "forward-recovery"
    | "recovery-error";
  detail: string;
};

function loadRecoverSandboxProcesses(): RecoverSandboxProcesses {
  return (
    require("./status/process-recovery") as {
      checkAndRecoverSandboxProcesses: RecoverSandboxProcesses;
    }
  ).checkAndRecoverSandboxProcesses;
}

interface CollectSandboxStatusSnapshotDeps {
  getSandbox?: typeof registry.getSandbox;
  listSandboxes?: typeof registry.listSandboxes;
  captureOpenshellForStatusImpl?: typeof captureOpenshellForStatus;
  probeProviderHealthImpl?: ProbeProviderHealth;
  probeSandboxInferenceGatewayHealthImpl?: ProbeSandboxInferenceGatewayHealth;
  probeSandboxInferenceInvocationImpl?: ProbeSandboxInferenceInvocation;
  delayInferenceRecoveryProbe?: DelayInferenceRecoveryProbe;
  reportInferenceProbeError?: (message: string) => void;
  probeTerminalRuntimeHealth?: ProbeTerminalRuntimeHealth;
  recoverSandboxProcesses?: RecoverSandboxProcesses;
  reconcile?: ReconcileSandboxGatewayState;
  getSandboxStatusPreflightImpl?: typeof getSandboxStatusPreflight;
  getBaselineExclusionRuntimeStatus?: typeof getBaselineExclusionRuntimeStatus;
}

function sanitizedStatusDetail(error: unknown): string {
  const raw = error instanceof Error && error.message ? error.message : String(error);
  return redact(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function processRecoveryFailure(
  result: SandboxProcessRecoveryResult,
): SandboxProcessRecoveryFailure | null {
  if (!result.checked) {
    return {
      layer: "inspection",
      detail: "the managed agent gateway could not be inspected",
    };
  }
  if ("secretBoundaryRefused" in result && result.secretBoundaryRefused) {
    return {
      layer: "secret-boundary",
      detail: sanitizedStatusDetail(
        "secretBoundaryReason" in result
          ? result.secretBoundaryReason
          : "the agent secret boundary refused recovery",
      ),
    };
  }
  if ("mcpReconciliationRefused" in result && result.mcpReconciliationRefused) {
    return {
      layer: "mcp-reconciliation",
      detail: sanitizedStatusDetail(
        "mcpReconciliationReason" in result
          ? result.mcpReconciliationReason
          : "MCP reconciliation refused recovery",
      ),
    };
  }
  if ("forwardRecoveryFailed" in result && result.forwardRecoveryFailed) {
    return {
      layer: "forward-recovery",
      detail: sanitizedStatusDetail(
        "forwardRecoveryFailureDetail" in result
          ? result.forwardRecoveryFailureDetail
          : "the host forward could not be restored",
      ),
    };
  }
  if (result.wasRunning === false && result.recovered && !result.forwardRecovered) {
    return {
      layer: "forward-recovery",
      detail: "the primary dashboard/API host forward was not proven after gateway recovery",
    };
  }
  if (result.wasRunning === false && !result.recovered) {
    return {
      layer: "gateway-recovery",
      detail: "the managed agent gateway could not be restarted",
    };
  }
  if (result.wasRunning === null && (!("runtime" in result) || result.runtime !== "terminal")) {
    return {
      layer: "inspection",
      detail: "the managed agent gateway recovery result was inconclusive",
    };
  }
  return null;
}

async function refreshPreflightAfterDockerRecovery(
  sandbox: registry.SandboxEntry | null,
  initial: SandboxStatusPreflightResult,
  getPreflight: typeof getSandboxStatusPreflight,
): Promise<SandboxStatusPreflightResult> {
  // A listener observed while the sandbox was stopped may belong to another
  // process. Starting the container makes the ordinary preflight stop checking
  // that port, so keep this ownership conflict authoritative.
  if (initial.failureLayer === "sandbox_dashboard_port_conflict") return initial;
  try {
    return await getPreflight(sandbox);
  } catch {
    return initial;
  }
}

function reportInferenceProbeError(error: unknown, writer: (message: string) => void): void {
  const detail = sanitizedStatusDetail(error);
  writer(
    `  Warning: the authoritative inference.local probe could not run: ${detail || "unknown error"}`,
  );
}

export async function collectSandboxStatusSnapshot(
  sandboxName: string,
  opts: {
    suppressInferenceProbe?: boolean;
    preflight?: SandboxStatusPreflightResult;
    deps?: CollectSandboxStatusSnapshotDeps;
  } = {},
): Promise<SandboxStatusSnapshot> {
  const reconcile =
    opts.deps?.reconcile ??
    ((name: string) =>
      getReconciledSandboxGatewayState(name, {
        getState: getSandboxGatewayStateForStatus,
      }));
  const getSandbox =
    opts.deps?.getSandbox ??
    ((name: string) => {
      const entry = registry.getSandbox(name);
      return entry && registry.isPublishedSandboxRegistration(entry) ? entry : null;
    });
  const sb = getSandbox(sandboxName);
  let lookup: SandboxGatewayState;
  try {
    lookup = await reconcile(sandboxName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lookup = {
      state: "gateway_error",
      output: `  Could not probe live gateway state: ${message}`,
    };
  }
  const dockerRecovered = lookup.recoveredSandbox === true;
  const managedOpenClawDeliveryMustBeProven =
    lookup.state === "present" &&
    sb?.openshellDriver === "docker" &&
    (sb.agent ?? "openclaw") === "openclaw" &&
    lookup.phase === "Ready" &&
    !opts.preflight?.failure;
  let recoveredManagedGateway = false;
  if (
    lookup.state === "present" &&
    (lookup.recoveredSandbox || managedOpenClawDeliveryMustBeProven)
  ) {
    let failure: SandboxProcessRecoveryFailure | null;
    try {
      // The managed gateway service can restart a Docker sandbox before status
      // runs. OpenShell then reports Ready without a recoveredSandbox marker,
      // while the OpenClaw gateway and host forward can still be absent.
      const recovery = (opts.deps?.recoverSandboxProcesses ?? loadRecoverSandboxProcesses())(
        sandboxName,
        {
          quiet: true,
        },
      );
      failure = processRecoveryFailure(recovery);
      recoveredManagedGateway =
        failure === null && recovery.wasRunning === false && recovery.recovered === true;
    } catch (error) {
      failure = {
        layer: "recovery-error",
        detail: sanitizedStatusDetail(error) || "agent and host-forward recovery failed",
      };
    }
    if (failure) {
      lookup = {
        ...lookup,
        state: "sandbox_recovery_failed",
        output:
          `  Sandbox '${sandboxName}' is present, but its agent delivery chain could not be proven ` +
          `(${failure.layer}: ${failure.detail}).`,
      };
    }
  }
  const postRecoveryPreflight =
    dockerRecovered && opts.preflight
      ? await refreshPreflightAfterDockerRecovery(
          sb,
          opts.preflight,
          opts.deps?.getSandboxStatusPreflightImpl ?? getSandboxStatusPreflight,
        )
      : undefined;
  const suppressInferenceProbe =
    (postRecoveryPreflight ?? opts.preflight)?.suppressInferenceProbe ??
    opts.suppressInferenceProbe === true;
  let liveResult: Awaited<ReturnType<typeof captureOpenshellForStatus>> | null = null;
  let gatewayName: string | null = null;
  if (lookup.state === "present") {
    try {
      gatewayName = resolveSandboxGatewayName(sb);
      liveResult = await (opts.deps?.captureOpenshellForStatusImpl ?? captureOpenshellForStatus)(
        buildGatewayInferenceGetArgs(gatewayName),
      );
    } catch {
      // Invalid persisted gateway bindings and failed reads stay fail-closed:
      // never substitute the selected/default gateway's inference route.
      liveResult = null;
    }
  }
  const rpcIssue = liveResult ? detectOpenShellStateRpcResultIssue(liveResult) : null;
  if (rpcIssue) {
    return {
      sb,
      lookup,
      rpcIssue,
      currentModel: (sb && sb.model) || "unknown",
      currentProvider: (sb && sb.provider) || "unknown",
      recordedRoute: sb?.provider && sb.model ? { provider: sb.provider, model: sb.model } : null,
      liveRoute: null,
      routeDrift: null,
      inferenceHealth: null,
      terminalRuntimeHealth: null,
      servingProcessHealth: null,
      ...(postRecoveryPreflight ? { postRecoveryPreflight } : {}),
    };
  }
  const live =
    liveResult && !isCommandTimeout(liveResult) ? parseGatewayInference(liveResult.output) : null;
  const recordedRoute =
    sb?.provider && sb.model ? { provider: sb.provider, model: sb.model } : null;
  const liveRoute = live ? { provider: live.provider, model: live.model } : null;
  // Model/provider are sandbox-scoped status fields, so prefer the durable
  // route recorded for this sandbox. The live shared route is shown separately
  // as drift instead of being mislabeled as this sandbox's configuration.
  const currentModel = sb ? sb.model || "unknown" : (live && live.model) || "unknown";
  const currentProvider = sb ? sb.provider || "unknown" : (live && live.provider) || "unknown";
  const routeDriftPlan =
    sb && sb.provider && sb.model
      ? planInferenceRouteReconcile(live, { provider: sb.provider, model: sb.model })
      : null;
  const routeDrift =
    routeDriftPlan && routeDriftPlan.kind === "diverged"
      ? {
          live: routeDriftPlan.live,
          recorded: routeDriftPlan.recorded,
          canConnect: Boolean(
            sb &&
            gatewayName &&
            canSandboxGatewayRouteRealign(
              sandboxName,
              sb,
              gatewayName,
              (opts.deps?.listSandboxes ?? registry.listSandboxes)().sandboxes,
            ),
          ),
        }
      : null;
  // When the caller has already determined that the local stack is failed
  // (docker daemon down, sandbox container stopped, dashboard port held),
  // skip the provider probe entirely. Without this gate
  // `getSandboxStatusInferenceHealth` would still issue the remote-provider
  // reachability request even though the caller would overwrite the returned
  // value to null afterwards.
  let providerHealth: ProviderHealthStatus | null = null;
  try {
    providerHealth = maybeGetSandboxStatusInferenceHealth(
      suppressInferenceProbe,
      lookup.state === "present",
      (live && live.provider) || currentProvider,
      (live && live.model) || currentModel,
      opts.deps?.probeProviderHealthImpl,
    );
  } catch {
    providerHealth = {
      ok: false,
      probed: false,
      providerLabel: "Upstream provider",
      endpoint: "",
      detail: "Direct provider health probe could not run.",
      probeLabel: "upstream",
    };
  }
  let inferenceHealth = providerHealth;
  // `inference.local` is authoritative because it is the route the agent uses.
  // Probe it independently of direct/upstream provider diagnostics, including
  // providers without a registered host-side health probe (#6192).
  if (!suppressInferenceProbe && lookup.state === "present") {
    let gatewayChain: Awaited<ReturnType<ProbeSandboxInferenceGatewayHealth>> = null;
    // Take the provider and model as one pair. Falling back per field can pair
    // a live model with a recorded provider and request a route neither one
    // describes.
    const invocationRoute =
      live?.provider && live.model
        ? {
            provider: live.provider,
            model: live.model,
            // The live gateway RPC does not expose a stored API family. The
            // recorded API family describes the recorded provider, so it keeps
            // describing the live route while that provider is unchanged,
            // including when only the model drifted. Drop it only when the
            // provider itself changed, so one provider's API family cannot be
            // carried onto another that has no such endpoint (#9302).
            preferredInferenceApi:
              live.provider === sb?.provider ? (sb?.preferredInferenceApi ?? null) : null,
          }
        : {
            provider: currentProvider,
            model: currentModel,
            preferredInferenceApi: sb?.preferredInferenceApi ?? null,
          };
    const invocationModel = (invocationRoute.model || "").trim();
    const invocationProvider = (invocationRoute.provider || "").trim();
    const canProbeInvocation = Boolean(invocationModel && invocationProvider);
    let invocation: ReturnType<typeof runSandboxInferenceInvocationProbe> | null = null;
    try {
      const probe =
        opts.deps?.probeSandboxInferenceGatewayHealthImpl ?? probeSandboxInferenceGatewayHealth;
      const attempts = recoveredManagedGateway ? RECOVERED_INFERENCE_PROBE_ATTEMPTS : 1;
      await retryUntilAsync(
        async () => {
          gatewayChain = await probe(sandboxName);
          invocation =
            gatewayChain?.ok && canProbeInvocation
              ? runSandboxInferenceInvocationProbe(
                  {
                    sandboxName,
                    ...(sb?.agent === "langchain-deepagents-code"
                      ? { agentName: sb.agent }
                      : {}),
                    provider: invocationProvider,
                    model: invocationModel,
                    preferredInferenceApi: invocationRoute.preferredInferenceApi,
                  },
                  opts.deps?.probeSandboxInferenceInvocationImpl,
                  (error) =>
                    reportInferenceProbeError(
                      error,
                      opts.deps?.reportInferenceProbeError ?? console.error,
                    ),
                )
              : null;
          return { gatewayChain, invocation };
        },
        {
          accept: ({ gatewayChain: chain, invocation: result }) =>
            Boolean(chain?.ok && (!canProbeInvocation || result?.ok)),
          retryDelaysMs: Array.from(
            { length: attempts - 1 },
            () => RECOVERED_INFERENCE_PROBE_DELAY_MS,
          ),
          sleep: opts.deps?.delayInferenceRecoveryProbe ?? sleep,
        },
      );
    } catch (error) {
      // This is a permanent fail-closed runtime boundary, but unexpected
      // OpenShell/transport exceptions must remain observable for diagnosis.
      reportInferenceProbeError(error, opts.deps?.reportInferenceProbeError ?? console.error);
      gatewayChain = null;
      invocation = null;
    }
    inferenceHealth = buildSandboxInferenceRouteHealth(gatewayChain, providerHealth, invocation, {
      agentName: sb?.agent ?? null,
      provider: invocationRoute.provider ?? null,
    });
  }
  const statusAgent = resolveSandboxStatusAgent(sb?.agent || "openclaw");
  const terminalRuntimeHealth =
    lookup.state === "present" && statusAgent.agentRuntime === "terminal"
      ? (opts.deps?.probeTerminalRuntimeHealth ?? probeTerminalRuntimeCgroupOom)(sandboxName)
      : null;
  // The serving-process leg is only meaningful when the gateway is up. A
  // manifest declaration alone is not evidence: no self-report response/probe
  // contract exists yet, so status must stay explicitly unchecked (#7003).
  const servingProcessHealth: ServingProcessHealth | null =
    lookup.state === "present" && statusAgent.agentRuntime === "gateway"
      ? { checked: false }
      : null;
  return {
    sb,
    lookup,
    rpcIssue,
    currentModel,
    currentProvider,
    recordedRoute,
    liveRoute,
    routeDrift,
    inferenceHealth,
    terminalRuntimeHealth,
    servingProcessHealth,
    ...(postRecoveryPreflight ? { postRecoveryPreflight } : {}),
  };
}

export async function getSandboxStatusReport(
  sandboxName: string,
  deps: CollectSandboxStatusSnapshotDeps = {},
): Promise<SandboxStatusReport> {
  // The report is the machine-readable (--json) payload the CLI prints on
  // stdout. Building it reconciles the gateway, and that path prints human
  // progress to stdout via console.log (step(), gateway-start streaming).
  // Redirect any such writes to stderr while the report is built so stdout
  // carries only the JSON document.
  return withStdoutRedirectedToStderr(() => buildSandboxStatusReport(sandboxName, deps));
}

async function buildSandboxStatusReport(
  sandboxName: string,
  deps: CollectSandboxStatusSnapshotDeps,
): Promise<SandboxStatusReport> {
  const getSandbox =
    deps.getSandbox ??
    ((name: string) => {
      const entry = registry.getSandbox(name);
      return entry && registry.isPublishedSandboxRegistration(entry) ? entry : null;
    });
  const preflight = await (deps.getSandboxStatusPreflightImpl ?? getSandboxStatusPreflight)(
    getSandbox(sandboxName),
  );
  const snapshot = await collectSandboxStatusSnapshot(sandboxName, {
    preflight,
    deps,
  });
  const {
    sb,
    lookup,
    rpcIssue,
    currentModel,
    currentProvider,
    recordedRoute,
    liveRoute,
    routeDrift,
    inferenceHealth,
    terminalRuntimeHealth,
  } = snapshot;
  const dockerRuntime = lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase = lookup.state === "present" ? (lookup.phase ?? null) : null;
  const effectivePreflight = withoutTerminalPhasePreflight(
    snapshot.postRecoveryPreflight ?? preflight,
    phase,
  );
  const sandboxGpuEnabled = sb ? (sb.sandboxGpuEnabled ?? sb.gpuEnabled === true) : false;
  const hostMounts = normalizeSandboxStatusHostMounts(sb?.hostMounts);
  const policies =
    sb && Array.isArray(sb.policies)
      ? sb.policies.filter((policy): policy is string => typeof policy === "string")
      : [];
  const baselineExclusions = sb?.baselineExclusions?.map((exclusion) => exclusion.key) ?? [];
  const baselineExclusionStates =
    sb?.baselineExclusions?.map((exclusion) => ({
      key: exclusion.key,
      status: (deps.getBaselineExclusionRuntimeStatus ?? getBaselineExclusionRuntimeStatus)(
        sandboxName,
        exclusion,
      ),
    })) ?? [];
  const baselineExclusionTransition = sb?.baselineExclusionTransition
    ? {
        operation: sb.baselineExclusionTransition.operation,
        key: sb.baselineExclusionTransition.exclusion.key,
      }
    : null;
  const agent = resolveSandboxStatusAgent(sb?.agent || "openclaw");
  return {
    schemaVersion: 1,
    name: sandboxName,
    found: !!sb,
    agent: agent.agentName,
    agentDisplayName: agent.agentDisplayName,
    agentRuntime: agent.agentRuntime,
    dcodeAutoApprovalMode: resolveSandboxStatusDcodeAutoApprovalMode(sb),
    ...(agent.agentLoadError ? { agentLoadError: agent.agentLoadError } : {}),
    // Keep schema v1's established live-first fields for existing consumers.
    // The explicit route fields separate durable sandbox intent from the one
    // gateway-global route without changing those legacy meanings.
    model: liveRoute?.model ?? currentModel,
    provider: liveRoute?.provider ?? currentProvider,
    servingProfileProvenance: sb?.servingProfileProvenance ?? null,
    recordedRoute,
    liveRoute,
    routeDrift,
    phase,
    gatewayState: lookup.state,
    inferenceHealth,
    servingProcessHealth: snapshot.servingProcessHealth,
    rpcIssue: rpcIssue ? { kind: rpcIssue.kind } : null,
    hostGpuDetected: !!(sb && sb.hostGpuDetected),
    sandboxGpuEnabled,
    sandboxGpuMode: (sb && sb.sandboxGpuMode) || null,
    sandboxGpuDevice: (sb && sb.sandboxGpuDevice) || null,
    sandboxGpuProof: (sb && sb.sandboxGpuProof) || null,
    hostMounts,
    openshellDriver: (sb && sb.openshellDriver) || "unknown",
    openshellVersion: (sb && sb.openshellVersion) || "unknown",
    policies,
    baselineExclusions,
    baselineExclusionStates,
    baselineExclusionTransition,
    failureLayer: effectivePreflight.failureLayer,
    terminalRuntimeHealth,
    dockerPaused: !!dockerRuntime?.paused,
  };
}
