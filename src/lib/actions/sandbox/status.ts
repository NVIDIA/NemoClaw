// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printOpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";
import { CLI_NAME } from "../../cli/branding";
import { parseSandboxPhase } from "../../state/gateway";
import * as registry from "../../state/registry";
import { getSandboxDockerRuntime } from "./docker-health";
import { printSandboxGatewayLookupStatus } from "./status-lookup-rendering";
import {
  getSandboxStatusPreflight,
  printSandboxStatusPreflightHeader,
  withoutTerminalPhasePreflight,
} from "./status-preflight";
import { collectSandboxStatusSnapshot, resolveSandboxStatusAgent } from "./status-snapshot";
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
  getSandboxStatusReport,
  isInferenceHealthFailing,
  maybeGetSandboxStatusInferenceHealth,
  resolveSandboxStatusDcodeAutoApprovalMode,
  type SandboxStatusReport,
  type SandboxStatusSnapshot,
} from "./status-snapshot";

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
    routeDrift,
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
  const textContext: SandboxStatusTextContext = {
    sandboxName,
    sb,
    lookup,
    currentModel,
    currentProvider,
    routeDrift,
    inferenceHealth,
    terminalRuntimeHealth,
    statusAgent,
  };
  const textOutcome = printSandboxDetails(textContext);
  if (textOutcome.exitCode && (!process.exitCode || process.exitCode === 0)) {
    process.exitCode = textOutcome.exitCode;
  }

  await printSandboxGatewayLookupStatus({
    sandboxName,
    lookup,
    phase,
    dockerRuntime,
    effectivePreflight,
  });

  await printAgentProcessStatus(textContext);

  printDockerHealth(dockerRuntime);
  printNimStatus(sandboxName, sb);
  console.log("");
}

export { sandboxGpuProofStatusSuffix, sandboxGpuProofUnverified } from "./status-text";
