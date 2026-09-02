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
      caseName: "symbolic link",
      diagnostic: "symbolic link",
      expectedConfigIsDirectory: false,
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: `${JSON.stringify(emptyProjection, null, 2)}\n`,
      initialConfig: emptyProjection,
      options: { symlink: true },
    },
    {
      caseName: "FIFO",
      diagnostic: "FIFO",
      expectedConfigIsDirectory: false,
      expectedConfigIsFifo: true,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      initialConfig: undefined,
      options: { fifo: true },
    },
    {
      caseName: "directory",
      diagnostic: "non-regular file",
      expectedConfigIsDirectory: true,
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      initialConfig: undefined,
      options: { directory: true },
    },
    {
      caseName: "dangling symbolic link",
      diagnostic: "symbolic link",
      expectedConfigIsDirectory: false,
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: null,
      initialConfig: undefined,
      options: { danglingSymlink: true },
    },
  ])(
    "rejects an existing $caseName projection path without following it (#10754)",
    ({
      diagnostic,
      expectedConfigIsDirectory,
      expectedConfigIsFifo,
      expectedConfigIsSymlink,
      expectedTargetText,
      initialConfig,
      options,
    }) => {
      const result = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpStatusCommand(baseEntry),
        initialConfig,
        "v2",
        undefined,
        0o600,
        { ...options, timeoutMs: managedCommandTimeoutMs },
      );
      expect(result.status).toBe(2);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain(
        `Unsafe managed Deep Agents MCP projection path: ${diagnostic}`,
      );
      expect(result.configIsDirectory).toBe(expectedConfigIsDirectory);
      expect(result.configIsFifo).toBe(expectedConfigIsFifo);
      expect(result.configIsSymlink).toBe(expectedConfigIsSymlink);
      expect(result.managedSymlinkTargetText).toBe(expectedTargetText);
    },
  );

  it.each([
    {
      diagnostic: "symbolic link",
      expectedConfigIsFifo: false,
      expectedConfigIsSocket: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: `${JSON.stringify(emptyProjection, null, 2)}\n`,
      replacementType: "symlink" as const,
    },
    {
      diagnostic: "FIFO",
      expectedConfigIsFifo: true,
      expectedConfigIsSocket: false,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      replacementType: "fifo" as const,
    },
    {
      diagnostic: "non-regular file",
      expectedConfigIsFifo: false,
      expectedConfigIsSocket: true,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      replacementType: "socket" as const,
    },
  ])(
    "rejects a $replacementType replacement before projection open (#10754)",
    ({
      diagnostic,
      expectedConfigIsFifo,
      expectedConfigIsSocket,
      expectedConfigIsSymlink,
      expectedTargetText,
      replacementType,
    }) => {
      const result = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpStatusCommand(baseEntry),
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapOnManagedOpen: replacementType, timeoutMs: managedCommandTimeoutMs },
      );
      expect(result.status).toBe(2);
      expect(result.stdout.trim()).toBe("");
      expect(result.stderr).toContain(
        `Unsafe managed Deep Agents MCP projection path: ${diagnostic}`,
      );
      expect(result.configIsFifo).toBe(expectedConfigIsFifo);
      expect(result.configIsSocket).toBe(expectedConfigIsSocket);
      expect(result.configIsSymlink).toBe(expectedConfigIsSymlink);
      expect(result.managedSymlinkTargetText).toBe(expectedTargetText);
    },
  );

  it.each([
    {
      diagnostic: "symbolic link",
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: `${JSON.stringify(emptyProjection, null, 2)}\n`,
      replacementType: "symlink" as const,
    },
    {
      diagnostic: "FIFO",
      expectedConfigIsFifo: true,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      replacementType: "fifo" as const,
    },
  ])(
    "rejects a $replacementType replacement after projection open (#10754)",
    ({
      diagnostic,
      expectedConfigIsFifo,
      expectedConfigIsSymlink,
      expectedTargetText,
      replacementType,
    }) => {
      const result = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpStatusCommand(baseEntry),
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { swapAfterManagedOpen: replacementType, timeoutMs: managedCommandTimeoutMs },
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

  it("rejects a symbolic-link replacement while reading the projection (#10754)", () => {
    const result = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { swapOnManagedRead: "symlink", timeoutMs: managedCommandTimeoutMs },
    );
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: symbolic link",
    );
    expect(result.configIsSymlink).toBe(true);
    expect(result.managedSymlinkTargetText).toBe(`${JSON.stringify(emptyProjection, null, 2)}\n`);
  });

  it("preserves conclusive ELOOP classification across a follow-up path swap (#10754)", () => {
    const result = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
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
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: symbolic link",
    );
    expect(result.configIsSymlink).toBe(true);
    expect(result.managedSymlinkTargetText).toBe(`${JSON.stringify(emptyProjection, null, 2)}\n`);
  });

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
    ({ appearedType, diagnostic }) => {
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
      expect(appearedType === "symlink" ? result.configIsSymlink : result.configIsFifo).toBe(true);
      expect(result.managedSymlinkTargetText).toBe(
        appearedType === "symlink" ? `${JSON.stringify(emptyProjection, null, 2)}\n` : null,
      );
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

  it("keeps forced removal identity-bound for malformed and unsafe projections", () => {
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
    expect(forcedFifo.configIsFifo).toBe(true);

    const duplicate = runDeepAgentsConfigCommand(removalCommand, duplicateProjection);
    expect(duplicate.status).toBe(2);
    expect(duplicate.configText).toBe(duplicateProjection);

    const forcedDuplicate = runDeepAgentsConfigCommand(forcedCommand, duplicateProjection);
    expect(forcedDuplicate.status, forcedDuplicate.stderr).toBe(0);
    expect(forcedDuplicate.config).toEqual(emptyProjection);
  });
});
