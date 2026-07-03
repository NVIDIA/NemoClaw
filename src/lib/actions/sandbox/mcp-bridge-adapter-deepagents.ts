// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  type AdapterRemovalOutcome,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  buildDeepAgentsMcpStatusCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeSandboxCommand } from "./process-recovery";

const DEEPAGENTS_MCP_CAPABILITY_MARKER = "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2";
const DEEPAGENTS_MCP_CAPABILITY_COMMAND =
  "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability";
const DEEPAGENTS_MCP_MAX_SERVERS = 64;
const DEEPAGENTS_LEGACY_MCP_CONFIG_PATH = "/sandbox/.deepagents/.mcp.json";
const DEEPAGENTS_LEGACY_CONFIG_HELPERS = [
  "LEGACY_MCP_MAX_BYTES = 262144",
  "def reject_duplicate_keys(pairs):",
  "    result = {}",
  "    for key, value in pairs:",
  "        if key in result:",
  "            raise ValueError(f'duplicate JSON key: {key}')",
  "        result[key] = value",
  "    return result",
  "def reject_non_json_constant(value):",
  "    raise ValueError(f'non-JSON numeric constant: {value}')",
  "def legacy_fingerprint(metadata):",
  "    return (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns, metadata.st_mode, metadata.st_nlink, metadata.st_uid)",
  "def read_legacy_config(path):",
  "    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW",
  "    descriptor = os.open(path, flags)",
  "    try:",
  "        before = os.fstat(descriptor)",
  "        linked = os.stat(path, follow_symlinks=False)",
  "        safe = (stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1 and (before.st_dev, before.st_ino) == (linked.st_dev, linked.st_ino))",
  "        if not safe:",
  "            raise ValueError('legacy MCP config has unsafe ownership, mode, type, or links')",
  "        if before.st_size <= 0 or before.st_size > LEGACY_MCP_MAX_BYTES:",
  "            raise ValueError('legacy MCP config has invalid size')",
  "        chunks = []",
  "        remaining = before.st_size",
  "        while remaining:",
  "            chunk = os.read(descriptor, remaining)",
  "            if not chunk:",
  "                break",
  "            chunks.append(chunk)",
  "            remaining -= len(chunk)",
  "        after = os.fstat(descriptor)",
  "        linked_after = os.stat(path, follow_symlinks=False)",
  "        stable = (legacy_fingerprint(before) == legacy_fingerprint(after) and legacy_fingerprint(after) == legacy_fingerprint(linked_after))",
  "        if remaining or not stable:",
  "            raise ValueError('legacy MCP config changed while reading')",
  "    finally:",
  "        os.close(descriptor)",
  "    raw = b''.join(chunks).decode('utf-8')",
  "    data = json.loads(raw, object_pairs_hook=reject_duplicate_keys, parse_constant=reject_non_json_constant)",
  "    return data, legacy_fingerprint(before)",
  "def assert_legacy_source_stable(path, identity):",
  "    if identity is None:",
  "        if os.path.lexists(path):",
  "            raise ValueError('legacy MCP config appeared during mutation')",
  "        return",
  "    current = os.stat(path, follow_symlinks=False)",
  "    safe = (stat.S_ISREG(current.st_mode) and current.st_uid == os.getuid() and stat.S_IMODE(current.st_mode) == 0o600 and current.st_nlink == 1 and legacy_fingerprint(current) == identity)",
  "    if not safe:",
  "        raise ValueError('legacy MCP config changed before mutation')",
];

function buildDeepAgentsMcpRollbackRegisterCommand(
  entry: McpBridgeEntry,
  expectedServers: Record<string, Record<string, unknown>>,
): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    expectedServers,
  };
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, stat, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `managed_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    `legacy_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_LEGACY_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_LEGACY_CONFIG_HELPERS,
    `runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
    "if runtime_kind == 'auto':",
    "    runtime_kind = 'unknown'",
    "    try:",
    "        from deepagents_code import _nemoclaw_managed as managed",
    "        runtime_path = str(getattr(managed, '_MCP_CONFIG_FILE', ''))",
    "        if runtime_path == str(managed_path):",
    "            runtime_kind = 'v2'",
    "        elif runtime_path == str(legacy_path):",
    "            runtime_kind = 'legacy'",
    "    except Exception:",
    "        pass",
    "if runtime_kind not in ('v2', 'legacy'):",
    "    print('Could not identify the managed Deep Agents MCP runtime; refusing rollback', file=sys.stderr)",
    "    raise SystemExit(2)",
    "is_v2 = runtime_kind == 'v2'",
    "if is_v2 and len(payload['expectedServers']) > 64:",
    "    print('Managed MCP v2 supports at most 64 servers', file=sys.stderr)",
    "    raise SystemExit(2)",
    "config_path = managed_path if is_v2 else legacy_path",
    "data = {}",
    "legacy_identity = None",
    "if os.path.lexists(config_path):",
    "    if config_path.is_symlink():",
    "        print(f'Refusing to restore managed MCP state through symlink {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    try:",
    "        if is_v2:",
    "            data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "        else:",
    "            data, legacy_identity = read_legacy_config(config_path)",
    "    except (OSError, UnicodeDecodeError, ValueError) as exc:",
    "        print(f'Invalid managed MCP rollback state at {config_path}: {exc}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "if not isinstance(data, dict):",
    "    print(f'Invalid managed MCP rollback state at {config_path}: expected object', file=sys.stderr)",
    "    raise SystemExit(2)",
    "if is_v2:",
    "    if data and set(data) != {'mcpServers'}:",
    "        print(f'Invalid managed MCP v2 projection at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    servers = data.get('mcpServers', {})",
    "    if not isinstance(servers, dict):",
    "        print(f'Invalid managed MCP v2 server map at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    if any(payload['expectedServers'].get(name) != current for name, current in servers.items()):",
    "        print(f'Refusing to overwrite drifted managed MCP v2 projection at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    data = {'mcpServers': payload['expectedServers']}",
    "else:",
    "    servers = data.setdefault('mcpServers', {})",
    "    if not isinstance(servers, dict):",
    "        print(f'Refusing to overwrite mixed legacy MCP state at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    current = servers.get(payload['server'])",
    "    if payload['server'] in servers and current != payload['expected']:",
    "        print(f'Refusing to overwrite user-owned legacy MCP server at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    servers[payload['server']] = payload['expected']",
    "config_path.parent.mkdir(parents=True, exist_ok=True)",
    "tmp_fd, tmp_name = tempfile.mkstemp(prefix='.nemoclaw-mcp.', dir=config_path.parent)",
    "try:",
    "    os.fchmod(tmp_fd, 0o600)",
    "    with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tmp_file:",
    "        json.dump(data, tmp_file, indent=2, sort_keys=True)",
    "        tmp_file.write('\\n')",
    "        tmp_file.flush()",
    "        os.fsync(tmp_file.fileno())",
    "    if not is_v2:",
    "        assert_legacy_source_stable(config_path, legacy_identity)",
    "        if legacy_identity is None:",
    "            os.link(tmp_name, config_path, follow_symlinks=False)",
    "            os.unlink(tmp_name)",
    "        else:",
    "            os.replace(tmp_name, config_path)",
    "    else:",
    "        os.replace(tmp_name, config_path)",
    "finally:",
    "    try:",
    "        os.unlink(tmp_name)",
    "    except FileNotFoundError:",
    "        pass",
    "if is_v2:",
    "    os.chmod(config_path, 0o600)",
    "try:",
    "    persisted = json.loads(config_path.read_text(encoding='utf-8')) if is_v2 else read_legacy_config(config_path)[0]",
    "except (OSError, UnicodeDecodeError, ValueError) as exc:",
    "    print(f'Could not verify managed MCP rollback state at {config_path}: {exc}', file=sys.stderr)",
    "    raise SystemExit(2)",
    "if is_v2:",
    "    restored = persisted == {'mcpServers': payload['expectedServers']}",
    "else:",
    "    persisted_servers = persisted.get('mcpServers') if isinstance(persisted, dict) else None",
    "    restored = isinstance(persisted_servers, dict) and persisted_servers.get(payload['server']) == payload['expected']",
    "if not restored:",
    "    print(f'Managed MCP rollback verification failed at {config_path}', file=sys.stderr)",
    "    raise SystemExit(2)",
    "print('NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1')",
    "PY",
  ].join("\n");
}

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  managedEntries: readonly McpBridgeEntry[] = [entry],
  teardownRollback = false,
): string {
  const expectedServers = Object.fromEntries(
    managedEntries
      .map((managedEntry): [string, Record<string, unknown>] => [
        managedEntry.server,
        deepAgentsManagedServerConfig(managedEntry),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const expectedServerCount = Object.keys(expectedServers).length;
  if (!teardownRollback && expectedServerCount > DEEPAGENTS_MCP_MAX_SERVERS) {
    throw new McpBridgeError(
      `Deep Agents managed MCP supports at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers; refusing to render a ${String(expectedServerCount)}-server mutation.`,
    );
  }
  if (teardownRollback) {
    return buildDeepAgentsMcpRollbackRegisterCommand(entry, expectedServers);
  }
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    expectedServers,
    replaceExisting,
  };
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "data = {}",
    "if os.path.lexists(config_path):",
    "    if config_path.is_symlink():",
    `        print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: managed projection must not be a symlink', file=sys.stderr)`,
    "        raise SystemExit(2)",
    "    try:",
    "        data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "    except json.JSONDecodeError as exc:",
    `        print(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}', file=sys.stderr)`,
    "        raise SystemExit(2)",
    "if not isinstance(data, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if data and set(data) != {'mcpServers'}:",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: only mcpServers is allowed', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    print(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.", file=sys.stderr)`,
    "    raise SystemExit(2)",
    "for name, current in servers.items():",
    "    if name == payload['server'] and payload['replaceExisting']:",
    "        continue",
    "    if payload['expectedServers'].get(name) != current:",
    `        print(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: MCP server '{name}' is not exact registry-owned state", file=sys.stderr)`,
    "        raise SystemExit(2)",
    "data = {'mcpServers': payload['expectedServers']}",
    "config_path.parent.mkdir(parents=True, exist_ok=True)",
    "tmp_fd, tmp_name = tempfile.mkstemp(prefix='.nemoclaw-mcp.', dir=config_path.parent)",
    "try:",
    "    os.fchmod(tmp_fd, 0o600)",
    "    with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tmp_file:",
    "        json.dump(data, tmp_file, indent=2, sort_keys=True)",
    "        tmp_file.write('\\n')",
    "        tmp_file.flush()",
    "        os.fsync(tmp_file.fileno())",
    "    os.replace(tmp_name, config_path)",
    "finally:",
    "    try:",
    "        os.unlink(tmp_name)",
    "    except FileNotFoundError:",
    "        pass",
    "os.chmod(config_path, 0o600)",
    "PY",
  ].join("\n");
}

export function buildDeepAgentsMcpRemoveCommand(
  entry: McpBridgeEntry,
  force = false,
  adaptiveTeardown = false,
): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    force,
  };
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, stat, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `managed_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    `legacy_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_LEGACY_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_LEGACY_CONFIG_HELPERS,
    `runtime_kind = "${adaptiveTeardown ? "auto" : "v2"}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
    "if runtime_kind == 'auto':",
    "    runtime_kind = 'unknown'",
    "    try:",
    "        from deepagents_code import _nemoclaw_managed as managed",
    "        runtime_path = str(getattr(managed, '_MCP_CONFIG_FILE', ''))",
    "        if runtime_path == str(managed_path):",
    "            runtime_kind = 'v2'",
    "        elif runtime_path == str(legacy_path):",
    "            runtime_kind = 'legacy'",
    "    except Exception:",
    "        pass",
    "if runtime_kind not in ('v2', 'legacy'):",
    "    print('Could not identify the managed Deep Agents MCP runtime; refusing teardown', file=sys.stderr)",
    "    raise SystemExit(2)",
    "is_v2 = runtime_kind == 'v2'",
    "config_path = managed_path if is_v2 else legacy_path",
    "legacy_identity = None",
    "def finish(outcome):",
    "    print('NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=' + outcome)",
    "    raise SystemExit(0)",
    "def write_data(value):",
    "    tmp_fd, tmp_name = tempfile.mkstemp(prefix='.nemoclaw-mcp.', dir=config_path.parent)",
    "    try:",
    "        os.fchmod(tmp_fd, 0o600)",
    "        with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tmp_file:",
    "            json.dump(value, tmp_file, indent=2, sort_keys=True)",
    "            tmp_file.write('\\n')",
    "            tmp_file.flush()",
    "            os.fsync(tmp_file.fileno())",
    "        if not is_v2:",
    "            assert_legacy_source_stable(config_path, legacy_identity)",
    "            if legacy_identity is None:",
    "                os.link(tmp_name, config_path, follow_symlinks=False)",
    "                os.unlink(tmp_name)",
    "            else:",
    "                os.replace(tmp_name, config_path)",
    "        else:",
    "            os.replace(tmp_name, config_path)",
    "    finally:",
    "        try:",
    "            os.unlink(tmp_name)",
    "        except FileNotFoundError:",
    "            pass",
    "    if is_v2:",
    "        os.chmod(config_path, 0o600)",
    "if not os.path.lexists(config_path):",
    "    finish('absent')",
    "if config_path.is_symlink():",
    "    if is_v2 and payload['force']:",
    "        config_path.unlink()",
    "        finish('removed')",
    "    if is_v2:",
    "        print(f'Invalid managed MCP v2 projection symlink at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    finish('unowned')",
    "try:",
    "    if is_v2:",
    "        data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "    else:",
    "        data, legacy_identity = read_legacy_config(config_path)",
    "except (OSError, UnicodeDecodeError, ValueError) as exc:",
    "    if is_v2 and payload['force']:",
    "        config_path.unlink()",
    "        finish('removed')",
    "    if is_v2:",
    "        print(f'Invalid managed MCP v2 projection at {config_path}: {exc}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    finish('unowned')",
    "if not isinstance(data, dict):",
    "    if is_v2 and payload['force']:",
    "        config_path.unlink()",
    "        finish('removed')",
    "    if is_v2:",
    "        print(f'Invalid managed MCP v2 projection at {config_path}: expected object', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    finish('unowned')",
    "servers = data.get('mcpServers')",
    "if not isinstance(servers, dict):",
    "    if not is_v2 and 'mcpServers' not in data:",
    "        finish('absent')",
    "    if is_v2 and payload['force']:",
    "        config_path.unlink()",
    "        finish('removed')",
    "    if is_v2:",
    "        print(f'Invalid managed MCP v2 server map at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    finish('unowned')",
    "present = payload['server'] in servers",
    "current = servers.get(payload['server'])",
    "if is_v2:",
    "    if data and set(data) != {'mcpServers'}:",
    "        if payload['force']:",
    "            config_path.unlink()",
    "            finish('removed')",
    "        print(f'Invalid managed MCP v2 projection at {config_path}: only mcpServers is allowed', file=sys.stderr)",
    "        raise SystemExit(2)",
    "    if present and not payload['force'] and current != payload['expected']:",
    "        print(f\"Refusing to remove modified MCP server '{payload['server']}' from {config_path}. Use --force to remove it.\", file=sys.stderr)",
    "        raise SystemExit(2)",
    "    if not present:",
    "        finish('absent')",
    "else:",
    "    if not present:",
    "        finish('absent')",
    "    if current != payload['expected'] and not payload['force']:",
    "        finish('unowned')",
    "servers.pop(payload['server'])",
    "if not servers:",
    "    data.pop('mcpServers', None)",
    "if data:",
    "    write_data(data)",
    "    if not is_v2 and read_legacy_config(config_path)[0] != data:",
    "        print(f'Legacy MCP teardown verification failed at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "else:",
    "    if not is_v2:",
    "        assert_legacy_source_stable(config_path, legacy_identity)",
    "    config_path.unlink()",
    "    if os.path.lexists(config_path):",
    "        print(f'Managed MCP teardown verification failed at {config_path}', file=sys.stderr)",
    "        raise SystemExit(2)",
    "finish('removed')",
    "PY",
  ].join("\n");
}

export function inspectDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpStatusCommand(entry),
  );
}

export function assertDeepAgentsMcpMutationRuntimeCapability(sandboxName: string): void {
  const result = executeSandboxCommand(sandboxName, DEEPAGENTS_MCP_CAPABILITY_COMMAND);
  if (result?.status !== 0 || result.stdout.trim() !== DEEPAGENTS_MCP_CAPABILITY_MARKER) {
    throw new McpBridgeError(
      `LangChain Deep Agents Code sandbox '${sandboxName}' does not contain managed MCP capability v2. Rebuild the sandbox before changing authenticated MCP state.`,
    );
  }
}

function runDeepAgentsAdapterCommand(
  sandboxName: string,
  entry: Pick<McpBridgeEntry, "env">,
  command: string,
  failureMessage: string,
  options: AdapterMutationOptions = {},
): string {
  const result = executeSandboxCommand(sandboxName, command);
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return "";
    throw new McpBridgeError(output || failureMessage);
  }
  return result.stdout;
}

function verifyDeepAgentsAdapterRegistration(sandboxName: string, entry: McpBridgeEntry): void {
  const inspection = inspectDeepAgentsAdapterRegistration(sandboxName, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
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

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  teardownRollback = false,
): void {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRegisterCommand(
      entry,
      replaceExisting,
      registryOwnedDeepAgentsEntries(sandboxName, entry),
      teardownRollback,
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
    verifyDeepAgentsAdapterRegistration(sandboxName, entry);
  }
}

export function unregisterDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): AdapterRemovalOutcome {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRemoveCommand(entry, options.force === true, options.teardown === true),
    `Deep Agents Code MCP config removal failed for '${entry.server}'.`,
    options,
  );
  const marker = stdout.match(/NEMOCLAW_DEEPAGENTS_MCP_REMOVAL=(removed|absent|unowned)/);
  return (marker?.[1] as AdapterRemovalOutcome | undefined) ?? "unowned";
}
