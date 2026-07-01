// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import type { AgentMcpAdapter } from "../../agent/defs";
import { waitUntil } from "../../core/wait";
import { shellQuote } from "../../runner";
import { isShieldsDown } from "../../shields";
import type { McpBridgeEntry } from "../../state/registry";
import {
  authorizationValue,
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  deepAgentsManagedServerConfig,
  DEEPAGENTS_MCP_CONFIG_PATH,
  entryHeaders,
  mcporterHeaderMatcherSource,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeSandboxCommand, type SandboxCommandResult } from "./process-recovery";

export {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  mcporterHeadersMatchExpected,
} from "./mcp-bridge-adapter-status";

export const MCPORTER_VERSION = "0.7.3";
const DEEPAGENTS_MCP_CAPABILITY_MARKER = "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1";
const DEEPAGENTS_MCP_CAPABILITY_COMMAND =
  "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability";
const HERMES_MCP_TRANSACTION_HELPER = "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";

function ensureMcporter(sandboxName: string): void {
  const check = executeSandboxCommand(sandboxName, "command -v mcporter");
  if (check?.status === 0 && check.stdout.trim()) return;
  throw new McpBridgeError(
    `mcporter is not available in sandbox '${sandboxName}'. Rebuild with a NemoClaw image that includes mcporter@${MCPORTER_VERSION}.`,
  );
}

export function buildOpenClawMcporterRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
): string {
  const args = ["mcporter", "config", "add", entry.server, "--url", entry.url];
  const authorization = authorizationValue(entry);
  if (authorization) args.push("--header", `Authorization=${authorization}`);
  args.push("--scope", "home");
  const addCommand = args.map(shellQuote).join(" ");
  if (replaceExisting) return addCommand;
  const getCommand = ["mcporter", "config", "get", entry.server, "--json"]
    .map(shellQuote)
    .join(" ");
  return [
    `if ${getCommand} >/dev/null 2>&1; then`,
    `  echo ${shellQuote(`MCP server '${entry.server}' already exists in mcporter config and is not managed by NemoClaw.`)} >&2`,
    "  exit 2",
    "fi",
    addCommand,
  ].join("\n");
}

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

const HERMES_MCP_EXEC_TIMEOUT_SECONDS = 620;
const HERMES_MCP_PROBE_TIMEOUT_SECONDS = 30;
const HERMES_MCP_STARTUP_TIMEOUT_SECONDS = 90;
const HERMES_MCP_GATEWAY_NOT_READY = "Hermes gateway is not running for managed MCP reload";
const HERMES_MCP_LIFECYCLE_NOT_READY =
  "Hermes gateway is not running under the managed service lifecycle";

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

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    replaceExisting,
  };
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, sys",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "data = {}",
    "if config_path.exists():",
    "    try:",
    "        data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "    except json.JSONDecodeError as exc:",
    `        print(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}', file=sys.stderr)`,
    "        raise SystemExit(2)",
    "if not isinstance(data, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    print(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.", file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers[payload['server']] = payload['expected']",
    "config_path.parent.mkdir(parents=True, exist_ok=True)",
    "tmp = config_path.with_name(config_path.name + '.nemoclaw-mcp.tmp')",
    "tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n', encoding='utf-8')",
    "os.chmod(tmp, 0o600)",
    "os.replace(tmp, config_path)",
    "os.chmod(config_path, 0o600)",
    "PY",
  ].join("\n");
}

export function buildDeepAgentsMcpRemoveCommand(entry: McpBridgeEntry, force = false): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    force,
  };
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, sys",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "if not config_path.exists():",
    "    raise SystemExit(0)",
    "try:",
    "    data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "except json.JSONDecodeError as exc:",
    `    print(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if not isinstance(data, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers = data.get('mcpServers')",
    "if servers is not None and not isinstance(servers, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if isinstance(servers, dict):",
    "    present = payload['server'] in servers",
    "    current = servers.get(payload['server'])",
    "    if present and not payload['force']:",
    "        if current != payload['expected']:",
    `            print(f"Refusing to remove modified MCP server '{payload['server']}' from ${DEEPAGENTS_MCP_CONFIG_PATH}. Use --force to remove it.", file=sys.stderr)`,
    "            raise SystemExit(2)",
    "    servers.pop(payload['server'], None)",
    "    if not servers:",
    "        data.pop('mcpServers', None)",
    "        if not data:",
    "            config_path.unlink()",
    "            raise SystemExit(0)",
    "tmp = config_path.with_name(config_path.name + '.nemoclaw-mcp.tmp')",
    "tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n', encoding='utf-8')",
    "os.chmod(tmp, 0o600)",
    "os.replace(tmp, config_path)",
    "os.chmod(config_path, 0o600)",
    "PY",
  ].join("\n");
}

export function buildOpenClawMcporterRemoveCommand(entry: McpBridgeEntry, force = false): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const get = spawnSync("mcporter", ["config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (get.error) { console.error(get.error.message); process.exit(3); }",
    'const getDetail = `${get.stderr || ""}\n${get.stdout || ""}`;',
    "const absent = get.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(getDetail);",
    "if (absent) process.exit(0);",
    "if (get.status !== 0) { console.error(getDetail.trim()); process.exit(3); }",
    "let actual = null; try { actual = JSON.parse(get.stdout); } catch {}",
    'const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    mcporterHeaderMatcherSource(),
    'const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    "if (!registered && !expected.force) { console.error(`Refusing to remove modified mcporter MCP server '${expected.server}'. Use --force to remove it.`); process.exit(2); }",
    'const remove = spawnSync("mcporter", ["config", "remove", expected.server], { encoding: "utf8" });',
    "if (remove.stdout) process.stdout.write(remove.stdout);",
    "if (remove.stderr) process.stderr.write(remove.stderr);",
    "if (remove.error) { console.error(remove.error.message); process.exit(3); }",
    'const removeDetail = `${remove.stderr || ""}\n${remove.stdout || ""}`;',
    "if (remove.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(removeDetail)) process.exit(0);",
    "process.exit(remove.status === null ? 3 : remove.status);",
    "NODE",
  ].join("\n");
}

function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
): void {
  ensureMcporter(sandboxName);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRegisterCommand(entry, replaceExisting),
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(output || `mcporter config add failed for '${entry.server}'.`);
  }

  // A zero exit from `config add` proves only that mcporter accepted the
  // command. Re-read the persisted definition before claiming ownership so a
  // changed mcporter normalization/schema cannot commit an entry that differs
  // from the URL and opaque OpenShell placeholder NemoClaw intended.
  const verification = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterInspectCommand(entry, true),
  );
  const verificationOutput = redactBridgeSecretsForDisplay(
    [verification?.stdout, verification?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (
    !verification ||
    verification.status !== 0 ||
    verification.stdout.trim().split(/\r?\n/).at(-1) !== "registered"
  ) {
    throw new McpBridgeError(
      `mcporter config verification failed after adding '${entry.server}'${verificationOutput ? `: ${verificationOutput}` : "."}`,
    );
  }
}

function runAdapterCommand(
  sandboxName: string,
  entry: Pick<McpBridgeEntry, "env">,
  command: string,
  failureMessage: string,
  options: {
    force?: boolean;
    bestEffort?: boolean;
    envValues?: Record<string, string>;
  } = {},
): void {
  const result = executeSandboxCommand(sandboxName, command);
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return;
    throw new McpBridgeError(output || failureMessage);
  }
}

export type AdapterRegistrationInspection =
  { state: "absent" | "registered" | "mismatch" } | { state: "error"; detail: string };

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

export function inspectAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  const command =
    adapter === "mcporter"
      ? buildOpenClawMcporterInspectCommand(entry, false)
      : adapter === "hermes-config"
        ? buildHermesMcpStatusCommand(entry)
        : buildDeepAgentsMcpStatusCommand(entry);
  const result = executeSandboxCommand(sandboxName, command);
  if (!result) return { state: "error", detail: "sandbox unreachable" };
  return parseAdapterRegistrationInspection(result, entry);
}

function verifyAgentAdapterRegistration(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
): void {
  const inspection = inspectAgentAdapterRegistration(sandboxName, adapter, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `${adapter} config verification failed after adding '${entry.server}': ${detail}.`,
  );
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

/**
 * Refuse an in-sandbox adapter config mutation while Hermes config is locked.
 * This host-side check intentionally runs before provider, policy, attachment,
 * or adapter work; the transaction helper repeats the file-level check to
 * close posture drift between this preflight and the actual config write.
 *
 * Deep Agents and OpenClaw do not use the Hermes shields contract. In
 * particular, teardown of a legacy Deep Agents entry must remain possible on
 * an image that predates the managed launcher capability marker.
 */
export function assertAgentMcpConfigMutationAllowed(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  if (adapter !== "hermes-config") return;
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
export function assertAgentMcpMutationRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  if (adapter === "deepagents-config") {
    const result = executeSandboxCommand(sandboxName, DEEPAGENTS_MCP_CAPABILITY_COMMAND);
    if (result?.status !== 0 || result.stdout.trim() !== DEEPAGENTS_MCP_CAPABILITY_MARKER) {
      throw new McpBridgeError(
        `LangChain Deep Agents Code sandbox '${sandboxName}' does not contain the managed MCP-aware launcher. Rebuild the sandbox before changing authenticated MCP state.`,
      );
    }
    return;
  }
  if (adapter !== "hermes-config") return;
  assertAgentMcpConfigMutationAllowed(sandboxName, adapter);
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

/**
 * Validate the runtime needed to scrub an existing adapter definition.
 * Hermes teardown still uses its managed transaction helper and therefore
 * requires the full helper/lifecycle probe. Deep Agents teardown executes the
 * ownership-checked config scrub directly and must remain available to images
 * that predate the new launcher marker.
 */
export function assertAgentMcpTeardownRuntimeCapability(
  sandboxName: string,
  adapter: AgentMcpAdapter,
): void {
  assertAgentMcpConfigMutationAllowed(sandboxName, adapter);
  if (adapter === "hermes-config") {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter);
  }
}

function runHermesAdapterCommand(
  sandboxName: string,
  entry: McpBridgeEntry,
  command: readonly string[],
  failureMessage: string,
  options: {
    bestEffort?: boolean;
    envValues?: Record<string, string>;
    requireReload?: boolean;
  } = {},
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

export function registerAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  options: { replaceExisting?: boolean } = {},
): void {
  switch (adapter) {
    case "mcporter":
      registerOpenClawAdapter(sandboxName, entry, envValues, options.replaceExisting === true);
      return;
    case "hermes-config":
      runHermesAdapterCommand(
        sandboxName,
        entry,
        buildHermesMcpRegisterCommand(entry, options.replaceExisting === true),
        `Hermes MCP config registration failed for '${entry.server}'.`,
        { envValues, requireReload: true },
      );
      verifyAgentAdapterRegistration(sandboxName, adapter, entry);
      return;
    case "deepagents-config":
      runAdapterCommand(
        sandboxName,
        entry,
        buildDeepAgentsMcpRegisterCommand(entry, options.replaceExisting === true),
        `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
        { envValues },
      );
      verifyAgentAdapterRegistration(sandboxName, adapter, entry);
      return;
  }
}

function unregisterOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: {
    force?: boolean;
    bestEffort?: boolean;
    envValues?: Record<string, string>;
  } = {},
): void {
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRemoveCommand(entry, options.force === true),
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return;
    throw new McpBridgeError(output || `mcporter config remove failed for '${entry.server}'.`);
  }
}

export function unregisterAgentAdapter(
  sandboxName: string,
  adapter: AgentMcpAdapter,
  entry: McpBridgeEntry,
  options: {
    force?: boolean;
    bestEffort?: boolean;
    envValues?: Record<string, string>;
  } = {},
): void {
  switch (adapter) {
    case "mcporter":
      unregisterOpenClawAdapter(sandboxName, entry, options);
      return;
    case "hermes-config":
      runHermesAdapterCommand(
        sandboxName,
        entry,
        buildHermesMcpRemoveCommand(entry, options.force === true),
        `Hermes MCP config removal failed for '${entry.server}'.`,
        options,
      );
      return;
    case "deepagents-config":
      runAdapterCommand(
        sandboxName,
        entry,
        buildDeepAgentsMcpRemoveCommand(entry, options.force === true),
        `Deep Agents Code MCP config removal failed for '${entry.server}'.`,
        options,
      );
      return;
  }
}
