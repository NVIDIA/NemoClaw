// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "./defs";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import {
  checkTerminalAgentVersion,
  formatTerminalAgentVersionFailure,
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
  executor: OpenShellSandboxBufferedCommandExecutor,
  options: TerminalVersionEnforcementOptions,
): Promise<void> {
  const result = await checkTerminalAgentVersion(sandboxName, agent, executor);
  if (result.status === "current" || result.status === "not-required") return;

  await options.beforeFailure?.();
  await options.onFailure(formatTerminalAgentVersionFailure(agent, result));
}
