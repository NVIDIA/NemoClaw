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
) => unknown;

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
  ensureInferenceRoute(sandboxName, { quiet: true });
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
