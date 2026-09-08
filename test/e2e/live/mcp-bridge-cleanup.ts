// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

export type McpAdapter = "mcporter" | "hermes-config" | "deepagents-config";

export const MCP_MUTATION_TIMEOUT_MS: Record<McpAdapter, number> = {
  "deepagents-config": 3 * 60_000,
  "hermes-config": 12 * 60_000,
  mcporter: 3 * 60_000,
};

const MCP_BRIDGE_ALREADY_ABSENT =
  /No MCP servers are registered|No MCP server '.+' is registered|MCP server '.+' not found/iu;

function buildOwnedSandboxCleanupEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    // Bind trusted administrator cleanup to the gateway NemoClaw initialized.
    // ShellProbe otherwise forwards only PATH, which hides gateway metadata.
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
  };
}

/** Prepare a sandbox name exclusively owned by this isolated qualification job. */
export async function prepareOwnedSandboxForOnboard(
  host: Pick<HostCliClient, "bestEffortCleanupSandbox" | "cleanupSandbox">,
  sandbox: Pick<SandboxClient, "cleanupSandbox">,
  cleanup: CleanupRegistry,
  sandboxName: string,
): Promise<void> {
  const openshellCleanupEnv = buildOwnedSandboxCleanupEnv();
  cleanup.trackSandbox(host, sandboxName, {
    artifactName: "cleanup-destroy-sandbox",
    timeoutMs: 15 * 60_000,
  });
  // A failed onboard may leave a live sandbox that the production CLI safely
  // refuses to delete by mutable name. Register the trusted administrator
  // deletion last so LIFO cleanup removes OpenShell state before `destroy`
  // reconciles the durable recovery record and identity-verified containers.
  cleanup.trackDisposable(`delete owned OpenShell sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandbox(sandboxName, {
      artifactName: "cleanup-delete-openshell-sandbox",
      env: openshellCleanupEnv,
      timeoutMs: 15 * 60_000,
    }),
  );
  // A fresh qualification runner has no active OpenShell gateway yet. Let the
  // production CLI initialize it and perform any cleanup it can prove safe.
  // Retained-state refusal remains non-fatal here because the identity-bound
  // administrator deletion below is the isolated E2E fallback.
  await host.bestEffortCleanupSandbox(sandboxName, {
    artifactName: "precleanup-initialize-gateway",
    timeoutMs: 15 * 60_000,
  });
  await sandbox.cleanupSandbox(sandboxName, {
    artifactName: "precleanup-delete-openshell-sandbox",
    env: openshellCleanupEnv,
    timeoutMs: 15 * 60_000,
  });
  await host.cleanupSandbox(sandboxName, {
    artifactName: "precleanup-destroy-sandbox",
    timeoutMs: 15 * 60_000,
  });
}

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
