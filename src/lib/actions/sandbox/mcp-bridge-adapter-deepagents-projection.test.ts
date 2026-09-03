// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  runDeepAgentsConfigCommand,
} from "../../../../test/helpers/mcp-bridge-adapter-deepagents-fixture";
import type { McpBridgeEntry } from "../../state/registry";
import {
  buildDeepAgentsMcpRegisterCommand,
  buildDeepAgentsMcpRemoveCommand,
} from "./mcp-bridge-adapter-deepagents";
import {
  DEEPAGENTS_MCP_MAX_SERVERS,
  DEEPAGENTS_UNSAFE_MCP_PROJECTION_TYPES,
} from "./mcp-bridge-adapter-deepagents-projection";
import {
  buildDeepAgentsMcpStatusCommand,
  parseUnsafeDeepAgentsMcpProjectionResult,
  UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX,
} from "./mcp-bridge-adapter-status";

const emptyProjection = { mcpServers: {} };
const duplicateProjection = '{"mcpServers":{},"mcpServers":{"shadow":{}}}\n';
const attackerProjection = '{"mcpServers":{"attacker":{"type":"stdio"}}}\n';

const registrationCommand = buildDeepAgentsMcpRegisterCommand(baseEntry);
const rollbackCommand = buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true);
const removalCommand = buildDeepAgentsMcpRemoveCommand(baseEntry);

describe("Deep Agents managed MCP projection safety", () => {
  it.each([
    { mutation: "registration", command: registrationCommand },
    { mutation: "rollback", command: rollbackCommand },
    { mutation: "removal", command: removalCommand },
  ])("uses one stable-read contract for $mutation", ({ command }) => {
    expect(command).toContain("os.O_NOFOLLOW");
    expect(command).toContain("os.fstat(descriptor)");
    expect(command).toContain("assert_managed_source_stable(path, identity)");
    expect(command).toContain("os.link(tmp_name, path, follow_symlinks=False)");
    expect(command).toContain("os.ftruncate(descriptor, 0)");
    expect(command).not.toContain("\n    path.unlink()\n");
    expect(command).not.toContain("config_path.read_text");
  });

  it("uses the isolated runtime and bounds registration before mutation", () => {
    expect(registrationCommand).toMatch(/^\/opt\/venv\/bin\/python3 -I - <<'PY'/);
    expect(buildDeepAgentsMcpStatusCommand(baseEntry)).toMatch(
      /^\/opt\/venv\/bin\/python3 -I - <<'PY'/,
    );
    expect(rollbackCommand).toContain(
      `len(payload['expectedServers']) > ${String(DEEPAGENTS_MCP_MAX_SERVERS)}`,
    );
    const sizeCheckIndex = registrationCommand.indexOf("len(payload) > MANAGED_MCP_MAX_BYTES");
    const truncateIndex = registrationCommand.indexOf("os.ftruncate(descriptor, 0)");
    expect(sizeCheckIndex).toBeGreaterThanOrEqual(0);
    expect(truncateIndex).toBeGreaterThanOrEqual(0);
    expect(sizeCheckIndex).toBeLessThan(truncateIndex);
  });

  it.each(DEEPAGENTS_UNSAFE_MCP_PROJECTION_TYPES)(
    "uses the shared %s classification in the command and result parser",
    (type) => {
      const path = "/sandbox/.deepagents/.nemoclaw-mcp.json";
      const detail = `${UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX}: ${type} at ${path}`;

      expect(buildDeepAgentsMcpStatusCommand(baseEntry)).toContain(JSON.stringify(type));
      expect(
        parseUnsafeDeepAgentsMcpProjectionResult({ status: 2, stdout: "", stderr: detail }),
      ).toEqual({ messagePrefix: `${UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX}: ${type} at `, path });
    },
  );

  it("applies the shared server cap before normal and rollback v2 publication", () => {
    const entries = Array.from(
      { length: DEEPAGENTS_MCP_MAX_SERVERS + 1 },
      (_, index): McpBridgeEntry => ({
        ...baseEntry,
        server: `server${String(index)}`,
        env: [`SERVER_${String(index)}_TOKEN`],
      }),
    );

    expect(() => buildDeepAgentsMcpRegisterCommand(entries[0], false, entries)).toThrow(
      `at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers`,
    );
    const rollback = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpRegisterCommand(entries[0], true, entries, true),
    );
    expect(rollback.status).toBe(2);
    expect(rollback.stderr).toContain(
      `supports at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers`,
    );
  });

  it.each([
    {
      name: "a dangling symbolic link",
      config: undefined,
      options: { symlink: true },
      type: "symbolic link",
      targetText: null,
    },
    {
      name: "a symbolic link to valid content",
      config: emptyProjection,
      options: { symlink: true },
      type: "symbolic link",
      targetText: `${JSON.stringify(emptyProjection, null, 2)}\n`,
    },
    {
      name: "a FIFO",
      config: undefined,
      options: { fifo: true },
      type: "FIFO",
      targetText: null,
    },
    {
      name: "a directory",
      config: undefined,
      options: { directory: true },
      type: "non-regular file",
      targetText: null,
    },
  ])("rejects $name during status inspection (#10754)", ({ config, options, type, targetText }) => {
    const statusCommand = buildDeepAgentsMcpStatusCommand(baseEntry);
    const result = runDeepAgentsConfigCommand(
      statusCommand,
      config,
      "v2",
      undefined,
      0o600,
      options,
    );
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(`Unsafe managed Deep Agents MCP projection path: ${type}`);
    expect(result.managedSymlinkTargetText).toBe(targetText);
  });

  it.each([
    ["registration", registrationCommand],
    ["v2 rollback", rollbackCommand],
  ])("rejects duplicate JSON and unsafe projection metadata during %s", (_name, command) => {
    const duplicate = runDeepAgentsConfigCommand(command, duplicateProjection);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("duplicate JSON key: mcpServers");
    expect(duplicate.configText).toBe(duplicateProjection);

    const unsafeMode = runDeepAgentsConfigCommand(
      command,
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { mode: 0o644 },
    );
    expect(unsafeMode.status).toBe(2);
    expect(unsafeMode.stderr).toContain("unsafe ownership, mode, type, links, or path identity");
    expect(unsafeMode.config).toEqual(emptyProjection);

    const symlink = runDeepAgentsConfigCommand(command, emptyProjection, "v2", undefined, 0o600, {
      symlink: true,
    });
    expect(symlink.status).toBe(2);
    expect(symlink.managedSymlinkTargetText).toBe(`${JSON.stringify(emptyProjection, null, 2)}\n`);
  });

  it("never clobbers a projection that appears during absent publication or fd rewrite", () => {
    const absentRace = registrationCommand.replace(
      "    write_managed_projection(config_path, data, source_identity, source_descriptor)",
      `    config_path.write_text(${JSON.stringify(attackerProjection)}, encoding='utf-8')\n    os.chmod(config_path, 0o600)\n    write_managed_projection(config_path, data, source_identity, source_descriptor)`,
    );
    const absentResult = runDeepAgentsConfigCommand(absentRace);
    expect(absentResult.status).toBe(2);
    expect(absentResult.stderr).toContain("appeared during mutation");
    expect(absentResult.configText).toBe(attackerProjection);

    const existingRace = registrationCommand.replace(
      "    payload = managed_projection_bytes(value)\n    os.lseek(descriptor, 0, os.SEEK_SET)",
      `    payload = managed_projection_bytes(value)\n    path.unlink()\n    path.write_text(${JSON.stringify(attackerProjection)}, encoding='utf-8')\n    os.chmod(path, 0o600)\n    os.lseek(descriptor, 0, os.SEEK_SET)`,
    );
    const existingResult = runDeepAgentsConfigCommand(existingRace, emptyProjection);
    expect(existingResult.status).toBe(2);
    expect(existingResult.stderr).toContain("links, or path identity");
    expect(existingResult.configText).toBe(attackerProjection);
  });

  it("keeps forced removal identity-bound for malformed files and symlinks", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
    const racedCommand = forcedCommand.replace(
      "    payload = managed_projection_bytes(value)\n    os.lseek(descriptor, 0, os.SEEK_SET)",
      `    payload = managed_projection_bytes(value)\n    path.unlink()\n    path.write_text(${JSON.stringify(attackerProjection)}, encoding='utf-8')\n    os.chmod(path, 0o600)\n    os.lseek(descriptor, 0, os.SEEK_SET)`,
    );
    const raced = runDeepAgentsConfigCommand(racedCommand, { ui: { theme: "dark" } });
    expect(raced.status).toBe(2);
    expect(raced.stderr).toContain("Refusing unsafe managed MCP v2 repair");
    expect(raced.stderr).not.toContain("Traceback");
    expect(raced.configText).toBe(attackerProjection);

    const forcedSymlink = runDeepAgentsConfigCommand(
      forcedCommand,
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { symlink: true },
    );
    expect(forcedSymlink.status).toBe(2);
    expect(forcedSymlink.configExists).toBe(true);
    expect(forcedSymlink.managedSymlinkTargetExists).toBe(true);
    expect(forcedSymlink.managedSymlinkTargetText).toBe(
      `${JSON.stringify(emptyProjection, null, 2)}\n`,
    );

    const forcedUnsafeMode = runDeepAgentsConfigCommand(
      forcedCommand,
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { mode: 0o644 },
    );
    expect(forcedUnsafeMode.status).toBe(2);
    expect(forcedUnsafeMode.config).toEqual(emptyProjection);

    const forcedFifo = runDeepAgentsConfigCommand(
      forcedCommand,
      undefined,
      "v2",
      undefined,
      0o600,
      { fifo: true },
    );
    expect(forcedFifo.status).toBe(2);
    expect(forcedFifo.configExists).toBe(true);

    const duplicate = runDeepAgentsConfigCommand(removalCommand, duplicateProjection);
    expect(duplicate.status).toBe(2);
    expect(duplicate.configText).toBe(duplicateProjection);

    const forcedDuplicate = runDeepAgentsConfigCommand(forcedCommand, duplicateProjection);
    expect(forcedDuplicate.status, forcedDuplicate.stderr).toBe(0);
    expect(forcedDuplicate.config).toEqual(emptyProjection);
  });
});
