// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { runAgentSmokeCommands } from "../../agent/terminal-smoke";
import { redact } from "../../runner";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationInput,
} from "./inference-invocation-probe";

export async function verifyDcodeConnectInference(
  input: Omit<SandboxInferenceInvocationInput, "agentName">,
  commandExecutor: OpenShellSandboxBufferedCommandExecutor,
): Promise<boolean> {
  const result = await probeSandboxInferenceInvocation(
    { ...input, agentName: "langchain-deepagents-code" },
    { commandExecutor },
    READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  );
  if (!result.ok) {
    console.error(`  Connect failed: Deep Agents Code inference request failed: ${result.detail}.`);
  }
  return result.ok;
}

export type EnsureTerminalInferenceRoute = (
  sandboxName: string,
  options: { quiet: true },
) => { routeHealthy: boolean | null };

export async function runTerminalAgentConnectProbe({
  agent,
  agentName,
  commandExecutor,
  ensureInferenceRoute,
  sandboxName,
}: {
  agent: AgentDefinition;
  agentName: string;
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
  ensureInferenceRoute: EnsureTerminalInferenceRoute;
  sandboxName: string;
}): Promise<void> {
  const routeResult = ensureInferenceRoute(sandboxName, { quiet: true });
  // DCode requires verified managed inference; a version smoke cannot prove it.
  if (agent.name === "langchain-deepagents-code" && routeResult.routeHealthy !== true) {
    console.error(
      `  Probe failed: ${agentName} could not reach the managed inference.local route in '${sandboxName}'.`,
    );
    process.exit(1);
  }
  const smokeResult = await runAgentSmokeCommands(sandboxName, agent, commandExecutor);
  if (!smokeResult.ok) {
    console.error(
      `  Probe failed: ${agentName} terminal smoke command failed: ${smokeResult.command}`,
    );
    if (smokeResult.output) {
      console.error(`    ${String(redact(smokeResult.output)).slice(0, 500)}`);
    }
    process.exit(1);
  }
  const command = agentRuntime.getTerminalCommand(agent);
  const commandText = command ? ` (${command})` : "";
  console.log(`  Probe complete: ${agentName} terminal smoke checks passed${commandText}.`);
}
