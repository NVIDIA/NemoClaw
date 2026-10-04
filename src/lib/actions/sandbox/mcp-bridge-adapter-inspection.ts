// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { restartSandboxGateway } from "./process-recovery";
import {
  executeSandboxExecCommand,
  type SandboxCommandResult,
} from "../../adapters/sandbox/command-transport";

export type AdapterRegistrationInspection =
  | { state: "absent" | "registered" | "mismatch" }
  | { state: "error"; detail: string };

export type AdapterMutationOptions = {
  force?: boolean;
  bestEffort?: boolean;
  envValues?: Record<string, string>;
  teardown?: boolean;
};

export type AdapterRemovalOutcome = "removed" | "absent" | "unowned";

export function parseAdapterRegistrationInspection(
  result: SandboxCommandResult,
  entry: McpSourceEntry,
): AdapterRegistrationInspection {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    return {
      state: "error",
      detail:
        redactBridgeSecretsForDisplay(output, entry) ||
        `MCP adapter inspection exited ${result.status}.`,
    };
  }
  // Successful inspection commands write exactly one ownership state to
  // stdout. Runtime warnings belong on stderr and must not replace that state.
  const state = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (state === "absent" || state === "registered" || state === "mismatch") {
    return { state };
  }
  return {
    state: "error",
    detail: redactBridgeSecretsForDisplay(
      output || "MCP adapter inspection returned no state.",
      entry,
    ),
  };
}

export async function inspectAdapterRegistrationCommand(
  sandboxName: string,
  entry: McpSourceEntry,
  command: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  timeoutMs?: number,
): Promise<AdapterRegistrationInspection> {
  try {
    const result = await executeSandboxExecCommand(sandboxName, command, timeoutMs, {
      runtimeSelection,
    });
    return parseAdapterRegistrationInspection(result, entry);
  } catch (error) {
    if (!(error instanceof SandboxCommandTransportError)) throw error;
    return { state: "error", detail: error.message };
  }
}

export async function restartMcpGatewayThroughSupervisor(sandboxName: string) {
  return restartSandboxGateway(sandboxName, { quiet: true });
}
