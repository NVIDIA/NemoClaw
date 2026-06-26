// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printOpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, RD, YW } from "../../cli/terminal-style";
import { type ProviderHealthStatus } from "../../inference/health";
import * as nim from "../../inference/nim";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import { parseSandboxPhase } from "../../state/gateway";
import type { SandboxGpuProofResult } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import { getSandboxDockerRuntime } from "./docker-health";
import type { SandboxGatewayState } from "./gateway-state";
import { isSandboxGatewayRunningForStatus } from "./process-recovery";
import { printSandboxGatewayLookupStatus } from "./status-lookup-rendering";
import {
  getSandboxStatusPreflight,
  printSandboxStatusPreflightHeader,
  withoutTerminalPhasePreflight,
} from "./status-preflight";
import { collectSandboxStatusSnapshot, resolveSandboxStatusAgent } from "./status-snapshot";

export {
  type ClassifySandboxStatusPreflightFailureDeps,
  classifySandboxContainerFailureForStatus,
  classifySandboxStatusPreflightFailure,
  getSandboxStatusPreflight,
  isDockerDaemonUnreachableForStatus,
  printGatewayFailureLayerHeader,
  printSandboxStatusPreflightHeader,
  type SandboxStatusFailureLayer,
  type SandboxStatusPreflightFailure,
  type SandboxStatusPreflightResult,
  withoutTerminalPhasePreflight,
} from "./status-preflight";
export {
  collectSandboxStatusSnapshot,
  getSandboxStatusInferenceHealth,
  getSandboxStatusReport,
  maybeGetSandboxStatusInferenceHealth,
  type SandboxStatusReport,
  type SandboxStatusSnapshot,
} from "./status-snapshot";

/**
 * Returns true when status can validate an agent version against the running sandbox.
 */
function shouldProbeSandboxRuntimeVersion(
  lookup: SandboxGatewayState,
  sandbox: registry.SandboxEntry,
  agentRuntimeKind: string,
): boolean {
  return (
    lookup.state === "present" && (Boolean(sandbox.agentVersion) || agentRuntimeKind === "terminal")
  );
}

// True when sandbox GPU is enabled but no CUDA-usability proof has confirmed it
// (older entries with no recorded proof, or a run whose CUDA proof could not
// execute). Treated as not-yet-proven rather than healthy (#4231).
export function sandboxGpuProofUnverified(
  proof: SandboxGpuProofResult | null | undefined,
): boolean {
  return !proof || proof.status === "unverified";
}

// Render the proof-state suffix appended to the `Sandbox GPU: enabled` line so
// the status reflects verified/unverified/failed CUDA usability instead of
// reporting any configured GPU as healthy (#4231).
export function sandboxGpuProofStatusSuffix(
  proof: SandboxGpuProofResult | null | undefined,
): string {
  if (proof?.status === "verified") return ` ${G}(CUDA verified)${R}`;
  if (proof?.status === "failed") {
    const label = proof.label ? `: ${proof.label}` : "";
    return ` ${RD}(last CUDA proof failed${label})${R}`;
  }
  return ` ${YW}(CUDA unverified)${R}`;
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
  console.log(`    ${label}: ${RD}${probe.failureLabel || "unreachable"}${R} (${probe.endpoint})`);
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

// eslint-disable-next-line complexity
export async function showSandboxStatus(sandboxName: string): Promise<void> {
  const preflight = await getSandboxStatusPreflight(registry.getSandbox(sandboxName));
  // #2666: never let an unexpected throw from the gateway probe (e.g. openshell
  // hanging when its container is stopped and the published port is held by a
  // foreign listener) suppress the sandbox header. The downstream switch
  // handles `gateway_error` by printing an actionable block + exit(1), so a
  // synthesized fallback keeps the user-visible contract intact.
  const snapshot = await collectSandboxStatusSnapshot(sandboxName, {
    suppressInferenceProbe: preflight.suppressInferenceProbe,
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
  // Resolve the docker-driver container once: reused for the paused-container
  // recovery hint (#4495) and the Docker health line below (#3975).
  const dockerRuntime = lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase = lookup.state === "present" ? parseSandboxPhase(lookup.output || "") : null;
  const effectivePreflight = withoutTerminalPhasePreflight(preflight, phase);
  const statusAgent = resolveSandboxStatusAgent(sb?.agent || "openclaw");
  printSandboxStatusPreflightHeader(effectivePreflight);
  if (effectivePreflight.exitCode !== 0) {
    process.exitCode = effectivePreflight.exitCode;
  }
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
    const sandboxGpuEnabled = sb.sandboxGpuEnabled ?? sb.gpuEnabled === true;
    const sandboxGpu = sandboxGpuEnabled ? "enabled" : "disabled";
    const sandboxGpuMode = sb.sandboxGpuMode ? ` (${sb.sandboxGpuMode})` : "";
    const sandboxGpuDevice = sb.sandboxGpuDevice ? ` device=${sb.sandboxGpuDevice}` : "";
    const sandboxGpuProofSuffix = sandboxGpuEnabled
      ? sandboxGpuProofStatusSuffix(sb.sandboxGpuProof)
      : "";
    const openshellDriver = sb.openshellDriver || "unknown";
    const openshellVersion = sb.openshellVersion || "unknown";
    console.log(`    Host GPU: ${hostGpu}`);
    console.log(
      `    Sandbox GPU: ${sandboxGpu}${sandboxGpuMode}${sandboxGpuDevice}${sandboxGpuProofSuffix}`,
    );
    if (sandboxGpuEnabled && sb.sandboxGpuProof?.status === "failed") {
      const detail = sb.sandboxGpuProof.detail;
      if (detail) console.log(`      ${detail}`);
      console.log(
        "      CUDA failed a live proof. Recreate with corrected GPU device/group access, or rerun onboard with --no-gpu.",
      );
    } else if (sandboxGpuEnabled && sandboxGpuProofUnverified(sb.sandboxGpuProof)) {
      console.log(
        "      CUDA usability has not been proven. Rerun onboard to verify, or use --no-gpu for CPU.",
      );
    }
    console.log(`    OpenShell: ${openshellVersion} (${openshellDriver})`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
    console.log(`    Harness:  ${statusAgent.agentDisplayName} (${statusAgent.agentRuntime})`);
    if (statusAgent.agentLoadError) {
      console.log(`    Agent load error: ${statusAgent.agentLoadError}`);
    }
    if (statusAgent.agentDefinition && statusAgent.agentRuntime === "terminal") {
      const interactiveCommand = agentRuntime.getTerminalCommand(
        statusAgent.agentDefinition,
        "interactive",
      );
      const headlessCommand = agentRuntime.getTerminalCommand(
        statusAgent.agentDefinition,
        "headless",
      );
      if (interactiveCommand) console.log(`    Interactive: ${interactiveCommand}`);
      if (headlessCommand) console.log(`    Headless: ${headlessCommand} "<prompt>"`);
      console.log("    Updates: managed by NemoClaw image rebuilds");
      if (lookup.state === "present") {
        if (terminalRuntimeHealth?.kind === "degraded") {
          process.exitCode = process.exitCode && process.exitCode !== 0 ? process.exitCode : 1;
          const countLabel =
            terminalRuntimeHealth.oomKillCount === 1
              ? "1 OOM kill"
              : `${terminalRuntimeHealth.oomKillCount} OOM kills`;
          console.log(`    Runtime health: ${YW}degraded${R} (${countLabel} recorded)`);
          console.log("      Sandbox may be degraded after an OOM kill.");
          console.log(`      Run \`${CLI_NAME} ${sandboxName} rebuild\` to restore.`);
        }
      }
    }

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
      const shouldProbeRuntimeVersion = shouldProbeSandboxRuntimeVersion(
        lookup,
        sb,
        statusAgent.agentRuntime,
      );
      const versionCheck = sandboxVersion.checkAgentVersion(sandboxName, {
        forceProbe: shouldProbeRuntimeVersion,
        skipProbe: !shouldProbeRuntimeVersion,
      });
      const agentName = statusAgent.agentDisplayName;
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
        console.log(
          `              Run \`${CLI_NAME} ${sandboxName} rebuild\` if this sandbox predates the current install`,
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  await printSandboxGatewayLookupStatus({
    sandboxName,
    lookup,
    phase,
    dockerRuntime,
    effectivePreflight,
  });

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    if (statusAgent.agentRuntime !== "gateway") {
      if (statusAgent.agentRuntime === "unknown") {
        console.log(`    Agent '${statusAgent.agentName}' runtime: ${YW}unknown${R}`);
      } else {
        console.log(`    ${statusAgent.agentDisplayName} runtime: ${G}terminal${R}`);
      }
    } else {
      const running = await isSandboxGatewayRunningForStatus(sandboxName);
      if (running !== null) {
        const sessionAgentName = statusAgent.agentDisplayName;
        if (running) {
          console.log(`    ${sessionAgentName}: ${G}running${R}`);
        } else {
          console.log(`    ${sessionAgentName}: ${RD}not running${R}`);
          console.log("");
          console.log(
            `  The sandbox is alive but the ${sessionAgentName} gateway process is not running.`,
          );
          console.log(
            "  This typically happens after a gateway restart (e.g., laptop close/open).",
          );
          console.log("");
          console.log("  To recover, run:");
          console.log(`    ${D}${CLI_NAME} ${sandboxName} connect${R}  (auto-recovers on connect)`);
          console.log("  Or manually inside the sandbox:");
          console.log(`    ${D}${agentRuntime.getGatewayCommand(statusAgent.agentDefinition)}${R}`);
        }
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
