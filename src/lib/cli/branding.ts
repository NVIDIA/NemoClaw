// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Central agent branding — maps the active agent to CLI name, display name,
 * product name, and product-specific copy so every user-visible string can stay
 * agent-neutral.
 *
 * Agent-specific launchers such as `nemohermes` and `nemo-deepagents` set
 * `NEMOCLAW_AGENT` and `NEMOCLAW_INVOKED_AS` before requiring the compiled CLI.
 * The agent env var drives product/display branding; the invocation env var
 * drives the CLI name we suggest back to the user — so a user who launched via
 * `nemoclaw` keeps seeing `nemoclaw` in next-steps output even when an
 * alternate agent is selected.
 *
 * The exported constants cover normal startup, while getAgentBranding() lets
 * onboard refresh branding after --agent or resumable session state chooses a
 * different agent at runtime.
 */

import { resolveAgentNameAlias } from "../agent/aliases";

const BRANDING_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

export interface AgentBranding {
  /**
   * Binary name shown in usage strings, e.g. "nemoclaw", "nemohermes", or "nemo-deepagents".
   * Resolved from NEMOCLAW_INVOKED_AS (the launcher binary), not the agent,
   * so output matches whatever the user actually typed.
   */
  cli: string;
  /** Title-case display name, e.g. "NemoClaw", "NemoHermes", or "NemoDeepAgents". */
  display: string;
  /** The agent product name shown in messages, e.g. "OpenClaw", "Hermes", or "LangChain Deep Agents Code". */
  product: string;
  /** Final line shown when uninstall completes. */
  uninstallGoodbye: string;
}

interface ProductBranding {
  display: string;
  product: string;
  uninstallGoodbye: string;
}

const DEFAULT_PRODUCT_BRANDING: ProductBranding = {
  display: "NemoClaw",
  product: "OpenClaw",
  uninstallGoodbye: "Claws retracted. Until next time.",
};

const AGENT_PRODUCT_BRANDING: Record<string, ProductBranding> = {
  openclaw: DEFAULT_PRODUCT_BRANDING,
  hermes: {
    display: "NemoHermes",
    product: "Hermes",
    uninstallGoodbye: "Hermes has left the tidepool.",
  },
  "langchain-deepagents-code": {
    display: "NemoDeepAgents",
    product: "LangChain Deep Agents Code",
    uninstallGoodbye: "Deep Agents stood down. Until next time.",
  },
};

const DEFAULT_AGENT = "openclaw";
const DEFAULT_CLI_NAME = "nemoclaw";
const KNOWN_CLI_NAMES = new Set(["nemoclaw", "nemohermes", "nemo-deepagents"]);

function resolveInvokedCliName(): string {
  const raw = process.env.NEMOCLAW_INVOKED_AS;
  if (raw && KNOWN_CLI_NAMES.has(raw)) {
    return raw;
  }
  return DEFAULT_CLI_NAME;
}

export function getAgentBranding(
  agentName: string | null | undefined = process.env.NEMOCLAW_AGENT,
): AgentBranding {
  const canonicalAgent = resolveAgentNameAlias(agentName, BRANDING_AGENTS) ?? agentName;
  const product =
    AGENT_PRODUCT_BRANDING[canonicalAgent || DEFAULT_AGENT] ?? DEFAULT_PRODUCT_BRANDING;
  return {
    cli: resolveInvokedCliName(),
    ...product,
  };
}

const branding = getAgentBranding();

/** CLI binary name for usage strings — e.g. "nemoclaw", "nemohermes", or "nemo-deepagents". */
export const CLI_NAME: string = branding.cli;

/** Title-case display name for headers — e.g. "NemoClaw", "NemoHermes", or "NemoDeepAgents". */
export const CLI_DISPLAY_NAME: string = branding.display;

/** Agent product name for user-facing messages — e.g. "OpenClaw", "Hermes", or "LangChain Deep Agents Code". */
export const AGENT_PRODUCT_NAME: string = branding.product;
