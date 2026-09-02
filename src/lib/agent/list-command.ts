// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentChoice,
  type AgentDefinition,
  getAgentChoices,
  listAgents,
  loadAgent,
} from "./defs";

export type AgentRuntimeListEntry = Pick<AgentChoice, "name" | "description">;

/** Resolve an exact selectable agent, including OpenClaw, from the trusted manifest inventory. */
export function resolveSelectableAgentDefinition(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentDefinition | null {
  try {
    if (!listAgents(env).includes(name)) return null;
    return loadAgent(name, env);
  } catch {
    return null;
  }
}

export function listAgentRuntimeEntries(): AgentRuntimeListEntry[] {
  return getAgentChoices().map(({ name, description }) => ({ name, description }));
}

export function renderAgentRuntimeList(
  entries: readonly AgentRuntimeListEntry[] = listAgentRuntimeEntries(),
): string {
  if (entries.length === 0) return "No agent runtimes are installed.";

  const nameWidth = Math.max(...entries.map((entry) => entry.name.length));
  return entries
    .map((entry) => {
      if (!entry.description) return entry.name;
      return `${entry.name.padEnd(nameWidth + 2)}${entry.description}`;
    })
    .join("\n");
}

export function printAgentRuntimeList(log: (message: string) => void): void {
  log(renderAgentRuntimeList());
}
