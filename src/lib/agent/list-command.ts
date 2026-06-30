// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type AgentChoice, getAgentChoices } from "./defs";

export type AgentRuntimeListEntry = Pick<AgentChoice, "name" | "description">;

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

export function printAgentRuntimeList(log: (message: string) => void = console.log): void {
  log(renderAgentRuntimeList());
}
