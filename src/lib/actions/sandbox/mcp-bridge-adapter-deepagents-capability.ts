// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import { McpBridgeError } from "./mcp-bridge-contracts";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { executeSandboxExecCommand } from "../../adapters/sandbox/command-transport";

const DEEPAGENTS_MCP_CAPABILITY_MARKER = "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3";
const DEEPAGENTS_MCP_CAPABILITY_COMMAND =
  "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability";

export async function assertDeepAgentsMcpMutationRuntimeCapability(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  let result: Awaited<ReturnType<typeof executeSandboxExecCommand>>;
  try {
    result = await executeSandboxExecCommand(
      sandboxName,
      DEEPAGENTS_MCP_CAPABILITY_COMMAND,
      undefined,
      { runtimeSelection },
    );
  } catch (error) {
    if (!(error instanceof SandboxCommandTransportError)) throw error;
    throw new McpBridgeError(
      `LangChain Deep Agents Code sandbox '${sandboxName}' native MCP capability could not be verified because the probe failed in transport.`,
    );
  }
  if (result.status !== 0 || result.stdout.trim() !== DEEPAGENTS_MCP_CAPABILITY_MARKER) {
    throw new McpBridgeError(
      `LangChain Deep Agents Code sandbox '${sandboxName}' does not contain native MCP capability v3. Rebuild the sandbox before changing authenticated MCP state.`,
    );
  }
}
