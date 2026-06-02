// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import {
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import {
  captureOpenshellForStatus,
  isCommandTimeout,
} from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { D, G, R, RD, YW } from "../../cli/terminal-style";
import { parseGatewayInference } from "../../inference/config";
import {
  type ProviderHealthProbeOptions,
  type ProviderHealthStatus,
  probeProviderHealth,
} from "../../inference/health";
import * as nim from "../../inference/nim";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import { isTerminalSandboxPhase, parseSandboxPhase } from "../../state/gateway";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { getSandboxDockerRuntime } from "./docker-health";
import {
  classifyGatewayFailure,
  getLayerHeader,
  isDockerRuntimeDown,
  printDockerRuntimeDownGuidance,
} from "./gateway-failure-classifier";
import type { SandboxGatewayState } from "./gateway-state";
import {
  getReconciledSandboxGatewayState,
  getSandboxGatewayStateForStatus,
  printGatewayLifecycleHint,
  printWrongGatewayActiveGuidance,
} from "./gateway-state";
import {
  isSandboxGatewayRunningForStatus,
  probeSandboxInferenceGatewayHealth,
} from "./process-recovery";

type ProbeProviderHealth = (
  provider: string,
  options?: ProviderHealthProbeOptions,
) => ProviderHealthStatus | null;

/**
 * Returns true when status can validate a cached agent version against the running sandbox.
 */
function shouldProbeSandboxRuntimeVersion(
  lookup: SandboxGatewayState,
  sandbox: registry.SandboxEntry,
): boolean {
  return lookup.state === "present" && Boolean(sandbox.agentVersion);
}

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
  openshellDriver: string;
  openshellVersion: string;
  policies: string[];
  /**
   * Whether the resolved docker-driver sandbox container is paused
   * (`docker pause`). `false` for non-docker-driver sandboxes or when no
   * container is found. A paused container can report `Phase: Error`
   * upstream while the sandbox is intact — see #4495.
   */
  dockerPaused: boolean;
}

interface SandboxStatusSnapshot {
  sb: registry.SandboxEntry | null;
  lookup: SandboxGatewayState;
  rpcIssue: ReturnType<typeof detectOpenShellStateRpcResultIssue>;
  currentModel: string;
  currentProvider: string;
  inferenceHealth: ProviderHealthStatus | null;
}

async function collectSandboxStatusSnapshot(
  sandboxName: string,
): Promise<SandboxStatusSnapshot> {
  const sb = registry.getSandbox(sandboxName);
  let lookup: SandboxGatewayState;
  try {
    lookup = await getReconciledSandboxGatewayState(sandboxName, {
      getState: getSandboxGatewayStateForStatus,
    });
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
  const inferenceHealth = getSandboxStatusInferenceHealth(
    lookup.state === "present",
    currentProvider,
    currentModel,
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
): Promise<SandboxStatusReport> {
  const snapshot = await collectSandboxStatusSnapshot(sandboxName);
  const { sb, lookup, rpcIssue, currentModel, currentProvider, inferenceHealth } = snapshot;
  const dockerRuntime =
    lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase =
    lookup.state === "present" ? parseSandboxPhase(lookup.output || "") : null;
  const sandboxGpuEnabled = sb
    ? (sb.sandboxGpuEnabled ?? (sb.gpuEnabled === true))
    : false;
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
    openshellDriver: (sb && sb.openshellDriver) || "unknown",
    openshellVersion: (sb && sb.openshellVersion) || "unknown",
    policies,
    dockerPaused: !!dockerRuntime?.paused,
  };
}

/**
 * Render one Inference status line. The main probe and each subprobe go
 * through this helper so multi-hop providers (e.g. ollama-local backend +
 * auth proxy) get parallel formatting and the failure of any hop is
 * surfaced individually instead of being hidden by a healthy hop. (#3265)
 */
function printInferenceProbeLine(probe: ProviderHealthStatus): void {
  const label = probe.probeLabel ? `Inference (${probe.probeLabel})` : "Inference";
  if (!probe.probed) {
    console.log(`    ${label}: ${D}not probed${R} (${probe.detail})`);
    return;
  }
  if (probe.ok) {
    console.log(`    ${label}: ${G}healthy${R} (${probe.endpoint})`);
    return;
  }
  // `failureLabel` is set by the probe (e.g. `unauthorized` for HTTP 401 on
  // the auth proxy in `inference/local.ts:probeOllamaAuthProxyHealth`); the
  // `|| "unreachable"` fallback only applies when an upstream forgot to set
  // one. Don't infer the failure mode here — preserve what the probe said. (#3265)
  console.log(
    `    ${label}: ${RD}${probe.failureLabel || "unreachable"}${R} (${probe.endpoint})`,
  );
  console.log(`      ${probe.detail}`);
}

function maybeEnsureHermesToolGatewayBroker(sb: registry.SandboxEntry | null): void {
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
    hermesToolGatewayBroker.ensureHermesToolGatewayBrokerForSandboxEntry(sb, { quiet: true });
  } catch {
    /* non-fatal — status should still show sandbox diagnostics */
  }
}

async function printGatewayFailureLayerHeader(sandboxName: string): Promise<void> {
  const failure = await classifyGatewayFailure(sandboxName);
  console.log(`  ${getLayerHeader(failure.layer)}`);
}

function printMissingLiveSandboxStatusGuidance(
  sandboxName: string,
  lookup: SandboxGatewayState,
): void {
  console.log("");
  console.log(
    `  Sandbox '${sandboxName}' is registered locally, but is not present in the live OpenShell gateway.`,
  );
  if (lookup.recoveredGateway) {
    const via = lookup.recoveryVia ? ` via ${lookup.recoveryVia}` : "";
    console.log(
      `  The ${CLI_DISPLAY_NAME} gateway was just recovered${via}; it may still be reconciling post-restart sandbox state.`,
    );
  }
  console.log("  No local registry entry was removed by this status check.");
  console.log(
    `  Retry \`${CLI_NAME} ${sandboxName} status\` after the gateway finishes reconnecting.`,
  );
  console.log(
    `  If the sandbox was intentionally deleted, run \`${CLI_NAME} list\` to inspect the remaining sandboxes or \`${CLI_NAME} onboard\` to create a new one.`,
  );
}

// eslint-disable-next-line complexity
export async function showSandboxStatus(sandboxName: string): Promise<void> {
  // #2666: never let an unexpected throw from the gateway probe (e.g. openshell
  // hanging when its container is stopped and the published port is held by a
  // foreign listener) suppress the sandbox header. The downstream switch
  // handles `gateway_error` by printing an actionable block + exit(1), so a
  // synthesized fallback keeps the user-visible contract intact.
  const snapshot = await collectSandboxStatusSnapshot(sandboxName);
  const { sb, lookup, rpcIssue, currentModel, currentProvider, inferenceHealth } = snapshot;
  // Resolve the docker-driver container once: reused for the paused-container
  // recovery hint (#4495) and the Docker health line below (#3975).
  const dockerRuntime =
    lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  maybeEnsureHermesToolGatewayBroker(sb);
  if (rpcIssue) {
    printOpenShellStateRpcIssue(rpcIssue, {
      action: `checking inference status for sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} status`,
    });
    process.exit(1);
  }
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${currentModel}`);
    console.log(`    Provider: ${currentProvider}`);
    if (inferenceHealth) {
      printInferenceProbeLine(inferenceHealth);
      for (const sub of inferenceHealth.subprobes ?? []) {
        printInferenceProbeLine(sub);
      }
    }
    if (lookup.state !== "present") {
      console.log("    Inference: not verified (gateway/sandbox state not verified)");
    }
    const hostGpu = sb.hostGpuDetected ? "yes" : "no";
    const sandboxGpuEnabled = sb.sandboxGpuEnabled ?? (sb.gpuEnabled === true);
    const sandboxGpu = sandboxGpuEnabled ? "enabled" : "disabled";
    const sandboxGpuMode = sb.sandboxGpuMode ? ` (${sb.sandboxGpuMode})` : "";
    const sandboxGpuDevice = sb.sandboxGpuDevice ? ` device=${sb.sandboxGpuDevice}` : "";
    const openshellDriver = sb.openshellDriver || "unknown";
    const openshellVersion = sb.openshellVersion || "unknown";
    console.log(`    Host GPU: ${hostGpu}`);
    console.log(`    Sandbox GPU: ${sandboxGpu}${sandboxGpuMode}${sandboxGpuDevice}`);
    console.log(`    OpenShell: ${openshellVersion} (${openshellDriver})`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);

    // Active session indicator
    try {
      const opsBinStatus = resolveOpenshell();
      if (opsBinStatus) {
        const sessionResult = getActiveSandboxSessions(
          sandboxName,
          createSessionDeps(opsBinStatus),
        );
        if (sessionResult.detected) {
          const count = sessionResult.sessions.length;
          console.log(
            `    Connected: ${count > 0 ? `${G}yes${R} (${count} session${count > 1 ? "s" : ""})` : "no"}`,
          );
        }
      }
    } catch {
      /* non-fatal */
    }

    const shieldsPosture = shields.getShieldsPosture(sandboxName, true);
    if (shieldsPosture.mode !== "locked") {
      const detail =
        shieldsPosture.mode === "mutable_default"
          ? shieldsPosture.detail
          : `${shieldsPosture.detail} (check \`shields status\` for details)`;
      console.log(`    Permissions: ${detail}`);
    }

    // Agent version check
    try {
      const shouldProbeRuntimeVersion = shouldProbeSandboxRuntimeVersion(lookup, sb);
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName, {
        forceProbe: shouldProbeRuntimeVersion,
        skipProbe: !shouldProbeRuntimeVersion,
      });
      const agent = agentRuntime.getSessionAgent(sandboxName);
      const agentName = agentRuntime.getAgentDisplayName(agent);
      if (versionCheck.sandboxVersion) {
        console.log(`    Agent:    ${agentName} v${versionCheck.sandboxVersion}`);
      } else if (shouldProbeRuntimeVersion && versionCheck.expectedVersion) {
        console.log(
          `    Agent:    ${agentName} version not verified (expected v${versionCheck.expectedVersion})`,
        );
      }
      if (versionCheck.isStale) {
        console.log(`    ${YW}Update:   v${versionCheck.expectedVersion} available${R}`);
        console.log(`              Run \`${CLI_NAME} ${sandboxName} rebuild\` to upgrade`);
      } else if (
        shouldProbeRuntimeVersion &&
        versionCheck.detectionMethod === "unavailable" &&
        versionCheck.expectedVersion
      ) {
        console.log(`    ${YW}Update:   unable to verify sandbox ${agentName} version${R}`);
        console.log(`              Run \`${CLI_NAME} ${sandboxName} rebuild\` if this sandbox predates the current install`);
      }
    } catch {
      /* non-fatal */
    }
  }

  if (lookup.state === "present") {
    console.log("");
    if ("recoveredGateway" in lookup && lookup.recoveredGateway) {
      console.log(
        `  Recovered ${CLI_DISPLAY_NAME} gateway runtime via ${("recoveryVia" in lookup ? lookup.recoveryVia : null) || "gateway reattach"}.`,
      );
      console.log("");
    }
    console.log(lookup.output);
    const phase = parseSandboxPhase(lookup.output || "");
    if (phase && phase !== "Ready") {
      // A non-ready, non-terminal phase can mean two very different things. If
      // the Docker daemon is down, OpenShell can still return a present-but-
      // Provisioning sandbox (cached/transitional state); steering the user
      // toward rebuild is wrong because the sandbox is fine and rebuild cannot
      // succeed until Docker is back. Reclassify as a runtime outage first
      // (#4428). Terminal phases (Failed/Error/...) are settled sandbox
      // failures and keep the existing rebuild guidance even when Docker is
      // down, so a genuine failure is never masked.
      if (!isTerminalSandboxPhase(phase) && isDockerRuntimeDown(sandboxName)) {
        console.log("");
        printDockerRuntimeDownGuidance(sandboxName, { writer: console.log });
        process.exit(1);
      }
      // A paused Docker-driver container can surface upstream as `Phase: Error`
      // (e.g. GPU passthrough on Ubuntu 24.04) even though the sandbox is
      // otherwise intact. We do not rewrite OpenShell's authoritative phase
      // (printed verbatim above); we add a paused-container recovery hint so
      // the failure mode is actionable, and skip the misleading rebuild
      // suggestion since unpausing — not recreating — is the fix. See #4495.
      // `Error` is terminal, so the #4428 runtime-down reclassification above
      // does not intercept this branch.
      if (phase === "Error" && dockerRuntime?.paused && dockerRuntime.containerName) {
        console.log("");
        console.log(
          `  The Docker-driver container for '${sandboxName}' is paused: ${dockerRuntime.containerName}`,
        );
        console.log(
          "  A paused container can report 'Phase: Error' even though the sandbox is intact.",
        );
        console.log("  Resume it to restore the running phase:");
        console.log(`    ${D}docker unpause ${dockerRuntime.containerName}${R}`);
      } else {
        console.log("");
        console.log(`  Sandbox '${sandboxName}' is stuck in '${phase}' phase.`);
        console.log(
          "  This usually happens when a process crash inside the sandbox prevented clean startup.",
        );
        console.log("");
        console.log(
          `  Run \`${CLI_NAME} ${sandboxName} rebuild --yes\` to recreate the sandbox (--yes skips the confirmation prompt; workspace state will be preserved).`,
        );
      }
    }
  } else if (lookup.state === "wrong_gateway_active") {
    const activeGateway =
      "activeGateway" in lookup && typeof lookup.activeGateway === "string"
        ? lookup.activeGateway
        : undefined;
    console.log("");
    printWrongGatewayActiveGuidance(sandboxName, activeGateway, console.log);
    process.exit(1);
  } else if (lookup.state === "gateway_schema_mismatch") {
    console.log(lookup.output);
    process.exit(1);
  } else if (lookup.state === "missing") {
    printMissingLiveSandboxStatusGuidance(sandboxName, lookup);
    process.exit(1);
  } else if (lookup.state === "identity_drift") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.log(
      `  Recreate this sandbox with \`${CLI_NAME} onboard\` once the gateway runtime is stable.`,
    );
    process.exit(1);
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    await printGatewayFailureLayerHeader(sandboxName);
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected ${CLI_DISPLAY_NAME} gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.log(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    await printGatewayFailureLayerHeader(sandboxName);
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the ${CLI_DISPLAY_NAME} gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.log(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    process.exit(1);
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    await printGatewayFailureLayerHeader(sandboxName);
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
    process.exit(1);
  }

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    const running = await isSandboxGatewayRunningForStatus(sandboxName);
    if (running !== null) {
      const sessionAgent = agentRuntime.getSessionAgent(sandboxName);
      const sessionAgentName = agentRuntime.getAgentDisplayName(sessionAgent);
      if (running) {
        console.log(`    ${sessionAgentName}: ${G}running${R}`);
      } else {
        console.log(`    ${sessionAgentName}: ${RD}not running${R}`);
        console.log("");
        console.log(
          `  The sandbox is alive but the ${sessionAgentName} gateway process is not running.`,
        );
        console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
        console.log("");
        console.log("  To recover, run:");
        console.log(`    ${D}${CLI_NAME} ${sandboxName} connect${R}  (auto-recovers on connect)`);
        console.log("  Or manually inside the sandbox:");
        console.log(`    ${D}${agentRuntime.getGatewayCommand(sessionAgent)}${R}`);
      }
    }
  }

  // Surface the Docker healthcheck signal as its own line so users can
  // tell when it disagrees with NemoClaw's own delivery-chain probes
  // (sandbox phase, OpenClaw process, host port forward). On runtimes
  // where the dashboard port lives in a different network namespace
  // (e.g. DGX Spark / aarch64 with OpenShell-managed forwarding), the
  // in-container /health curl can fail even though the delivery chain
  // is fine — older images without the #3975 healthcheck fallback will
  // emit a stale "unhealthy" here while the rest of `status` shows the
  // sandbox is reachable. We deliberately do not downgrade the signal
  // automatically: the in-sandbox `isSandboxGatewayRunningForStatus`
  // probe uses the same 127.0.0.1 endpoint Docker checks, so it cannot
  // independently confirm that Docker's reading is stale. (#3975)
  if (lookup.state === "present" && dockerRuntime) {
    const dockerHealth = dockerRuntime;
    if (dockerHealth.health !== "none" && dockerHealth.health !== "unknown") {
      if (dockerHealth.health === "healthy") {
        console.log(`    Docker health: ${G}healthy${R}`);
      } else if (dockerHealth.health === "starting") {
        console.log(`    Docker health: ${D}starting${R}`);
      } else {
        console.log(`    Docker health: ${RD}unhealthy${R}`);
        console.log(
          `      ${D}This is the in-container Docker probe; compare with the host-side delivery${R}`,
        );
        console.log(
          `      ${D}chain above. A mismatch can be a stale signal on OpenShell-managed${R}`,
        );
        console.log(`      ${D}runtimes — see #3975.${R}`);
      }
    }
  }

  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  if (nim.shouldShowNimLine(sb && sb.nimContainer, nimStat.running)) {
    console.log(
      `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
    );
    if (nimStat.running) {
      console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
    }
  }
  console.log("");
}
