// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { McpBridgeError } from "./mcp-bridge-contracts";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { executeSandboxCommand } from "./process-recovery";

const DEEPAGENTS_MCP_CAPABILITY_MARKER = "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3";
const DEEPAGENTS_MCP_CAPABILITY_COMMAND =
  "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability";

export function assertDeepAgentsMcpMutationRuntimeCapability(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const result = executeSandboxCommand(sandboxName, DEEPAGENTS_MCP_CAPABILITY_COMMAND, {
    runtimeSelection,
  });
  if (result?.status !== 0 || result.stdout.trim() !== DEEPAGENTS_MCP_CAPABILITY_MARKER) {
    throw new McpBridgeError(
      `LangChain Deep Agents Code sandbox '${sandboxName}' does not contain native MCP capability v3. Rebuild the sandbox before changing authenticated MCP state.`,
    );
  }
}
