// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { buildHermesMcpIntentPayload } from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";

const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";
const HERMES_MCP_INSPECT_TIMEOUT_SECONDS = 45;
const HERMES_MCP_INSPECT_TIMEOUT_MS = 60_000;
const HERMES_MCP_RECONCILIATION_FAILURE =
  "Hermes MCP runtime does not match the persisted managed intent";

export type HermesMcpReconciliationResult =
  | { ok: true; state: "matched" | "not-applicable" }
  | { ok: false; state: "mismatch" | "error"; detail: string };

export interface HermesMcpReconciliationOptions {
  entries?: readonly McpBridgeEntry[];
  managedServerNames?: readonly string[];
}

function bridgeEntries(sandbox: SandboxEntry): McpBridgeEntry[] {
  return Object.values(sandbox.mcp?.bridges ?? {});
}

function appliesToHermes(sandbox: SandboxEntry, entries: readonly McpBridgeEntry[]): boolean {
  return sandbox.agent === "hermes" || entries.some((entry) => entry.adapter === "hermes-config");
}

function buildInspectArgs(sandboxName: string, payload: string): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    "--timeout",
    String(HERMES_MCP_INSPECT_TIMEOUT_SECONDS),
    "--no-tty",
    "--",
    HERMES_MCP_TRANSACTION_HELPER,
    "inspect",
    "--payload",
    payload,
  ];
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // OpenShell can frame diagnostics around the helper's single JSON line.
    }
  }
  return null;
}

function redactedDetail(
  result: ReturnType<typeof runOpenshellProviderCommand>,
  entries: readonly McpBridgeEntry[],
): string {
  let detail = commandOutput(result).trim();
  for (const entry of entries) {
    const envValues = Object.fromEntries(
      entry.env.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    );
    detail = redactBridgeSecretsForDisplay(detail, entry, envValues);
  }
  return detail || HERMES_MCP_RECONCILIATION_FAILURE;
}

export function inspectHermesMcpRuntimeIntent(
  sandboxName: string,
  options: HermesMcpReconciliationOptions = {},
): HermesMcpReconciliationResult {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    return { ok: false, state: "error", detail: `Sandbox '${sandboxName}' not found.` };
  }
  const entries = options.entries ? [...options.entries] : bridgeEntries(sandbox);
  const managedServerNames = options.managedServerNames
    ? [...options.managedServerNames]
    : [...(sandbox.mcp?.managedServerNames ?? entries.map((entry) => entry.server))];
  if (!appliesToHermes(sandbox, entries) || (!sandbox.mcp && options.entries === undefined)) {
    return { ok: true, state: "not-applicable" };
  }

  const payload = buildHermesMcpIntentPayload(entries, managedServerNames);
  let result: ReturnType<typeof runOpenshellProviderCommand>;
  try {
    result = runOpenshellProviderCommand(buildInspectArgs(sandboxName, JSON.stringify(payload)), {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HERMES_MCP_INSPECT_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      state: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const response = parseLastJsonObject(result.stdout || "");
  if (
    result.status === 0 &&
    !result.error &&
    response?.ok === true &&
    response.state === "matched"
  ) {
    return { ok: true, state: "matched" };
  }
  return {
    ok: false,
    state: result.status === 2 ? "mismatch" : "error",
    detail: redactedDetail(result, entries),
  };
}

export function assertHermesMcpRuntimeIntent(
  sandboxName: string,
  options: HermesMcpReconciliationOptions = {},
): void {
  const inspection = inspectHermesMcpRuntimeIntent(sandboxName, options);
  if (inspection.ok) return;
  throw new McpBridgeError(
    `${HERMES_MCP_RECONCILIATION_FAILURE} for sandbox '${sandboxName}': ${inspection.detail}.`,
  );
}
