// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";

export interface SelectOnboardAgentDeps {
  resolveAgent(options: {
    agentFlag?: string | null;
    session?: { agent?: string | null } | null;
  }): AgentDefinition | null;
  loadAgent(name: string): AgentDefinition;
  isNonInteractive(): boolean;
  note(message: string): void;
}

export function createSelectOnboardAgent(deps: SelectOnboardAgentDeps) {
  return async function selectOnboardAgent({
    agentFlag = null,
    session = null,
  }: {
    agentFlag?: string | null;
    session?: { agent?: string | null } | null;
    resume?: boolean;
    canPrompt?: boolean;
  } = {}): Promise<AgentDefinition | null> {
    const agent = deps.resolveAgent({ agentFlag, session });
    if (deps.isNonInteractive()) {
      const displayName = agent?.displayName || deps.loadAgent("openclaw").displayName;
      deps.note(`  [non-interactive] Agent: ${displayName}`);
    }
    return agent;
  };
}
