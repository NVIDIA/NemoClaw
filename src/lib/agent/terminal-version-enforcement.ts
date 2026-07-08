// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./defs";
import {
  checkTerminalAgentVersion,
  formatTerminalAgentVersionFailure,
  type RunCaptureOpenshell,
} from "./terminal-version-drift";

interface TerminalVersionEnforcementOptions {
  beforeFailure?: () => Promise<void>;
  onFailure: (message: string) => Promise<never>;
}

/**
 * Require the manifest-declared terminal-agent version before onboarding can
 * record agent setup as complete.
 */
export async function enforceTerminalAgentVersion(
  sandboxName: string,
  agent: AgentDefinition,
  runCaptureOpenshell: RunCaptureOpenshell,
  options: TerminalVersionEnforcementOptions,
): Promise<void> {
  const result = checkTerminalAgentVersion(sandboxName, agent, runCaptureOpenshell);
  if (result.status === "current" || result.status === "not-required") return;

  await options.beforeFailure?.();
  await options.onFailure(formatTerminalAgentVersionFailure(agent, result));
}
