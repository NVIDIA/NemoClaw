// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { captureOpenshell } from "../../adapters/openshell/runtime";
import type { AgentDefinition } from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import { runAgentSmokeCommands } from "../../agent/terminal-smoke";
import { redact } from "../../runner";

export type EnsureTerminalInferenceRoute = (
  sandboxName: string,
  options: { quiet: true },
) => { routeHealthy: boolean | null };

export function runTerminalAgentConnectProbe({
  agent,
  agentName,
  capture,
  ensureInferenceRoute,
  sandboxName,
}: {
  agent: AgentDefinition;
  agentName: string;
  capture: typeof captureOpenshell;
  ensureInferenceRoute: EnsureTerminalInferenceRoute;
  sandboxName: string;
}): void {
  const routeResult = ensureInferenceRoute(sandboxName, { quiet: true });
  // Dcode is the terminal runtime whose configured inference.local route is
  // itself part of readiness. Keep this fail-fast agent-scoped so terminal
  // runtimes without the dcode managed-proxy contract retain legacy smoke-only
  // behavior when their route result is absent or inconclusive.
  if (agent.name === "langchain-deepagents-code" && routeResult.routeHealthy === false) {
    console.error(
      `  Probe failed: ${agentName} could not reach the managed inference.local route in '${sandboxName}'.`,
    );
    process.exit(1);
  }
  const smokeResult = runAgentSmokeCommands(sandboxName, agent, capture);
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
