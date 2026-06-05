// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { loadAgent } from "../agent/defs";
import { getNameValidationGuidance, NAME_ALLOWED_FORMAT } from "../name-validation";
import { validateName } from "../runner";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";

// Names that collide with CLI command namespaces. A sandbox named 'status'
// makes 'nemoclaw status connect' route to the global status command
// instead of the sandbox, and a sandbox named 'sandbox' collides with the
// oclif-native `nemoclaw sandbox ...` command namespace. Reject these wherever
// a sandbox name enters the system (interactive prompt, --name flag,
// NEMOCLAW_SANDBOX_NAME).
export const RESERVED_SANDBOX_NAMES = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "update",
  "credentials",
  "help",
  "sandbox",
]);

export const UNKNOWN_SANDBOX_AGENT_NAME = "unknown";

export function normalizeSandboxAgentName(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

export function getRequestedSandboxAgentName(agent: AgentDefinition | null | undefined): string {
  return normalizeSandboxAgentName(agent?.name);
}

export function formatSandboxAgentName(agentName: string | null | undefined): string {
  const normalized = normalizeSandboxAgentName(agentName);
  if (normalized === "openclaw") return "OpenClaw";
  if (normalized === "hermes") return "Hermes";
  return normalized;
}

export function getDefaultSandboxNameForAgent(agent: AgentDefinition | null | undefined): string {
  return getRequestedSandboxAgentName(agent) === "hermes" ? "hermes" : "my-assistant";
}

export function getSandboxPromptDefault(agent: AgentDefinition | null | undefined): string {
  const envName = (process.env.NEMOCLAW_SANDBOX_NAME || "").trim().toLowerCase();
  const agentDefault = getDefaultSandboxNameForAgent(agent);
  if (!envName) return agentDefault;
  try {
    return validateName(envName, "sandbox name");
  } catch {
    return agentDefault;
  }
}

export function getEffectiveSandboxAgent(agent: AgentDefinition | null | undefined): AgentDefinition {
  return agent || loadAgent("openclaw");
}

export function getAgentInferenceProviderOptions(agent: AgentDefinition | null | undefined): string[] {
  const effectiveAgent = agent?.name ? loadAgent(agent.name) : getEffectiveSandboxAgent(agent);
  return Array.isArray(effectiveAgent.inferenceProviderOptions)
    ? effectiveAgent.inferenceProviderOptions
    : [];
}

export function getSandboxAgentRegistryFields(
  agent: AgentDefinition | null | undefined,
  agentVersionKnown = true,
): Pick<SandboxEntry, "agent" | "agentVersion"> {
  const effectiveAgent = getEffectiveSandboxAgent(agent);
  const agentName = normalizeSandboxAgentName(effectiveAgent.name);
  return {
    agent: agentName === "openclaw" ? null : agentName,
    agentVersion: agentVersionKnown ? effectiveAgent.expectedVersion || null : null,
  };
}

export function getSandboxAgentDrift(
  sandboxName: string,
  requestedAgentName: string,
): { changed: boolean; existingAgentName: string; requestedAgentName: string } {
  const existingEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
  if (!existingEntry) {
    return {
      changed: true,
      existingAgentName: UNKNOWN_SANDBOX_AGENT_NAME,
      requestedAgentName,
    };
  }
  const existingAgentName = normalizeSandboxAgentName(existingEntry?.agent);
  return {
    changed: existingAgentName !== requestedAgentName,
    existingAgentName,
    requestedAgentName,
  };
}

export interface PromptSandboxNameDeps {
  promptOrDefault(question: string, envVar: string, defaultValue: string): Promise<string>;
  cliDisplayName(): string;
  isNonInteractive(): boolean;
  exit(code: number): never;
}

export function createPromptValidatedSandboxName(deps: PromptSandboxNameDeps) {
  return async function promptValidatedSandboxName(agent: AgentDefinition | null = null) {
    const MAX_ATTEMPTS = 3;
    const defaultSandboxName = getSandboxPromptDefault(agent);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const nameAnswer = await deps.promptOrDefault(
        `  Sandbox name (${NAME_ALLOWED_FORMAT}) [${defaultSandboxName}]: `,
        "NEMOCLAW_SANDBOX_NAME",
        defaultSandboxName,
      );
      const sandboxName = (nameAnswer || defaultSandboxName).trim();

      try {
        const validatedSandboxName = validateName(sandboxName, "sandbox name");
        if (RESERVED_SANDBOX_NAMES.has(sandboxName)) {
          console.error(`  Reserved name: '${sandboxName}' is a ${deps.cliDisplayName()} CLI command.`);
          console.error("  Choose a different name to avoid routing conflicts.");
          if (deps.isNonInteractive()) {
            deps.exit(1);
          }
          if (attempt < MAX_ATTEMPTS - 1) {
            console.error("  Please try again.\n");
          }
          continue;
        }
        return validatedSandboxName;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`  ${errorMessage}`);
      }

      for (const line of getNameValidationGuidance("sandbox name", sandboxName, {
        includeAllowedFormat: false,
      })) {
        console.error(`  ${line}`);
      }

      // Non-interactive runs cannot re-prompt — abort so the caller can fix the
      // NEMOCLAW_SANDBOX_NAME env var and retry.
      if (deps.isNonInteractive()) {
        deps.exit(1);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        console.error("  Please try again.\n");
      }
    }

    console.error("  Too many invalid attempts.");
    deps.exit(1);
  };
}
