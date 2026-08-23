// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printOpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";
import { CLI_NAME } from "../../cli/branding";
import { deferSandboxLifecycleExit, isSandboxLifecycleDeferredExit } from "../../core/process-exit";
import { inspectManagedLlamaCppStatus } from "../../inference/llama-cpp/managed-status";
import { parseSandboxPhase } from "../../state/gateway";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import * as registry from "../../state/registry";
import { getSandboxDockerRuntime } from "./docker-health";
import {
  qualifyPortableAgentLifecycleAuthority,
  type HermesPortableAgentLifecycleAuthority,
} from "./gateway-state";
import { printSandboxGatewayLookupStatus } from "./status-lookup-rendering";
import {
  getSandboxStatusPreflight,
  printSandboxStatusPreflightHeader,
  withoutTerminalPhasePreflight,
} from "./status-preflight";
import {
  collectSandboxStatusSnapshot,
  getSandboxStatusReport as getLegacySandboxStatusReport,
  normalizeSandboxStatusHostMounts,
  resolveSandboxStatusAgent,
  type SandboxStatusReport,
} from "./status-snapshot";
import {
  printAgentProcessStatus,
  printDockerHealth,
  printNimStatus,
  printSandboxDetails,
  type SandboxStatusTextContext,
} from "./status-text";

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
  isInferenceHealthFailing,
  maybeGetSandboxStatusInferenceHealth,
  resolveSandboxStatusDcodeAutoApprovalMode,
  type SandboxStatusReport,
  type SandboxStatusSnapshot,
  type ServingProcessHealth,
} from "./status-snapshot";

function inspectHermesPortableStatus(
  sandboxName: string,
): HermesPortableAgentLifecycleAuthority | null {
  const authority = qualifyPortableAgentLifecycleAuthority(sandboxName, {
    readRegistry: getPublishedSandbox,
  });
  return authority.kind === "hermes" ? authority : null;
}

function getPublishedSandbox(sandboxName: string): registry.SandboxEntry | null {
  const entry = registry.getSandbox(sandboxName);
  return entry && registry.isPublishedSandboxRegistration(entry) ? entry : null;
}

function hermesPortableStatusReport(
  sandboxName: string,
  authority: HermesPortableAgentLifecycleAuthority,
): SandboxStatusReport {
  const { entry, phase } = authority;
  const model = entry?.model ?? "unknown";
  const provider = entry?.provider ?? "unknown";
  return {
    schemaVersion: 1,
    name: sandboxName,
    found: phase === "active",
    agent: "hermes",
    agentDisplayName: "Hermes",
    agentRuntime: "gateway",
    dcodeAutoApprovalMode: null,
    model,
    provider,
    servingProfileProvenance: entry?.servingProfileProvenance ?? null,
    recordedRoute:
      entry?.provider && entry.model ? { provider: entry.provider, model: entry.model } : null,
    liveRoute: null,
    routeDrift: null,
    phase: null,
    portableLifecyclePhase: phase,
    gatewayState: "not-probed",
    inferenceHealth: null,
    rpcIssue: null,
    hostGpuDetected: entry?.hostGpuDetected === true,
    sandboxGpuEnabled: entry?.sandboxGpuEnabled ?? entry?.gpuEnabled === true,
    sandboxGpuMode: entry?.sandboxGpuMode ?? null,
    sandboxGpuDevice: entry?.sandboxGpuDevice ?? null,
    sandboxGpuProof: entry?.sandboxGpuProof ?? null,
    hostMounts: normalizeSandboxStatusHostMounts(entry?.hostMounts),
    openshellDriver: entry?.openshellDriver ?? "unknown",
    openshellVersion: entry?.openshellVersion ?? "unknown",
    policies:
      entry?.policies?.filter((policy): policy is string => typeof policy === "string") ?? [],
    baselineExclusions: entry?.baselineExclusions?.map((exclusion) => exclusion.key) ?? [],
    baselineExclusionStates: [],
    baselineExclusionTransition: entry?.baselineExclusionTransition
      ? {
          operation: entry.baselineExclusionTransition.operation,
          key: entry.baselineExclusionTransition.exclusion.key,
        }
      : null,
    failureLayer: null,
    terminalRuntimeHealth: null,
    servingProcessHealth: null,
    dockerPaused: false,
  };
}

export async function getSandboxStatusReport(
  sandboxName: string,
  deps: Parameters<typeof getLegacySandboxStatusReport>[1] = {},
): Promise<SandboxStatusReport> {
  return withMcpLifecycleLock(sandboxName, async () => {
    const hermesPortable = inspectHermesPortableStatus(sandboxName);
    if (hermesPortable) return hermesPortableStatusReport(sandboxName, hermesPortable);
    return getLegacySandboxStatusReport(sandboxName, deps);
  });
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

export async function showSandboxStatus(sandboxName: string): Promise<void> {
  let deferredExitCode: number | null = null;
  try {
    await withMcpLifecycleLock(sandboxName, async () => {
      const hermesPortable = inspectHermesPortableStatus(sandboxName);
      if (hermesPortable) {
        console.log(`  Sandbox: ${sandboxName}`);
        console.log("  Agent: Hermes");
        console.log(`  Portable lifecycle phase: ${hermesPortable.phase}`);
        return;
      }
      await showLegacySandboxStatus(sandboxName);
    });
  } catch (error) {
    if (!isSandboxLifecycleDeferredExit(error)) throw error;
    deferredExitCode = error.exitCode;
  }
  if (deferredExitCode !== null) process.exit(deferredExitCode);
}

async function showLegacySandboxStatus(sandboxName: string): Promise<void> {
  const preflight = await getSandboxStatusPreflight(getPublishedSandbox(sandboxName));
  // #2666: never let an unexpected throw from the gateway probe (e.g. openshell
  // hanging when its container is stopped and the published port is held by a
  // foreign listener) suppress the sandbox header. The downstream switch
  // handles `gateway_error` by printing an actionable block + exit(1), so a
  // synthesized fallback keeps the user-visible contract intact.
  const snapshot = await collectSandboxStatusSnapshot(sandboxName, {
    preflight,
  });
  const {
    sb,
    lookup,
    rpcIssue,
    currentModel,
    currentProvider,
    routeDrift,
    inferenceHealth,
    terminalRuntimeHealth,
    servingProcessHealth,
  } = snapshot;
  // Resolve the docker-driver container once: reused for the paused-container
  // recovery hint (#4495) and the Docker health line below (#3975).
  const dockerRuntime = lookup.state === "present" ? getSandboxDockerRuntime(sandboxName) : null;
  const phase = lookup.state === "present" ? parseSandboxPhase(lookup.output || "") : null;
  const effectivePreflight = withoutTerminalPhasePreflight(
    snapshot.postRecoveryPreflight ?? preflight,
    phase,
  );
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
    deferSandboxLifecycleExit(1);
  }
  const textContext: SandboxStatusTextContext = {
    sandboxName,
    sb,
    lookup,
    currentModel,
    currentProvider,
    routeDrift,
    inferenceHealth,
    terminalRuntimeHealth,
    servingProcessHealth,
    statusAgent,
  };
  const textOutcome = printSandboxDetails(textContext);
  if (textOutcome.exitCode && (!process.exitCode || process.exitCode === 0)) {
    process.exitCode = textOutcome.exitCode;
  }

  await printSandboxGatewayLookupStatus({
    sandboxName,
    registered: sb !== null,
    lookup,
    phase,
    dockerRuntime,
    effectivePreflight,
  });

  await printAgentProcessStatus(textContext);

  printDockerHealth(dockerRuntime);
  printNimStatus(sandboxName, sb);
  const managedLlamaCpp = inspectManagedLlamaCppStatus(sandboxName, {
    ...(typeof sb?.gatewayPort === "number" ? { gatewayPort: sb.gatewayPort } : {}),
  });
  if (managedLlamaCpp) {
    console.log(`    Managed llama.cpp: ${managedLlamaCpp.state}`);
    console.log(`      Recipe: ${managedLlamaCpp.recipeId}`);
    console.log(`      Model digest: ${managedLlamaCpp.modelDigest ?? "not published"}`);
    console.log(`      Image: ${managedLlamaCpp.imageReference ?? "not published"}`);
    console.log(`      Endpoint: ${managedLlamaCpp.endpoint}`);
    console.log(`      ${managedLlamaCpp.detail}`);
    if (
      ["absent", "conflict", "unknown"].includes(managedLlamaCpp.state) &&
      (!process.exitCode || process.exitCode === 0)
    ) {
      process.exitCode = 1;
    }
  }
  console.log("");
}

export { sandboxGpuProofStatusSuffix, sandboxGpuProofUnverified } from "./status-text";
