// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

export type McpAdapter = "mcporter" | "hermes-config" | "deepagents-config";

export const MCP_MUTATION_TIMEOUT_MS: Record<McpAdapter, number> = {
  "deepagents-config": 3 * 60_000,
  "hermes-config": 12 * 60_000,
  mcporter: 3 * 60_000,
};

const MCP_BRIDGE_ALREADY_ABSENT =
  /No MCP servers are registered|No MCP server '.+' is registered|MCP server '.+' not found/iu;

export async function cleanupMcpBridge(
  host: HostCliClient,
  sandboxName: string,
  server: string,
  adapter: McpAdapter,
): Promise<void> {
  const result = await host.nemoclaw([sandboxName, "mcp", "remove", server, "--force"], {
    artifactName: `cleanup-mcp-remove-${server}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[adapter],
  });
  assertCleanupSucceededOrAbsent(
    result,
    MCP_BRIDGE_ALREADY_ABSENT,
    `cleanup MCP bridge ${server} on sandbox ${sandboxName}`,
  );
}

const MCP_MUTATION_CONCURRENCY_CONFLICT =
  /sandbox was modified by another operation\.[\s\S]*Please retry the command\./iu;

export function shouldRetryMcpMutationAfterConcurrencyConflict(output: string): boolean {
  return MCP_MUTATION_CONCURRENCY_CONFLICT.test(output);
}

export async function removeMcpBridgeWithOneConcurrencyRetry(
  host: HostCliClient,
  sandboxName: string,
  server: string,
  adapter: McpAdapter,
  artifactPrefix: string,
): Promise<Awaited<ReturnType<HostCliClient["nemoclaw"]>>> {
  const remove = await host.nemoclaw([sandboxName, "mcp", "remove", server], {
    artifactName: `${artifactPrefix}-mcp-remove-${server}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[adapter],
  });
  if (
    remove.exitCode === 0 ||
    !shouldRetryMcpMutationAfterConcurrencyConflict(resultText(remove))
  ) {
    return remove;
  }
  return host.nemoclaw([sandboxName, "mcp", "remove", server], {
    artifactName: `${artifactPrefix}-mcp-remove-${server}-retry`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[adapter],
  });
}
