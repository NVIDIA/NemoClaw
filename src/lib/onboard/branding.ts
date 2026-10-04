// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getAgentBranding, type AgentBranding } from "../cli/branding";

let onboardBrandingAgent: string | null = null;

export function setOnboardBrandingAgent(agentName: string | null | undefined): void {
  onboardBrandingAgent = agentName || null;
}

export function onboardBranding(): AgentBranding {
  return getAgentBranding(onboardBrandingAgent || process.env.NEMOCLAW_AGENT || null);
}

export function cliName(): string {
  return onboardBranding().cli;
}

export function cliDisplayName(): string {
  return onboardBranding().display;
}

export function agentProductName(): string {
  return onboardBranding().product;
}
