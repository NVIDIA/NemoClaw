// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcResultIssue,
  type OpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { captureOpenshellForStatus, isCommandTimeout } from "../../adapters/openshell/runtime";
import { parseGatewayInference } from "../../inference/config";
import {
  type ProviderHealthProbeOptions,
  type ProviderHealthStatus,
  probeProviderHealth,
} from "../../inference/health";
import { parseSandboxPhase } from "../../state/gateway";
import * as registry from "../../state/registry";
import { getSandboxDockerRuntime } from "./docker-health";
import { withStdoutRedirectedToStderr } from "../../cli/stdout-guard";
import type { SandboxGatewayState } from "./gateway-state";
import { getReconciledSandboxGatewayState, getSandboxGatewayStateForStatus } from "./gateway-state";
import { probeSandboxInferenceGatewayHealth } from "./process-recovery";
import {
  getSandboxStatusPreflight,
  type SandboxStatusFailureLayer,
  withoutTerminalPhasePreflight,
} from "./status-preflight";

type ProbeProviderHealth = (
  provider: string,
  options?: ProviderHealthProbeOptions,
) => ProviderHealthStatus | null;

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

export interface SandboxStatusReport {
  schemaVersion: 1;
  name: string;
  found: boolean;
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
}

type ReconcileSandboxGatewayState = (sandboxName: string) => Promise<SandboxGatewayState>;

interface CollectSandboxStatusSnapshotDeps {
  probeProviderHealthImpl?: ProbeProviderHealth;
  reconcile?: ReconcileSandboxGatewayState;
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
  const sb = registry.getSandbox(sandboxName);
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
      liveResult = await captureOpenshellForStatus(["inference", "get"]);
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
  const inferenceHealth = maybeGetSandboxStatusInferenceHealth(
    opts.suppressInferenceProbe === true,
    lookup.state === "present",
    currentProvider,
    currentModel,
    opts.deps?.probeProviderHealthImpl,
  );
  if (
    inferenceHealth &&
    lookup.state === "present" &&
    (currentProvider === "ollama-local" || currentProvider === "vllm-local")
  ) {
    const gatewayChain = await probeSandboxInferenceGatewayHealth(sandboxName);
    if (gatewayChain) {
      const gatewaySubprobe: ProviderHealthStatus = {
        ok: gatewayChain.ok,
        probed: true,
        providerLabel: "Inference gateway chain",
        endpoint: gatewayChain.endpoint,
        detail: gatewayChain.detail,
        probeLabel: "gateway",
        ...(gatewayChain.ok ? {} : { failureLabel: "unreachable" as const }),
      };
      inferenceHealth.subprobes = [...(inferenceHealth.subprobes ?? []), gatewaySubprobe];
    }
  }
  return { sb, lookup, rpcIssue, currentModel, currentProvider, inferenceHealth };
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
  const preflight = await getSandboxStatusPreflight(registry.getSandbox(sandboxName));
  const snapshot = await collectSandboxStatusSnapshot(sandboxName, {
    suppressInferenceProbe: preflight.suppressInferenceProbe,
    deps,
  });
  const { sb, lookup, rpcIssue, currentModel, currentProvider, inferenceHealth } = snapshot;
  const dockerRuntime = lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase = lookup.state === "present" ? parseSandboxPhase(lookup.output || "") : null;
  const effectivePreflight = withoutTerminalPhasePreflight(preflight, phase);
  const sandboxGpuEnabled = sb ? (sb.sandboxGpuEnabled ?? sb.gpuEnabled === true) : false;
  const policies =
    sb && Array.isArray(sb.policies)
      ? sb.policies.filter((policy): policy is string => typeof policy === "string")
      : [];
  return {
    schemaVersion: 1,
    name: sandboxName,
    found: !!sb,
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
    dockerPaused: !!dockerRuntime?.paused,
  };
}
