// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway recovery/restart shell generation. Kept separate from runtime.ts so
// agent lookup and display metadata do not grow around security-sensitive
// process-control scripts.

import { type AgentDefinition, isTerminalAgent } from "./defs";

export function getTerminalCommand(
  agent: AgentDefinition | null,
  mode: "interactive" | "headless" = "interactive",
): string | null {
  if (!agent || !isTerminalAgent(agent)) return null;
  if (mode === "headless") return agent.runtime?.headless_command ?? null;
  return agent.runtime?.interactive_command ?? agent.runtime?.headless_command ?? null;
}

/**
 * Resolve the command a user types inside the sandbox to start the agent
 * interactively. Unlike getTerminalCommand, this reads
 * runtime.interactive_command for every agent kind: gateway agents such as
 * OpenClaw and Hermes also have an interactive entry point, they just do not
 * own their process lifecycle through it. OpenClaw keeps its historical
 * fallback when no manifest is loaded. Every other command comes from a
 * trusted agent definition so a sandbox registry value cannot become shell
 * source.
 */
export function getInteractiveAgentCommand(
  agent: AgentDefinition | null,
  agentName: string | null | undefined,
): string {
  // Mirror getTerminalCommand's interactive fallback: runtime-manifest.ts
  // permits a terminal agent that declares only headless_command, and without
  // this `launch` would execute the agent's own slug and fail with exit 127.
  const manifestCommand =
    agent?.runtime?.interactive_command?.trim() || agent?.runtime?.headless_command?.trim();
  if (manifestCommand) return manifestCommand;
  const name = agentName || "openclaw";
  if (name === "openclaw") return "openclaw tui";
  if (agent?.name) return agent.name;
  throw new Error(
    `Cannot resolve an interactive command for unsupported agent ${JSON.stringify(name)}.`,
  );
}
