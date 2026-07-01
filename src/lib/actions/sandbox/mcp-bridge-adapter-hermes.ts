// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import { waitUntil } from "../../core/wait";
import { isShieldsDown } from "../../shields";
import type { McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import { buildHermesMcpStatusCommand, entryHeaders } from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";

const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";
const HERMES_MCP_EXEC_TIMEOUT_SECONDS = 620;
const HERMES_MCP_PROBE_TIMEOUT_SECONDS = 30;
const HERMES_MCP_STARTUP_TIMEOUT_SECONDS = 90;
const HERMES_MCP_GATEWAY_NOT_READY = "Hermes gateway is not running for managed MCP reload";
const HERMES_MCP_LIFECYCLE_NOT_READY =
  "Hermes gateway is not running under the managed service lifecycle";

export function buildHermesMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
): string[] {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    replace_existing: replaceExisting,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "add", "--payload", JSON.stringify(payload)];
}

function buildHermesMcpRemoveCommand(entry: McpBridgeEntry, force = false): string[] {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
  };
  return [HERMES_MCP_TRANSACTION_HELPER, "remove", "--payload", JSON.stringify(payload)];
}

export function buildHermesMcpExecArgs(
  sandboxName: string,
  command: readonly string[],
  timeoutSeconds = HERMES_MCP_EXEC_TIMEOUT_SECONDS,
): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    sandboxName,
    "--timeout",
    String(timeoutSeconds),
    "--no-tty",
    "--",
    ...command,
  ];
}

export function buildHermesMcpProbeCommand(): string[] {
  return [HERMES_MCP_TRANSACTION_HELPER, "probe"];
}

export function inspectHermesAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(sandboxName, entry, buildHermesMcpStatusCommand(entry));
}

function parseLastJsonObject(output: string): Record<string, unknown> | null {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // OpenShell may frame diagnostics around the command's JSON line.
    }
  }
  return null;
}

/** Refuse an in-sandbox Hermes config mutation while config is locked. */
export function assertHermesMcpConfigMutationAllowed(sandboxName: string): void {
  if (isShieldsDown(sandboxName, false)) return;
  throw new McpBridgeError(
    `Hermes sandbox '${sandboxName}' has shields up or an unreadable shields posture. Run \`nemohermes ${sandboxName} shields down --timeout 15m --reason "MCP maintenance"\` before changing MCP configuration.`,
  );
}

/**
 * Prove the running Hermes sandbox contains the packaged transaction helper
 * and can invoke it through OpenShell current main's ordinary exec path before
 * changing a global provider, policy, attachment, or adapter.
 */
export function assertHermesMcpMutationRuntimeCapability(sandboxName: string): void {
  assertHermesMcpConfigMutationAllowed(sandboxName);
  let lastDetail = "";
  const ready = waitUntil(
    () => {
      let result: ReturnType<typeof runOpenshellProviderCommand>;
      try {
        result = runOpenshellProviderCommand(
          buildHermesMcpExecArgs(
            sandboxName,
            buildHermesMcpProbeCommand(),
            HERMES_MCP_PROBE_TIMEOUT_SECONDS,
          ),
          {
            ignoreError: true,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 45_000,
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new McpBridgeError(
          `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper. Rebuild the sandbox before changing authenticated MCP state${detail ? `: ${detail}` : "."}`,
        );
      }
      const response = parseLastJsonObject(result.stdout || "");
      if (result.status === 0 && !result.error && response?.ok === true) return true;
      lastDetail = commandOutput(result).trim();
      if (lastDetail === HERMES_MCP_GATEWAY_NOT_READY) return false;
      if (lastDetail === HERMES_MCP_LIFECYCLE_NOT_READY) {
        throw new McpBridgeError(
          `Hermes sandbox '${sandboxName}' is not running the managed service lifecycle required for authenticated MCP changes. Run \`nemoclaw ${sandboxName} recover\` and retry.`,
        );
      }
      throw new McpBridgeError(
        `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper. Rebuild the sandbox before changing authenticated MCP state${lastDetail ? `: ${lastDetail}` : "."}`,
      );
    },
    HERMES_MCP_STARTUP_TIMEOUT_SECONDS,
    1_000,
  );
  if (!ready) {
    throw new McpBridgeError(
      `Hermes sandbox '${sandboxName}' cannot invoke the managed MCP transaction helper after waiting for startup. Run \`nemoclaw ${sandboxName} recover\` and retry, or rebuild the sandbox before changing authenticated MCP state${lastDetail ? `: ${lastDetail}` : "."}`,
    );
  }
}

function runHermesAdapterCommand(
  sandboxName: string,
  entry: McpBridgeEntry,
  command: readonly string[],
  failureMessage: string,
  options: AdapterMutationOptions & { requireReload?: boolean } = {},
): void {
  // OpenShell current main executes this fixed helper argv with ordinary
  // workload authority. There is no listener, proxy, persistent service, or
  // MCP traffic on this control path; argv carries only an OpenShell
  // placeholder and endpoint metadata.
  let result: ReturnType<typeof runOpenshellProviderCommand>;
  try {
    result = runOpenshellProviderCommand(buildHermesMcpExecArgs(sandboxName, command), {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The remote supervisor enforces 620s; keep a small transport margin so
      // remote termination is observed before this local subprocess is killed.
      timeout: 645_000,
    });
  } catch (error) {
    if (options.bestEffort) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpBridgeError(
      redactBridgeSecretsForDisplay(detail, entry, options.envValues ?? {}) || failureMessage,
    );
  }
  const output = redactBridgeSecretsForDisplay(
    commandOutput(result, options.envValues ?? {}),
    entry,
    options.envValues ?? {},
  );
  if (result.status !== 0 || result.error) {
    if (options.bestEffort) return;
    const errorDetail = result.error
      ? redactBridgeSecretsForDisplay(result.error.message, entry, options.envValues ?? {})
      : "";
    throw new McpBridgeError(errorDetail || output || failureMessage);
  }
  const stdout = result.stdout || "";
  const response = parseLastJsonObject(stdout);
  if (
    response?.ok !== true ||
    typeof response.changed !== "boolean" ||
    typeof response.reloaded !== "boolean"
  ) {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Hermes MCP lifecycle command returned an invalid response for '${entry.server}'.`,
    );
  }
  if (options.requireReload && response.reloaded !== true) {
    if (options.bestEffort) return;
    throw new McpBridgeError(
      `Hermes gateway was not running, so MCP server '${entry.server}' was not loaded.`,
    );
  }
}

function verifyHermesAdapterRegistration(sandboxName: string, entry: McpBridgeEntry): void {
  const inspection = inspectHermesAdapterRegistration(sandboxName, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `hermes-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerHermesAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
): void {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRegisterCommand(entry, replaceExisting),
    `Hermes MCP config registration failed for '${entry.server}'.`,
    { envValues, requireReload: true },
  );
  verifyHermesAdapterRegistration(sandboxName, entry);
}

export function unregisterHermesAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): void {
  runHermesAdapterCommand(
    sandboxName,
    entry,
    buildHermesMcpRemoveCommand(entry, options.force === true),
    `Hermes MCP config removal failed for '${entry.server}'.`,
    options,
  );
}
