// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, RD, YW } from "../../cli/terminal-style";
import type { ProviderHealthStatus } from "../../inference/health";
import * as nim from "../../inference/nim";
import * as sandboxVersion from "../../sandbox/version";
import * as shields from "../../shields";
import type { SandboxEntry, SandboxGpuProofResult } from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import type { SandboxDockerRuntime } from "./docker-health";
import type { SandboxGatewayState } from "./gateway-state";
import { isSandboxGatewayRunningForStatus } from "./process-recovery";
import type { SandboxStatusAgentInfo, SandboxStatusSnapshot } from "./status-snapshot";

export interface SandboxStatusTextContext
  extends Pick<
    SandboxStatusSnapshot,
    | "sb"
    | "lookup"
    | "currentModel"
    | "currentProvider"
    | "inferenceHealth"
    | "terminalRuntimeHealth"
  > {
  sandboxName: string;
  statusAgent: SandboxStatusAgentInfo;
}

export interface SandboxStatusTextOutcome {
  exitCode: number | null;
}

/** Returns true when status can validate an agent version against the running sandbox. */
function shouldProbeSandboxRuntimeVersion(
  lookup: SandboxGatewayState,
  sandbox: SandboxEntry,
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

/** Render one inference probe so every hop uses the same status vocabulary. */
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
  console.log(`    ${label}: ${RD}${probe.failureLabel || "unreachable"}${R} (${probe.endpoint})`);
  console.log(`      ${probe.detail}`);
}

function printInferenceStatus(context: SandboxStatusTextContext): void {
  if (context.inferenceHealth) {
    printInferenceProbeLine(context.inferenceHealth);
    for (const subprobe of context.inferenceHealth.subprobes ?? []) {
      printInferenceProbeLine(subprobe);
    }
  }
  if (context.lookup.state !== "present") {
    console.log("    Inference: not verified (gateway/sandbox state not verified)");
  }
}

function getSandboxGpuDisplay(sandbox: SandboxEntry): {
  enabled: boolean;
  hostGpu: string;
  sandboxGpu: string;
} {
  const hostGpu = sandbox.hostGpuDetected ? "yes" : "no";
  const enabled = sandbox.sandboxGpuEnabled ?? sandbox.gpuEnabled === true;
  const state = enabled ? "enabled" : "disabled";
  const mode = sandbox.sandboxGpuMode ? ` (${sandbox.sandboxGpuMode})` : "";
  const device = sandbox.sandboxGpuDevice ? ` device=${sandbox.sandboxGpuDevice}` : "";
  const proofSuffix = enabled ? sandboxGpuProofStatusSuffix(sandbox.sandboxGpuProof) : "";
  return {
    enabled,
    hostGpu,
    sandboxGpu: `${state}${mode}${device}${proofSuffix}`,
  };
}

function printSandboxGpuStatus(sandbox: SandboxEntry): void {
  const display = getSandboxGpuDisplay(sandbox);
  console.log(`    Host GPU: ${display.hostGpu}`);
  console.log(`    Sandbox GPU: ${display.sandboxGpu}`);
  if (!display.enabled) return;

  if (sandbox.sandboxGpuProof?.status === "failed") {
    if (sandbox.sandboxGpuProof.detail) console.log(`      ${sandbox.sandboxGpuProof.detail}`);
    console.log(
      "      CUDA failed a live proof. Recreate with corrected GPU device/group access, or rerun onboard with --no-gpu.",
    );
    return;
  }
  if (sandboxGpuProofUnverified(sandbox.sandboxGpuProof)) {
    console.log(
      "      CUDA usability has not been proven. Rerun onboard to verify, or use --no-gpu for CPU.",
    );
  }
}

function printTerminalHarness(context: SandboxStatusTextContext): number | null {
  const { lookup, sandboxName, statusAgent, terminalRuntimeHealth } = context;
  if (!statusAgent.agentDefinition || statusAgent.agentRuntime !== "terminal") return null;

  const interactiveCommand = agentRuntime.getTerminalCommand(
    statusAgent.agentDefinition,
    "interactive",
  );
  const headlessCommand = agentRuntime.getTerminalCommand(statusAgent.agentDefinition, "headless");
  if (interactiveCommand) console.log(`    Interactive: ${interactiveCommand}`);
  if (headlessCommand) console.log(`    Headless: ${headlessCommand} "<prompt>"`);
  console.log("    Updates: managed by NemoClaw image rebuilds");

  if (lookup.state !== "present" || terminalRuntimeHealth?.kind !== "degraded") return null;
  const countLabel =
    terminalRuntimeHealth.oomKillCount === 1
      ? "1 OOM kill"
      : `${terminalRuntimeHealth.oomKillCount} OOM kills`;
  console.log(`    Runtime health: ${YW}degraded${R} (${countLabel} recorded)`);
  console.log("      Sandbox may be degraded after an OOM kill.");
  console.log(`      Run \`${CLI_NAME} ${sandboxName} rebuild\` to restore.`);
  return 1;
}

function printAgentHarness(context: SandboxStatusTextContext): number | null {
  const { statusAgent } = context;
  console.log(`    Harness:  ${statusAgent.agentDisplayName} (${statusAgent.agentRuntime})`);
  if (statusAgent.agentLoadError) {
    console.log(`    Agent load error: ${statusAgent.agentLoadError}`);
  }
  return printTerminalHarness(context);
}

function printActiveSessions(sandboxName: string): void {
  try {
    const openshell = resolveOpenshell();
    if (!openshell) return;
    const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(openshell));
    if (!sessionResult.detected) return;
    const count = sessionResult.sessions.length;
    const connected = count > 0 ? `${G}yes${R} (${count} session${count > 1 ? "s" : ""})` : "no";
    console.log(`    Connected: ${connected}`);
  } catch {
    // Session detection is informational; an unavailable OpenShell client must
    // not suppress the primary sandbox and gateway health report.
  }
}

function printShieldsPosture(sandboxName: string): void {
  const posture = shields.getShieldsPosture(sandboxName, false);
  if (posture.mode === "locked") return;
  const detail =
    posture.mode === "mutable_default"
      ? posture.detail
      : `${posture.detail} (check \`shields status\` for details)`;
  console.log(`    Permissions: ${detail}`);
}

function printAgentVersion(context: SandboxStatusTextContext, sandbox: SandboxEntry): void {
  try {
    const { lookup, sandboxName, statusAgent } = context;
    const shouldProbe = shouldProbeSandboxRuntimeVersion(lookup, sandbox, statusAgent.agentRuntime);
    const versionCheck = sandboxVersion.checkAgentVersion(sandboxName, {
      forceProbe: shouldProbe,
      skipProbe: !shouldProbe,
    });
    const agentName = statusAgent.agentDisplayName;
    if (versionCheck.sandboxVersion) {
      console.log(`    Agent:    ${agentName} v${versionCheck.sandboxVersion}`);
    } else if (shouldProbe && versionCheck.expectedVersion) {
      console.log(
        `    Agent:    ${agentName} version not verified (expected v${versionCheck.expectedVersion})`,
      );
    }
    if (versionCheck.isStale && versionCheck.schemeMismatch) {
      console.log(
        `    ${YW}Update:   scheme mismatch (runtime v${versionCheck.sandboxVersion} vs expected v${versionCheck.expectedVersion})${R}`,
      );
      console.log(
        `              Run \`${CLI_NAME} ${sandboxName} rebuild\` to realign version schemes`,
      );
    } else if (versionCheck.isStale) {
      console.log(`    ${YW}Update:   v${versionCheck.expectedVersion} available${R}`);
      console.log(`              Run \`${CLI_NAME} ${sandboxName} rebuild\` to upgrade`);
    } else if (shouldProbe && versionCheck.verificationFailed && versionCheck.expectedVersion) {
      console.log(`    ${YW}Update:   unable to verify sandbox ${agentName} version${R}`);
      console.log(
        `              Run \`${CLI_NAME} ${sandboxName} rebuild\` if this sandbox predates the current install`,
      );
    }
  } catch {
    // Version metadata is advisory; omit it when probing fails so the primary
    // sandbox and gateway health report remains available.
  }
}

/** Render registry-backed sandbox details and return any non-fatal degraded outcome. */
export function printSandboxDetails(context: SandboxStatusTextContext): SandboxStatusTextOutcome {
  const { sb, currentModel, currentProvider, sandboxName } = context;
  if (!sb) return { exitCode: null };

  console.log("");
  console.log(`  Sandbox-scoped status for '${sb.name}':`);
  console.log(`  Sandbox: ${sb.name}`);
  console.log(`    Model:    ${currentModel}`);
  console.log(`    Provider: ${currentProvider}`);
  printInferenceStatus(context);
  printSandboxGpuStatus(sb);
  console.log(
    `    OpenShell: ${sb.openshellVersion || "unknown"} (${sb.openshellDriver || "unknown"})`,
  );
  console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  const exitCode = printAgentHarness(context);
  printActiveSessions(sandboxName);
  printShieldsPosture(sandboxName);
  printAgentVersion(context, sb);
  return { exitCode };
}

async function printGatewayProcessStatus(context: SandboxStatusTextContext): Promise<void> {
  const { sandboxName, statusAgent } = context;
  const running = await isSandboxGatewayRunningForStatus(sandboxName);
  if (running === null) return;
  const agentName = statusAgent.agentDisplayName;
  if (running) {
    console.log(`    ${agentName}: ${G}running${R}`);
    return;
  }
  console.log(`    ${agentName}: ${RD}not running${R}`);
  console.log("");
  console.log(`  The sandbox is alive but the ${agentName} gateway process is not running.`);
  console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
  console.log("");
  console.log("  To recover, run:");
  console.log(`    ${D}${CLI_NAME} ${sandboxName} connect${R}  (auto-recovers on connect)`);
  console.log("  Or manually inside the sandbox:");
  console.log(`    ${D}${agentRuntime.getGatewayCommand(statusAgent.agentDefinition)}${R}`);
}

/** Render the live agent process status after the gateway lookup is shown. */
export async function printAgentProcessStatus(context: SandboxStatusTextContext): Promise<void> {
  if (context.lookup.state !== "present") return;
  if (context.statusAgent.agentRuntime === "gateway") {
    await printGatewayProcessStatus(context);
    return;
  }
  if (context.statusAgent.agentRuntime === "unknown") {
    console.log(`    Agent '${context.statusAgent.agentName}' runtime: ${YW}unknown${R}`);
    return;
  }
  console.log(`    ${context.statusAgent.agentDisplayName} runtime: ${G}terminal${R}`);
}

/**
 * Render Docker's in-container health signal independently from host-side
 * delivery probes. On OpenShell-managed forwarding the Docker probe can be
 * stale even when host-side delivery is healthy, so report the mismatch
 * without overriding either signal. (#3975)
 */
export function printDockerHealth(dockerRuntime: SandboxDockerRuntime | null): void {
  if (!dockerRuntime || dockerRuntime.health === "none" || dockerRuntime.health === "unknown") {
    return;
  }
  if (dockerRuntime.health === "healthy") {
    console.log(`    Docker health: ${G}healthy${R}`);
    return;
  }
  if (dockerRuntime.health === "starting") {
    console.log(`    Docker health: ${D}starting${R}`);
    return;
  }
  console.log(`    Docker health: ${RD}unhealthy${R}`);
  console.log(
    `      ${D}This is the in-container Docker probe; compare with the host-side delivery${R}`,
  );
  console.log(`      ${D}chain above. A mismatch can be a stale signal on OpenShell-managed${R}`);
  console.log(`      ${D}runtimes — see #3975.${R}`);
}

/** Render the optional local NIM process and health signal. */
export function printNimStatus(sandboxName: string, sandbox: SandboxEntry | null): void {
  const nimStat = sandbox?.nimContainer
    ? nim.nimStatusByName(sandbox.nimContainer)
    : nim.nimStatus(sandboxName);
  if (!nim.shouldShowNimLine(sandbox?.nimContainer ?? null, nimStat.running)) return;
  console.log(
    `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
  );
  if (nimStat.running) console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
}
