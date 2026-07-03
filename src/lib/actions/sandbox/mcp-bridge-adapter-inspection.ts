// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";

export type AdapterRegistrationInspection =
  | { state: "absent" | "registered" | "mismatch" }
  | { state: "error"; detail: string };

export type AdapterMutationOptions = {
  force?: boolean;
  bestEffort?: boolean;
  envValues?: Record<string, string>;
};

export function parseAdapterRegistrationInspection(
  result: SandboxCommandResult,
  entry: McpBridgeEntry,
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

export function inspectAdapterRegistrationCommand(
  sandboxName: string,
  entry: McpBridgeEntry,
  command: string,
): AdapterRegistrationInspection {
  const result = executeSandboxCommand(sandboxName, command);
  if (!result) return { state: "error", detail: "sandbox unreachable" };
  return parseAdapterRegistrationInspection(result, entry);
}
