// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { getTransientBridgeState } from "./mcp-bridge/transient-state";
import { assertDeepAgentsMcpMutationRuntimeCapability } from "./mcp-bridge-adapter-deepagents-capability";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { inspectDeepAgentsAdapterRegistration } from "./mcp-bridge-adapter-deepagents-inspection";
import { buildDeepAgentsMcpRollbackRegisterCommand } from "./mcp-bridge-adapter-deepagents-legacy";
import {
  DEEPAGENTS_NATIVE_MCP_CONFIG_HELPERS,
  DEEPAGENTS_MCP_MAX_SERVERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
} from "./mcp-bridge-adapter-deepagents-native-config";
import {
  MANAGED_HTTP_SERVER_MATCH_HELPERS,
  DEEPAGENTS_MCP_CONFIG_PATH,
  buildDeepAgentsMcpRuntimeKindCommand,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { McpBridgeError } from "./mcp-bridge-contracts";

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpSourceEntry | undefined,
  replaceExisting = false,
  managedEntries: readonly McpSourceEntry[] = entry ? [entry] : [],
  teardownRollback = false,
  credentialRevision?: McpAttachedCredentialRevision,
  options: { resetNativeConfig?: boolean } = {},
): string {
  const resetNativeConfig = options.resetNativeConfig === true;
  if (resetNativeConfig && (!replaceExisting || teardownRollback)) {
    throw new McpBridgeError(
      "Deep Agents native MCP configuration reset requires an ordinary replacement mutation.",
    );
  }
  if (!entry && !resetNativeConfig) {
    throw new McpBridgeError("Deep Agents MCP registration requires a source entry.");
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
      throw new McpBridgeError("Deep Agents MCP rollback requires a source entry.");
    }
    return buildDeepAgentsMcpRollbackRegisterCommand(entry, expectedServers);
  }
  const payload = {
    server: entry?.server ?? null,
    expected: entry ? deepAgentsManagedServerConfig(entry, credentialRevision) : null,
    expectedServers,
    replaceExisting,
    resetNativeConfig,
  };
  // Snapshot restore has explicit authority to replace this exact native file.
  // Stage a regular file and replace the directory entry atomically,
  // so a symlink or FIFO is never opened and a symlink target stays unchanged.
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, secrets, stat, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_STRICT_JSON_HELPERS,
    ...DEEPAGENTS_NATIVE_MCP_CONFIG_HELPERS,
    ...MANAGED_HTTP_SERVER_MATCH_HELPERS,
    "source_descriptor = None",
    "def fail_registration(message):",
    "    close_native_mcp_config_descriptor(source_descriptor)",
    "    print(message, file=sys.stderr)",
    "    raise SystemExit(2)",
    "def open_native_config_parent():",
    "    parent_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW",
    "    parent_name = config_path.parent.name",
    "    if not parent_name or parent_name in ('.', '..'):",
    "        raise ValueError('native MCP configuration parent is unsafe')",
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
    "            raise ValueError('native MCP configuration parent is unsafe')",
    "        return parent_descriptor",
    "    finally:",
    "        os.close(anchor_descriptor)",
    "def reset_native_config(value):",
    "    payload_bytes = native_mcp_config_bytes(value)",
    "    try:",
    "        parent_descriptor = open_native_config_parent()",
    "    except (OSError, ValueError) as exc:",
    "        raise ValueError('native MCP configuration parent is unsafe') from exc",
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
    "            raise ValueError('native MCP configuration staging file could not be created')",
    "        staged_metadata = os.fstat(staged_descriptor)",
    "        if not stat.S_ISREG(staged_metadata.st_mode) or staged_metadata.st_uid != os.getuid() or stat.S_IMODE(staged_metadata.st_mode) != 0o600 or staged_metadata.st_nlink != 1:",
    "            raise ValueError('native MCP configuration staging file is unsafe')",
    "        offset = 0",
    "        while offset < len(payload_bytes):",
    "            written = os.write(staged_descriptor, payload_bytes[offset:])",
    "            if written <= 0:",
    "                raise OSError('native MCP configuration write made no progress')",
    "            offset += written",
    "        os.fsync(staged_descriptor)",
    "        staged_after = os.fstat(staged_descriptor)",
    "        staged_link = os.stat(staged_name, dir_fd=parent_descriptor, follow_symlinks=False)",
    "        staged_stable = (stat.S_ISREG(staged_after.st_mode) and staged_after.st_uid == os.getuid() and stat.S_IMODE(staged_after.st_mode) == 0o600 and staged_after.st_nlink == 1 and staged_after.st_size == len(payload_bytes) and managed_fingerprint(staged_after) == managed_fingerprint(staged_link))",
    "        if not staged_stable:",
    "            raise ValueError('native MCP configuration staging file changed before publication')",
    "        try:",
    "            current = os.stat(config_path.name, dir_fd=parent_descriptor, follow_symlinks=False)",
    "        except FileNotFoundError:",
    "            current = None",
    "        if current is not None and stat.S_ISDIR(current.st_mode):",
    "            raise ValueError('native MCP configuration path is a directory')",
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
    "    persisted, _ = read_native_mcp_config(config_path)",
    "    if persisted != value:",
    "        raise ValueError('native MCP configuration verification failed')",
    "if payload['resetNativeConfig']:",
    "    data = {}",
    "    source_identity = None",
    "else:",
    "    try:",
    "        data, source_identity, source_descriptor = load_native_mcp_config_for_update(config_path)",
    "    except (OSError, UnicodeDecodeError, ValueError) as exc:",
    `        fail_registration(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "if not isinstance(data, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object')`,
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object')`,
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    fail_registration(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.")`,
    "if payload['resetNativeConfig']:",
    "    data = {'mcpServers': dict(payload['expectedServers'])}",
    "elif payload['server'] is not None:",
    "    servers[payload['server']] = payload['expected']",
    "if not payload['resetNativeConfig']:",
    "    config_path.parent.mkdir(parents=True, exist_ok=True)",
    "try:",
    "    if payload['resetNativeConfig']:",
    "        reset_native_config(data)",
    "    else:",
    "        write_native_mcp_config(config_path, data, source_identity, source_descriptor)",
    "except (OSError, ValueError) as exc:",
    `    fail_registration(f'Could not publish ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "PY",
  ].join("\n");
}

function observedDeepAgentsEntries(
  sandboxName: string,
  entry: McpSourceEntry,
): McpSourceEntry[] {
  const entries = new Map<string, McpSourceEntry>();
  const bridges = getTransientBridgeState(sandboxName);
  for (const bridge of Object.values(bridges)) entries.set(bridge.server, bridge);
  entries.set(entry.server, entry);
  return [...entries.values()];
}

function verifyDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  const inspection = inspectDeepAgentsAdapterRegistration(
    sandboxName,
    entry,
    runtimeSelection,
    credentialRevision,
  );
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
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
      observedDeepAgentsEntries(sandboxName, entry),
      teardownRollback,
      credentialRevision,
    ),
    `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
    runtimeSelection,
    { envValues },
  );
  if (teardownRollback) {
    if (!stdout.includes("NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1")) {
      throw new McpBridgeError(
        `Deep Agents Code MCP rollback verification failed for '${entry.server}'.`,
      );
    }
  } else {
    verifyDeepAgentsAdapterRegistration(sandboxName, entry, runtimeSelection, credentialRevision);
  }
}

export function restoreDeepAgentsNativeMcpConfig(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
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
      "Native MCP configuration repair requires Deep Agents source entries.",
    );
  }
  const entry = managedEntries[0];
  const commandEntry: Pick<McpSourceEntry, "env"> = entry ?? { env: [] };
  const runtimeKind = runDeepAgentsAdapterCommand(
    sandboxName,
    commandEntry,
    buildDeepAgentsMcpRuntimeKindCommand(),
    "Could not identify the managed Deep Agents MCP runtime.",
    runtimeSelection,
  )
    .trim()
    .split(/\r?\n/u)
    .at(-1);
  if (runtimeKind === "legacy") return;
  if (runtimeKind !== "v2") {
    throw new McpBridgeError("Could not identify the managed Deep Agents MCP runtime.");
  }
  assertDeepAgentsMcpMutationRuntimeCapability(sandboxName, runtimeSelection);
  runDeepAgentsAdapterCommand(
    sandboxName,
    commandEntry,
    buildDeepAgentsMcpRegisterCommand(entry, true, managedEntries, false, undefined, {
      resetNativeConfig: true,
    }),
    "Deep Agents Code native MCP configuration repair failed.",
    runtimeSelection,
  );
  for (const managedEntry of managedEntries) {
    verifyDeepAgentsAdapterRegistration(sandboxName, managedEntry, runtimeSelection);
  }
}
