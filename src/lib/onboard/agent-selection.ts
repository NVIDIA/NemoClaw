// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentChoice, AgentDefinition } from "../agent/defs";
import { getAgentChoices, loadAgent } from "../agent/defs";
import { resolveAgent } from "../agent/onboard";
import { selectFromNumberedMenuOrExit } from "./prompt-helpers";

export interface SelectOnboardAgentDeps {
  resolveAgent(options: {
    agentFlag?: string | null;
    session?: { agent?: string } | null;
  }): AgentDefinition | null;
  loadAgent(name: string): AgentDefinition;
  getAgentChoices(): AgentChoice[];
  isNonInteractive(): boolean;
  note(message: string): void;
  log(message?: string): void;
  prompt(question: string): Promise<string>;
  selectFromNumberedMenu(
    rawChoice: string,
    defaultIdx: number,
    options: AgentChoice[],
  ): AgentChoice;
}

async function promptForAgentChoice(
  deps: SelectOnboardAgentDeps,
  choices: AgentChoice[],
): Promise<AgentChoice> {
  deps.log("");
  deps.log("  Select your agent:");
  choices.forEach((choice, index) => {
    const description = choice.description ? ` — ${choice.description}` : "";
    deps.log(`    ${index + 1}) ${choice.displayName}${description}`);
  });
  deps.log("");
  // OpenClaw is sorted first (getAgentChoices), so index 1 is the default.
  const reply = await deps.prompt("  Choose [1]: ");
  return deps.selectFromNumberedMenu(reply, 1, choices);
}

export function createSelectOnboardAgent(deps: SelectOnboardAgentDeps) {
  return async function selectOnboardAgent({
    agentFlag = null,
    session = null,
    resume = false,
    canPrompt = false,
  }: {
    agentFlag?: string | null;
    session?: { agent?: string | null } | null;
    resume?: boolean;
    canPrompt?: boolean;
  } = {}): Promise<AgentDefinition | null> {
    // An explicit signal — `--agent`, NEMOCLAW_AGENT, or a resumed session —
    // pins the agent, so the interactive picker is skipped.
    const explicitlySelected =
      Boolean(agentFlag) || Boolean(process.env.NEMOCLAW_AGENT) || Boolean(session?.agent);

    // Resuming a session must honor the agent it was created with. The default
    // OpenClaw path records `session.agent` as null, so without this guard a
    // resumed OpenClaw session would re-show the picker (an asymmetry with
    // resumed Hermes sessions) and risk an accidental agent change that clears
    // agent-scoped resume state.
    // Interactive runs must let the user choose between the available agents
    // (e.g. OpenClaw and Hermes); without this the wizard silently defaulted
    // to OpenClaw and Hermes could only be reached via --agent/NEMOCLAW_AGENT.
    if (!explicitlySelected && !resume && canPrompt && !deps.isNonInteractive()) {
      const choices = deps.getAgentChoices();
      if (choices.length > 1) {
        const selected = await promptForAgentChoice(deps, choices);
        // The default OpenClaw path is represented by a null agent downstream.
        return selected.name === "openclaw" ? null : deps.loadAgent(selected.name);
      }
    }

    const agent = deps.resolveAgent({
      agentFlag,
      session: session?.agent ? { agent: session.agent } : null,
    });
    if (deps.isNonInteractive()) {
      const displayName = agent?.displayName || deps.loadAgent("openclaw").displayName;
      deps.note(`  [non-interactive] Agent: ${displayName}`);
    }
    return agent;
  };
}

export interface OnboardAgentSelectorHostDeps {
  isNonInteractive(): boolean;
  note(message: string): void;
  prompt(question: string): Promise<string>;
}

/**
 * Production wiring for the onboarding agent selector. The static dependencies
 * (the agent registry and the numbered-menu helper) live here so the
 * ~12k-line onboard entrypoint only has to supply its host-bound I/O helpers.
 */
export function createOnboardAgentSelector(host: OnboardAgentSelectorHostDeps) {
  return createSelectOnboardAgent({
    resolveAgent,
    loadAgent,
    getAgentChoices,
    isNonInteractive: host.isNonInteractive,
    note: host.note,
    log: (message?: string) => console.log(message ?? ""),
    prompt: host.prompt,
    selectFromNumberedMenu: selectFromNumberedMenuOrExit,
  });
}
