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
import { DEEPAGENTS_MCP_MAX_SERVERS } from "./mcp-bridge-adapter-deepagents-projection";
import { buildDeepAgentsMcpStatusCommand } from "./mcp-bridge-adapter-status";

const emptyProjection = { mcpServers: {} };
const duplicateProjection = '{"mcpServers":{},"mcpServers":{"shadow":{}}}\n';
const attackerProjection = '{"mcpServers":{"attacker":{"type":"stdio"}}}\n';
const managedCommandTimeoutMs = 30_000;

const registrationCommand = buildDeepAgentsMcpRegisterCommand(baseEntry);
const rollbackCommand = buildDeepAgentsMcpRegisterCommand(baseEntry, true, [baseEntry], true);
const removalCommand = buildDeepAgentsMcpRemoveCommand(baseEntry);

describe("Deep Agents managed MCP projection safety", () => {
  it(
    "applies the shared server cap before normal and rollback v2 publication",
    { timeout: 60_000 },
    () => {
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
        undefined,
        "v2",
        undefined,
        0o600,
        { timeoutMs: managedCommandTimeoutMs },
      );
      expect(rollback.status).toBe(2);
      expect(rollback.stderr).toContain(
        `supports at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers`,
      );
    },
  );

  it(
    "names unsafe projection types without following hostile paths (#10754)",
    { timeout: 60_000 },
    () => {
      const statusCommand = buildDeepAgentsMcpStatusCommand(baseEntry);
      const symlink = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { symlink: true, timeoutMs: managedCommandTimeoutMs },
      );
      expect(symlink.status).toBe(2);
      expect(symlink.stdout.trim()).toBe("");
      expect(symlink.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );
      expect(symlink.managedSymlinkTargetText).toBe(
        `${JSON.stringify(emptyProjection, null, 2)}\n`,
      );

      const fifo = runDeepAgentsConfigCommand(statusCommand, undefined, "v2", undefined, 0o600, {
        fifo: true,
        timeoutMs: managedCommandTimeoutMs,
      });
      expect(fifo.status).toBe(2);
      expect(fifo.stdout.trim()).toBe("");
      expect(fifo.stderr).toContain("Unsafe managed Deep Agents MCP projection path: FIFO");

      const directory = runDeepAgentsConfigCommand(
        statusCommand,
        undefined,
        "v2",
        undefined,
        0o600,
        {
          directory: true,
          timeoutMs: managedCommandTimeoutMs,
        },
      );
      expect(directory.status).toBe(2);
      expect(directory.stdout.trim()).toBe("");
      expect(directory.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: non-regular file",
      );

      const danglingSymlink = runDeepAgentsConfigCommand(
        statusCommand,
        undefined,
        "v2",
        undefined,
        0o600,
        { danglingSymlink: true, timeoutMs: managedCommandTimeoutMs },
      );
      expect(danglingSymlink.status).toBe(2);
      expect(danglingSymlink.stdout.trim()).toBe("");
      expect(danglingSymlink.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );

      const racedSymlink = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapOnManagedOpen: "symlink", timeoutMs: managedCommandTimeoutMs },
      );
      expect(racedSymlink.status).toBe(2);
      expect(racedSymlink.stdout.trim()).toBe("");
      expect(racedSymlink.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );
      expect(racedSymlink.configIsSymlink).toBe(true);
      expect(racedSymlink.managedSymlinkTargetText).toBe(
        `${JSON.stringify(emptyProjection, null, 2)}\n`,
      );

      const racedFifo = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapOnManagedOpen: "fifo", timeoutMs: managedCommandTimeoutMs },
      );
      expect(racedFifo.status).toBe(2);
      expect(racedFifo.stdout.trim()).toBe("");
      expect(racedFifo.stderr).toContain("Unsafe managed Deep Agents MCP projection path: FIFO");
      expect(racedFifo.configIsFifo).toBe(true);

      const racedSocket = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapOnManagedOpen: "socket", timeoutMs: managedCommandTimeoutMs },
      );
      expect(racedSocket.status).toBe(2);
      expect(racedSocket.stdout.trim()).toBe("");
      expect(racedSocket.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: non-regular file",
      );
      expect(racedSocket.configIsSocket).toBe(true);

      const replacedAfterOpenWithSymlink = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapAfterManagedOpen: "symlink", timeoutMs: managedCommandTimeoutMs },
      );
      expect(replacedAfterOpenWithSymlink.status).toBe(2);
      expect(replacedAfterOpenWithSymlink.stdout.trim()).toBe("");
      expect(replacedAfterOpenWithSymlink.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );
      expect(replacedAfterOpenWithSymlink.configIsSymlink).toBe(true);
      expect(replacedAfterOpenWithSymlink.managedSymlinkTargetText).toBe(
        `${JSON.stringify(emptyProjection, null, 2)}\n`,
      );

      const replacedAfterOpenWithFifo = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapAfterManagedOpen: "fifo", timeoutMs: managedCommandTimeoutMs },
      );
      expect(replacedAfterOpenWithFifo.status).toBe(2);
      expect(replacedAfterOpenWithFifo.stdout.trim()).toBe("");
      expect(replacedAfterOpenWithFifo.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: FIFO",
      );
      expect(replacedAfterOpenWithFifo.configIsFifo).toBe(true);

      const replacedWhileReadingWithSymlink = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapOnManagedRead: "symlink", timeoutMs: managedCommandTimeoutMs },
      );
      expect(replacedWhileReadingWithSymlink.status).toBe(2);
      expect(replacedWhileReadingWithSymlink.stdout.trim()).toBe("");
      expect(replacedWhileReadingWithSymlink.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );
      expect(replacedWhileReadingWithSymlink.configIsSymlink).toBe(true);
      expect(replacedWhileReadingWithSymlink.managedSymlinkTargetText).toBe(
        `${JSON.stringify(emptyProjection, null, 2)}\n`,
      );

      const replacedAfterEloop = runDeepAgentsConfigCommand(
        statusCommand,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        {
          statAfterManagedEloopAsRegular: true,
          symlink: true,
          timeoutMs: managedCommandTimeoutMs,
        },
      );
      expect(replacedAfterEloop.status).toBe(2);
      expect(replacedAfterEloop.stdout.trim()).toBe("");
      expect(replacedAfterEloop.stderr).toContain(
        "Unsafe managed Deep Agents MCP projection path: symbolic link",
      );
      expect(replacedAfterEloop.configIsSymlink).toBe(true);
      expect(replacedAfterEloop.managedSymlinkTargetText).toBe(
        `${JSON.stringify(emptyProjection, null, 2)}\n`,
      );
    },
  );

  it.each([
    {
      appearedType: "symlink" as const,
      diagnostic: "symbolic link",
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: `${JSON.stringify(emptyProjection, null, 2)}\n`,
    },
    {
      appearedType: "fifo" as const,
      diagnostic: "FIFO",
      expectedConfigIsFifo: true,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
    },
  ])(
    "classifies a $diagnostic that appears after a missing-path open (#10754)",
    ({
      appearedType,
      diagnostic,
      expectedConfigIsFifo,
      expectedConfigIsSymlink,
      expectedTargetText,
    }) => {
      const result = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpStatusCommand(baseEntry),
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapAfterMissingManagedOpen: appearedType, timeoutMs: managedCommandTimeoutMs },
      );

      expect(result.status).toBe(2);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain(
        `Unsafe managed Deep Agents MCP projection path: ${diagnostic}`,
      );
      expect(result.configIsFifo).toBe(expectedConfigIsFifo);
      expect(result.configIsSymlink).toBe(expectedConfigIsSymlink);
      expect(result.managedSymlinkTargetText).toBe(expectedTargetText);
    },
  );

  it("rejects a symlinked projection parent without reading its target (#10754)", () => {
    const initialText = `${JSON.stringify(emptyProjection, null, 2)}\n`;
    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { parentSymlink: true },
    );
    expect(status.status).toBe(2);
    expect(status.stdout.trim()).toBe("");
    expect(status.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: symbolic link",
    );
    expect(status.managedParentIsSymlink).toBe(true);
    expect(status.managedParentTargetText).toBe(initialText);
  });

  it.each([
    ["registration", registrationCommand],
    ["forced removal", buildDeepAgentsMcpRemoveCommand(baseEntry, true)],
  ])(
    "rejects a symlinked projection parent during %s without mutating its target (#10754)",
    (_operation, command) => {
      const initialText = `${JSON.stringify(emptyProjection, null, 2)}\n`;
      const mutation = runDeepAgentsConfigCommand(
        command,
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { parentSymlink: true },
      );
      expect(mutation.status).toBe(2);
      expect(mutation.managedParentIsSymlink).toBe(true);
      expect(mutation.managedParentTargetText).toBe(initialText);
    },
  );

  it("keeps the generic diagnostic for ordinary projection inspection failures (#10754)", () => {
    const result = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      '{"mcpServers":',
    );

    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("Could not inspect managed Deep Agents MCP state");
    expect(result.stderr).toContain("Expecting value");
    expect(result.stderr).not.toContain("Traceback");
    expect(result.configText).toBe('{"mcpServers":');
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
    const absentResult = runDeepAgentsConfigCommand(
      registrationCommand,
      undefined,
      "v2",
      undefined,
      0o600,
      { swapBeforeManagedLink: attackerProjection, timeoutMs: managedCommandTimeoutMs },
    );
    expect(absentResult.status).toBe(2);
    expect(absentResult.stderr).toContain("appeared during publication");
    expect(absentResult.configText).toBe(attackerProjection);

    const existingResult = runDeepAgentsConfigCommand(
      registrationCommand,
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { swapOnManagedSeek: attackerProjection, timeoutMs: managedCommandTimeoutMs },
    );
    expect(existingResult.status).toBe(2);
    expect(existingResult.stderr).toContain("links, or path identity");
    expect(existingResult.configText).toBe(attackerProjection);
  });

  it("keeps forced removal identity-bound during a descriptor rewrite (#10754)", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
    const raced = runDeepAgentsConfigCommand(
      forcedCommand,
      { ui: { theme: "dark" } },
      "v2",
      undefined,
      0o600,
      { swapOnManagedSeek: attackerProjection, timeoutMs: managedCommandTimeoutMs },
    );
    expect(raced.status).toBe(2);
    expect(raced.stderr).toContain("Refusing unsafe managed MCP v2 repair");
    expect(raced.stderr).not.toContain("Traceback");
    expect(raced.configText).toBe(attackerProjection);
  });

  it("keeps forced removal identity-bound for malformed files and symlinks", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
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
