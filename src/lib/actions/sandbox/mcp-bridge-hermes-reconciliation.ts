// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import { redactFull } from "../../security/redact";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import { buildHermesMcpIntentPayload } from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";

const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";
const HERMES_MCP_INSPECT_TIMEOUT_SECONDS = 45;
const HERMES_MCP_INSPECT_TIMEOUT_MS = 60_000;
const HERMES_MCP_RECONCILIATION_FAILURE =
  "Hermes MCP runtime does not match the persisted managed intent";
const ANSI_OR_UNSAFE_CONTROL_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const DISPLAY_LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g;

export type HermesMcpReconciliationResult =
  | { ok: true; state: "matched" | "not-applicable" }
  | { ok: false; state: "mismatch" | "error"; detail: string };

export interface HermesMcpReconciliationOptions {
  entries?: readonly McpBridgeEntry[];
  managedServerNames?: readonly string[];
}

export function hermesMcpReconciliationRemediationLines(sandboxName: string): readonly string[] {
  return [
    `Run \`nemoclaw ${sandboxName} mcp restart\` to restore the managed MCP configuration, then retry.`,
    `If the sandbox has an old helper or missing runtime metadata, run \`nemoclaw ${sandboxName} rebuild --yes\` instead.`,
  ];
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

export function sanitizeHermesMcpReconciliationDetail(
  detail: string,
  entries: readonly McpBridgeEntry[] = [],
): string {
  // Reconciliation detail crosses from an untrusted sandbox helper into host
  // exceptions and terminal output. Remove terminal controls before matching
  // secrets so escape bytes cannot split a token and evade redaction.
  let sanitized = String(detail || "").replace(ANSI_OR_UNSAFE_CONTROL_RE, "");
  for (const entry of entries) {
    const envValues = Object.fromEntries(
      entry.env.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    );
    sanitized = redactBridgeSecretsForDisplay(sanitized, entry, envValues);
  }
  return (
    redactFull(sanitized).replace(DISPLAY_LINE_BREAK_RE, " ").replace(/\s+/g, " ").trim() ||
    HERMES_MCP_RECONCILIATION_FAILURE
  );
}

function commandStream(value: string | Buffer | null | undefined): string {
  return typeof value === "string" ? value : (value?.toString() ?? "");
}

function sanitizedCommandDetail(
  result: ReturnType<typeof runOpenshellProviderCommand>,
  entries: readonly McpBridgeEntry[],
): string {
  return sanitizeHermesMcpReconciliationDetail(
    [commandStream(result.stderr), commandStream(result.stdout), result.error?.message]
      .filter(Boolean)
      .join("\n"),
    entries,
  );
}

export function inspectHermesMcpRuntimeIntent(
  sandboxName: string,
  options: HermesMcpReconciliationOptions = {},
): HermesMcpReconciliationResult {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    return {
      ok: false,
      state: "error",
      detail: sanitizeHermesMcpReconciliationDetail(`Sandbox '${sandboxName}' not found.`),
    };
  }
  if (sandbox.name !== sandboxName) {
    return {
      ok: false,
      state: "error",
      detail: sanitizeHermesMcpReconciliationDetail(
        `Registry entry name mismatch for sandbox '${sandboxName}'.`,
      ),
    };
  }
  const entries = options.entries ? [...options.entries] : bridgeEntries(sandbox);
  const managedServerNames = options.managedServerNames
    ? [...options.managedServerNames]
    : [...(sandbox.mcp?.managedServerNames ?? entries.map((entry) => entry.server))];
  if (!appliesToHermes(sandbox, entries) || (!sandbox.mcp && options.entries === undefined)) {
    return { ok: true, state: "not-applicable" };
  }
  if (sandbox.agent != null && sandbox.agent !== "hermes") {
    return {
      ok: false,
      state: "error",
      detail: sanitizeHermesMcpReconciliationDetail(
        `Registry entry agent mismatch for Hermes MCP sandbox '${sandboxName}'.`,
        entries,
      ),
    };
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
      detail: sanitizeHermesMcpReconciliationDetail(
        error instanceof Error ? error.message : String(error),
        entries,
      ),
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
    detail: sanitizedCommandDetail(result, entries),
  };
}

export function assertHermesMcpRuntimeIntent(
  sandboxName: string,
  options: HermesMcpReconciliationOptions = {},
): void {
  const inspection = inspectHermesMcpRuntimeIntent(sandboxName, options);
  if (inspection.ok) return;
  throw new McpBridgeError(
    `${sanitizeHermesMcpReconciliationDetail(
      `${HERMES_MCP_RECONCILIATION_FAILURE} for sandbox '${sandboxName}': ${inspection.detail}`,
      options.entries,
    )}.`,
  );
}
