// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const AGENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  nemoclaw: "openclaw",
  "nemo-claw": "openclaw",
  nemohermes: "hermes",
  "nemo-hermes": "hermes",
  "nemo-deepagents": "langchain-deepagents-code",
  "nemo-deepagent": "langchain-deepagents-code",
  nemodeepagents: "langchain-deepagents-code",
  nemodeepagent: "langchain-deepagents-code",
  dcode: "langchain-deepagents-code",
  deepagent: "langchain-deepagents-code",
  deepagents: "langchain-deepagents-code",
  "deep-agent": "langchain-deepagents-code",
  "deep-agents": "langchain-deepagents-code",
  deepagentcode: "langchain-deepagents-code",
  deepagentscode: "langchain-deepagents-code",
  "deepagent-code": "langchain-deepagents-code",
  "deepagents-code": "langchain-deepagents-code",
  "deep-agent-code": "langchain-deepagents-code",
  "deep-agents-code": "langchain-deepagents-code",
  langchain: "langchain-deepagents-code",
  "langchain-code": "langchain-deepagents-code",
  langchaindeepagent: "langchain-deepagents-code",
  langchaindeepagents: "langchain-deepagents-code",
  "langchain-deepagent": "langchain-deepagents-code",
  "langchain-deepagents": "langchain-deepagents-code",
  langchaindeepagentcode: "langchain-deepagents-code",
  langchaindeepagentscode: "langchain-deepagents-code",
  "langchain-deepagent-code": "langchain-deepagents-code",
  "langchain-deepagents-code": "langchain-deepagents-code",
  "langchain-deep-agent": "langchain-deepagents-code",
  "langchain-deep-agents": "langchain-deepagents-code",
  "langchain-deep-agent-code": "langchain-deepagents-code",
  "langchain-deep-agents-code": "langchain-deepagents-code",
});

export function normalizeAgentSelector(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

export function resolveAgentNameAlias(
  value: string | null | undefined,
  availableAgents: readonly string[],
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;

  if (availableAgents.includes(trimmed)) return trimmed;

  const normalized = normalizeAgentSelector(trimmed);
  const exactNormalized = availableAgents.find(
    (agentName) => normalizeAgentSelector(agentName) === normalized,
  );
  if (exactNormalized) return exactNormalized;

  const aliasTarget = AGENT_ALIASES[normalized];
  return aliasTarget && availableAgents.includes(aliasTarget) ? aliasTarget : null;
}

export function agentAliasSummary(availableAgents: readonly string[]): string {
  const aliases: string[] = [];
  if (availableAgents.includes("hermes")) aliases.push("nemohermes → hermes");
  if (availableAgents.includes("langchain-deepagents-code")) {
    aliases.push(
      "nemo-deepagents/dcode/deepagents/deepagents-code/langchain → langchain-deepagents-code",
    );
  }
  return aliases.join("; ");
}

export function formatAgentAliasSuffix(availableAgents: readonly string[]): string {
  const summary = agentAliasSummary(availableAgents);
  return summary ? ` (aliases: ${summary})` : "";
}
