// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { AdapterMutationOptions } from "./mcp-bridge-adapter-inspection";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { executeSandboxExecCommand } from "../../adapters/sandbox/command-transport";

export async function runDeepAgentsAdapterCommand(
  sandboxName: string,
  entry: Pick<McpSourceEntry, "env">,
  command: string,
  failureMessage: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): Promise<string> {
  let result: Awaited<ReturnType<typeof executeSandboxExecCommand>>;
  try {
    result = await executeSandboxExecCommand(sandboxName, command, undefined, {
      runtimeSelection,
    });
  } catch (error) {
    if (!(error instanceof SandboxCommandTransportError) || !options.bestEffort) throw error;
    return "";
  }
  const output = redactBridgeSecretsForDisplay(
    [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (result.status !== 0) {
    if (options.bestEffort) return "";
    throw new McpBridgeError(output || failureMessage);
  }
  return result.stdout;
}
