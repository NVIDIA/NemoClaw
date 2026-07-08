// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcResultIssue,
  type OpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { type AgentDefinition, getAgentRuntimeKind, loadAgent } from "../../agent/defs";
import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import { parseGatewayInference } from "../../inference/config";
import {
  type ProviderHealthProbeOptions,
  type ProviderHealthStatus,
  probeProviderHealth,
} from "../../inference/health";
import {
  type DcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "../../onboard/dcode-auto-approval";
import { redact } from "../../security/redact";
import { parseSandboxPhase } from "../../state/gateway";
import * as registry from "../../state/registry";
import { classifyInferenceRouteFailureLabel } from "./connect-inference-route-probe";
import { getSandboxDockerRuntime } from "./docker-health";
import type { SandboxGatewayState } from "./gateway-state";
import { getReconciledSandboxGatewayState, getSandboxGatewayStateForStatus } from "./gateway-state";
import { probeSandboxInferenceGatewayHealth } from "./inference-route-health";
import {
  getSandboxStatusPreflight,
  type SandboxStatusFailureLayer,
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

function providerHealthDiagnostics(
  providerHealth: ProviderHealthStatus | null,
): ProviderHealthStatus[] {
  if (!providerHealth) return [];
  const { subprobes = [], ...primary } = providerHealth;
  const labeledPrimary = primary.probeLabel ? primary : { ...primary, probeLabel: "upstream" };
  return [labeledPrimary, ...subprobes];
}

/** True when the authoritative inference route must make status exit nonzero. */
export function isInferenceHealthFailing(inferenceHealth: ProviderHealthStatus | null): boolean {
  return Boolean(inferenceHealth && (!inferenceHealth.probed || !inferenceHealth.ok));
}

function buildSandboxInferenceRouteHealth(
  gateway: Awaited<ReturnType<ProbeSandboxInferenceGatewayHealth>>,
  providerHealth: ProviderHealthStatus | null,
): ProviderHealthStatus {
  const endpoint = gateway?.endpoint ?? "https://inference.local/v1/models";
  const diagnostics = providerHealthDiagnostics(providerHealth);
  const routeHealth: ProviderHealthStatus = gateway
    ? {
        ok: gateway.ok,
        probed: true,
        providerLabel: "Inference route",
        endpoint,
        detail: gateway.detail,
        ...(gateway.ok
          ? {}
          : {
              failureLabel: classifyInferenceRouteFailureLabel(gateway.httpStatus),
            }),
      }
    : {
        ok: false,
        probed: false,
        providerLabel: "Inference route",
        endpoint,
        detail: `Could not probe ${endpoint} from inside the sandbox.`,
      };
  return diagnostics.length > 0 ? { ...routeHealth, subprobes: diagnostics } : routeHealth;
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
  phase: string | null;
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
  openshellDriver: string;
  openshellVersion: string;
  policies: string[];
  failureLayer: SandboxStatusFailureLayer | null;
  terminalRuntimeHealth: TerminalRuntimeOomProbeResult | null;
  /**
   * Whether the resolved docker-driver sandbox container is paused
   * (`docker pause`). `false` for non-docker-driver sandboxes or when no
   * container is found. A paused container can report `Phase: Error`
   * upstream while the sandbox is intact — see #4495.
   */
  dockerPaused: boolean;
}

export interface SandboxStatusSnapshot {
  sb: registry.SandboxEntry | null;
  lookup: SandboxGatewayState;
  rpcIssue: OpenShellStateRpcIssue | null;
  currentModel: string;
  currentProvider: string;
  inferenceHealth: ProviderHealthStatus | null;
  terminalRuntimeHealth: TerminalRuntimeOomProbeResult | null;
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

interface CollectSandboxStatusSnapshotDeps {
  getSandbox?: typeof registry.getSandbox;
  captureOpenshellForStatusImpl?: typeof captureOpenshellForStatus;
  probeProviderHealthImpl?: ProbeProviderHealth;
  probeSandboxInferenceGatewayHealthImpl?: ProbeSandboxInferenceGatewayHealth;
  reportInferenceProbeError?: (message: string) => void;
  probeTerminalRuntimeHealth?: ProbeTerminalRuntimeHealth;
  reconcile?: ReconcileSandboxGatewayState;
}

function reportInferenceProbeError(error: unknown, writer: (message: string) => void): void {
  const raw = error instanceof Error && error.message ? error.message : String(error);
  const detail = redact(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  writer(
    `  Warning: the authoritative inference.local probe could not run: ${detail.slice(0, 240) || "unknown error"}`,
  );
}

export async function collectSandboxStatusSnapshot(
  sandboxName: string,
  opts: {
    suppressInferenceProbe?: boolean;
    deps?: CollectSandboxStatusSnapshotDeps;
  } = {},
): Promise<SandboxStatusSnapshot> {
  const reconcile =
    opts.deps?.reconcile ??
    ((name: string) =>
      getReconciledSandboxGatewayState(name, {
        getState: getSandboxGatewayStateForStatus,
      }));
  const getSandbox = opts.deps?.getSandbox ?? registry.getSandbox;
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
  let liveResult: Awaited<ReturnType<typeof captureOpenshellForStatus>> | null = null;
  if (lookup.state === "present") {
    try {
      liveResult = await (opts.deps?.captureOpenshellForStatusImpl ?? captureOpenshellForStatus)([
        "inference",
        "get",
      ]);
    } catch {
      liveResult = null;
    }
  }
  const rpcIssue = liveResult ? detectOpenShellStateRpcResultIssue(liveResult) : null;
  if (rpcIssue) {
    return {
      sb,
      lookup,
      rpcIssue,
      currentModel: "unknown",
      currentProvider: "unknown",
      inferenceHealth: null,
      terminalRuntimeHealth: null,
    };
  }
  const live =
    liveResult && !isCommandTimeout(liveResult) ? parseGatewayInference(liveResult.output) : null;
  const currentModel = (live && live.model) || (sb && sb.model) || "unknown";
  const currentProvider = (live && live.provider) || (sb && sb.provider) || "unknown";
  // When the caller has already determined that the local stack is failed
  // (docker daemon down, sandbox container stopped, dashboard port held),
  // skip the provider probe entirely. Without this gate
  // `getSandboxStatusInferenceHealth` would still issue the remote-provider
  // reachability request even though the caller would overwrite the returned
  // value to null afterwards.
  let providerHealth: ProviderHealthStatus | null = null;
  try {
    providerHealth = maybeGetSandboxStatusInferenceHealth(
      opts.suppressInferenceProbe === true,
      lookup.state === "present",
      currentProvider,
      currentModel,
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
  if (opts.suppressInferenceProbe !== true && lookup.state === "present") {
    let gatewayChain: Awaited<ReturnType<ProbeSandboxInferenceGatewayHealth>> = null;
    try {
      gatewayChain = await (
        opts.deps?.probeSandboxInferenceGatewayHealthImpl ?? probeSandboxInferenceGatewayHealth
      )(sandboxName);
    } catch (error) {
      // This is a permanent fail-closed runtime boundary, but unexpected
      // OpenShell/transport exceptions must remain observable for diagnosis.
      reportInferenceProbeError(error, opts.deps?.reportInferenceProbeError ?? console.error);
      gatewayChain = null;
    }
    inferenceHealth = buildSandboxInferenceRouteHealth(gatewayChain, providerHealth);
  }
  const statusAgent = resolveSandboxStatusAgent(sb?.agent || "openclaw");
  const terminalRuntimeHealth =
    lookup.state === "present" && statusAgent.agentRuntime === "terminal"
      ? (opts.deps?.probeTerminalRuntimeHealth ?? probeTerminalRuntimeCgroupOom)(sandboxName)
      : null;
  return {
    sb,
    lookup,
    rpcIssue,
    currentModel,
    currentProvider,
    inferenceHealth,
    terminalRuntimeHealth,
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
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const preflight = await getSandboxStatusPreflight(getSandbox(sandboxName));
  const snapshot = await collectSandboxStatusSnapshot(sandboxName, {
    suppressInferenceProbe: preflight.suppressInferenceProbe,
    deps,
  });
  const {
    sb,
    lookup,
    rpcIssue,
    currentModel,
    currentProvider,
    inferenceHealth,
    terminalRuntimeHealth,
  } = snapshot;
  const dockerRuntime = lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase = lookup.state === "present" ? parseSandboxPhase(lookup.output || "") : null;
  const effectivePreflight = withoutTerminalPhasePreflight(preflight, phase);
  const sandboxGpuEnabled = sb ? (sb.sandboxGpuEnabled ?? sb.gpuEnabled === true) : false;
  const policies =
    sb && Array.isArray(sb.policies)
      ? sb.policies.filter((policy): policy is string => typeof policy === "string")
      : [];
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
    model: currentModel,
    provider: currentProvider,
    phase,
    gatewayState: lookup.state,
    inferenceHealth,
    rpcIssue: rpcIssue ? { kind: rpcIssue.kind } : null,
    hostGpuDetected: !!(sb && sb.hostGpuDetected),
    sandboxGpuEnabled,
    sandboxGpuMode: (sb && sb.sandboxGpuMode) || null,
    sandboxGpuDevice: (sb && sb.sandboxGpuDevice) || null,
    sandboxGpuProof: (sb && sb.sandboxGpuProof) || null,
    openshellDriver: (sb && sb.openshellDriver) || "unknown",
    openshellVersion: (sb && sb.openshellVersion) || "unknown",
    policies,
    failureLayer: effectivePreflight.failureLayer,
    terminalRuntimeHealth,
    dockerPaused: !!dockerRuntime?.paused,
  };
}
