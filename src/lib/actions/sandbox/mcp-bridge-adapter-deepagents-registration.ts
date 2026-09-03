// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import { assertDeepAgentsMcpMutationRuntimeCapability } from "./mcp-bridge-adapter-deepagents-capability";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { inspectDeepAgentsAdapterRegistration } from "./mcp-bridge-adapter-deepagents-inspection";
import { buildDeepAgentsMcpRollbackRegisterCommand } from "./mcp-bridge-adapter-deepagents-legacy";
import {
  DEEPAGENTS_MANAGED_PROJECTION_HELPERS,
  DEEPAGENTS_MCP_MAX_SERVERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
} from "./mcp-bridge-adapter-deepagents-projection";
import {
  MANAGED_HTTP_SERVER_MATCH_HELPERS,
  DEEPAGENTS_MCP_CONFIG_PATH,
  buildDeepAgentsMcpRuntimeKindCommand,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import { McpBridgeError } from "./mcp-bridge-contracts";

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry | undefined,
  replaceExisting = false,
  managedEntries: readonly McpBridgeEntry[] = entry ? [entry] : [],
  teardownRollback = false,
  credentialRevision?: McpAttachedCredentialRevision,
  options: { resetManagedProjection?: boolean } = {},
): string {
  const resetManagedProjection = options.resetManagedProjection === true;
  if (resetManagedProjection && (!replaceExisting || teardownRollback)) {
    throw new McpBridgeError(
      "Deep Agents managed MCP projection reset requires an ordinary replacement mutation.",
    );
  }
  if (!entry && !resetManagedProjection) {
    throw new McpBridgeError("Deep Agents MCP registration requires a registry entry.");
  }
  const expectedServers = Object.fromEntries(
    managedEntries
      .map((managedEntry): [string, Record<string, unknown>] => [
        managedEntry.server,
        deepAgentsManagedServerConfig(managedEntry),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (entry) {
    expectedServers[entry.server] = deepAgentsManagedServerConfig(entry, credentialRevision);
  }
  const expectedServerCount = Object.keys(expectedServers).length;
  if (!teardownRollback && expectedServerCount > DEEPAGENTS_MCP_MAX_SERVERS) {
    throw new McpBridgeError(
      `Deep Agents managed MCP supports at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers; refusing to render a ${String(expectedServerCount)}-server mutation.`,
    );
  }
  if (teardownRollback) {
    if (!entry) {
      throw new McpBridgeError("Deep Agents MCP rollback requires a registry entry.");
    }
    return buildDeepAgentsMcpRollbackRegisterCommand(entry, expectedServers);
  }
  const payload = {
    server: entry?.server ?? null,
    expected: entry ? deepAgentsManagedServerConfig(entry, credentialRevision) : null,
    expectedServers,
    replaceExisting,
    resetManagedProjection,
  };
  // Snapshot restore has explicit authority to replace this exact NemoClaw-owned
  // projection. Stage a regular file and replace the directory entry atomically,
  // so a symlink or FIFO is never opened and a symlink target stays unchanged.
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, secrets, stat, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_STRICT_JSON_HELPERS,
    ...DEEPAGENTS_MANAGED_PROJECTION_HELPERS,
    ...MANAGED_HTTP_SERVER_MATCH_HELPERS,
    "source_descriptor = None",
    "def fail_registration(message):",
    "    close_managed_projection_descriptor(source_descriptor)",
    "    print(message, file=sys.stderr)",
    "    raise SystemExit(2)",
    "def open_projection_parent():",
    "    parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW",
    "    parent_name = config_path.parent.name",
    "    if not parent_name or parent_name in ('.', '..'):",
    "        raise ValueError('managed MCP projection parent is unsafe')",
    "    anchor_descriptor = os.open(config_path.parent.parent, parent_flags)",
    "    try:",
    "        try:",
    "            os.mkdir(parent_name, 0o700, dir_fd=anchor_descriptor)",
    "        except FileExistsError:",
    "            pass",
    "        parent_descriptor = os.open(parent_name, parent_flags, dir_fd=anchor_descriptor)",
    "        opened = os.fstat(parent_descriptor)",
    "        linked = os.stat(parent_name, dir_fd=anchor_descriptor, follow_symlinks=False)",
    "        safe = (stat.S_ISDIR(opened.st_mode) and opened.st_uid == os.getuid() and (opened.st_dev, opened.st_ino) == (linked.st_dev, linked.st_ino))",
    "        if not safe:",
    "            os.close(parent_descriptor)",
    "            raise ValueError('managed MCP projection parent is unsafe')",
    "        return parent_descriptor",
    "    finally:",
    "        os.close(anchor_descriptor)",
    "def reset_projection(value):",
    "    payload_bytes = managed_projection_bytes(value)",
    "    try:",
    "        parent_descriptor = open_projection_parent()",
    "    except (OSError, ValueError) as exc:",
    "        raise ValueError('managed MCP projection parent is unsafe') from exc",
    "    staged_name = ''",
    "    staged_descriptor = None",
    "    try:",
    "        staged_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW",
    "        for _attempt in range(100):",
    "            staged_name = '.nemoclaw-mcp-restore.' + secrets.token_hex(16)",
    "            try:",
    "                staged_descriptor = os.open(staged_name, staged_flags, 0o600, dir_fd=parent_descriptor)",
    "                break",
    "            except FileExistsError:",
    "                continue",
    "        if staged_descriptor is None:",
    "            raise ValueError('managed MCP projection staging file could not be created')",
    "        staged_metadata = os.fstat(staged_descriptor)",
    "        if not stat.S_ISREG(staged_metadata.st_mode) or staged_metadata.st_uid != os.getuid() or stat.S_IMODE(staged_metadata.st_mode) != 0o600 or staged_metadata.st_nlink != 1:",
    "            raise ValueError('managed MCP projection staging file is unsafe')",
    "        offset = 0",
    "        while offset < len(payload_bytes):",
    "            written = os.write(staged_descriptor, payload_bytes[offset:])",
    "            if written <= 0:",
    "                raise OSError('managed MCP projection write made no progress')",
    "            offset += written",
    "        os.fsync(staged_descriptor)",
    "        staged_after = os.fstat(staged_descriptor)",
    "        staged_link = os.stat(staged_name, dir_fd=parent_descriptor, follow_symlinks=False)",
    "        staged_stable = (stat.S_ISREG(staged_after.st_mode) and staged_after.st_uid == os.getuid() and stat.S_IMODE(staged_after.st_mode) == 0o600 and staged_after.st_nlink == 1 and staged_after.st_size == len(payload_bytes) and managed_fingerprint(staged_after) == managed_fingerprint(staged_link))",
    "        if not staged_stable:",
    "            raise ValueError('managed MCP projection staging file changed before publication')",
    "        try:",
    "            current = os.stat(config_path.name, dir_fd=parent_descriptor, follow_symlinks=False)",
    "        except FileNotFoundError:",
    "            current = None",
    "        if current is not None and stat.S_ISDIR(current.st_mode):",
    "            raise ValueError('managed MCP projection path is a directory')",
    "        os.replace(staged_name, config_path.name, src_dir_fd=parent_descriptor, dst_dir_fd=parent_descriptor)",
    "        staged_name = ''",
    "        os.fsync(parent_descriptor)",
    "    finally:",
    "        if staged_descriptor is not None:",
    "            os.close(staged_descriptor)",
    "        if staged_name:",
    "            try:",
    "                os.unlink(staged_name, dir_fd=parent_descriptor)",
    "            except FileNotFoundError:",
    "                pass",
    "        os.close(parent_descriptor)",
    "    persisted, _ = read_managed_projection(config_path)",
    "    if persisted != value:",
    "        raise ValueError('managed MCP projection verification failed')",
    "if payload['resetManagedProjection']:",
    "    data = {}",
    "    source_identity = None",
    "else:",
    "    try:",
    "        data, source_identity, source_descriptor = load_managed_projection_for_update(config_path)",
    "    except (OSError, UnicodeDecodeError, ValueError) as exc:",
    `        fail_registration(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "if not isinstance(data, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object')`,
    "if data and set(data) != {'mcpServers'}:",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: only mcpServers is allowed')`,
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object')`,
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    fail_registration(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.")`,
    "if not payload['resetManagedProjection']:",
    "    for name, expected in payload['expectedServers'].items():",
    "        if name == payload['server']:",
    "            continue",
    "        if name not in servers:",
    `            fail_registration(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: registry-owned MCP sibling '{name}' is absent")`,
    "        if not managed_http_server_matches(servers[name], expected, True):",
    `            fail_registration(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: registry-owned MCP sibling '{name}' is not exact registry-owned state")`,
    "for name, current in servers.items():",
    "    if name == payload['server'] and payload['replaceExisting']:",
    "        continue",
    "    if not managed_http_server_matches(current, payload['expectedServers'].get(name), True):",
    `        fail_registration(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: MCP server '{name}' is not exact registry-owned state")`,
    "next_servers = {}",
    "for name, expected in payload['expectedServers'].items():",
    "    if not payload['resetManagedProjection'] and name != payload['server'] and name in servers:",
    "        next_servers[name] = servers[name]",
    "    else:",
    "        next_servers[name] = expected",
    "data = {'mcpServers': next_servers}",
    "if not payload['resetManagedProjection']:",
    "    config_path.parent.mkdir(parents=True, exist_ok=True)",
    "try:",
    "    if payload['resetManagedProjection']:",
    "        reset_projection(data)",
    "    else:",
    "        write_managed_projection(config_path, data, source_identity, source_descriptor)",
    "except (OSError, ValueError) as exc:",
    `    fail_registration(f'Could not publish ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "PY",
  ].join("\n");
}

function registryOwnedDeepAgentsEntries(
  sandboxName: string,
  entry: McpBridgeEntry,
): McpBridgeEntry[] {
  const entries = new Map<string, McpBridgeEntry>();
  const bridges = getSandbox(sandboxName)?.mcp?.bridges ?? {};
  for (const bridge of Object.values(bridges)) entries.set(bridge.server, bridge);
  entries.set(entry.server, entry);
  return [...entries.values()];
}

function verifyDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  const inspection = inspectDeepAgentsAdapterRegistration(sandboxName, entry, credentialRevision);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  teardownRollback = false,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRegisterCommand(
      entry,
      replaceExisting,
      registryOwnedDeepAgentsEntries(sandboxName, entry),
      teardownRollback,
      credentialRevision,
    ),
    `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
    { envValues },
  );
  if (teardownRollback) {
    if (!stdout.includes("NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1")) {
      throw new McpBridgeError(
        `Deep Agents Code MCP rollback verification failed for '${entry.server}'.`,
      );
    }
  } else {
    verifyDeepAgentsAdapterRegistration(sandboxName, entry, credentialRevision);
  }
}

export function restoreDeepAgentsManagedMcpProjection(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
): void {
  const managedEntries = [...entries].sort((left, right) =>
    left.server.localeCompare(right.server),
  );
  if (
    managedEntries.some(
      (entry) =>
        entry.agent !== "langchain-deepagents-code" || entry.adapter !== "deepagents-config",
    )
  ) {
    throw new McpBridgeError(
      "Managed MCP projection repair requires Deep Agents registry entries.",
    );
  }
  const entry = managedEntries[0];
  const commandEntry: Pick<McpBridgeEntry, "env"> = entry ?? { env: [] };
  const runtimeKind = runDeepAgentsAdapterCommand(
    sandboxName,
    commandEntry,
    buildDeepAgentsMcpRuntimeKindCommand(),
    "Could not identify the managed Deep Agents MCP runtime.",
  )
    .trim()
    .split(/\r?\n/u)
    .at(-1);
  if (runtimeKind === "legacy") return;
  if (runtimeKind !== "v2") {
    throw new McpBridgeError("Could not identify the managed Deep Agents MCP runtime.");
  }
  assertDeepAgentsMcpMutationRuntimeCapability(sandboxName);
  runDeepAgentsAdapterCommand(
    sandboxName,
    commandEntry,
    buildDeepAgentsMcpRegisterCommand(entry, true, managedEntries, false, undefined, {
      resetManagedProjection: true,
    }),
    "Deep Agents Code managed MCP projection repair failed.",
  );
  for (const managedEntry of managedEntries) {
    verifyDeepAgentsAdapterRegistration(sandboxName, managedEntry);
  }
}
