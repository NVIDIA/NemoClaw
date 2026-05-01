// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Central agent branding — maps the active agent to CLI name, display name,
 * and product name so every user-visible string can stay agent-neutral.
 *
 * `nemohermes` is a thin alias launcher that sets `NEMOCLAW_AGENT` before
 * requiring the compiled CLI.  The exported constants cover normal startup,
 * while getAgentBranding() lets onboard refresh branding after --agent or
 * resumable session state chooses a different agent at runtime.
 */

export interface AgentBranding {
  /** Binary name shown in usage strings, e.g. "nemoclaw" or "nemohermes". */
  cli: string;
  /** Title-case display name, e.g. "NemoClaw" or "NemoHermes". */
  display: string;
  /** The agent product name shown in messages, e.g. "OpenClaw" or "Hermes". */
  product: string;
}

const DEFAULT_BRANDING: AgentBranding = {
  cli: "nemoclaw",
  display: "NemoClaw",
  product: "OpenClaw",
};

const AGENT_BRANDING: Record<string, AgentBranding> = {
  openclaw: DEFAULT_BRANDING,
  hermes: { cli: "nemohermes", display: "NemoHermes", product: "Hermes" },
};

const DEFAULT_AGENT = "openclaw";

export function getAgentBranding(
  agentName: string | null | undefined = process.env.NEMOCLAW_AGENT,
): AgentBranding {
  return AGENT_BRANDING[agentName || DEFAULT_AGENT] ?? DEFAULT_BRANDING;
}

const branding = getAgentBranding();

/** CLI binary name for usage strings — "nemoclaw" or "nemohermes". */
export const CLI_NAME: string = branding.cli;

/** Title-case display name for headers — "NemoClaw" or "NemoHermes". */
export const CLI_DISPLAY_NAME: string = branding.display;

/** Agent product name for user-facing messages — "OpenClaw" or "Hermes". */
export const AGENT_PRODUCT_NAME: string = branding.product;
