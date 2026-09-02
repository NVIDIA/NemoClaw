// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  baseEntry,
  isSafeManagedProjectionRaceResult,
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
const emptyProjectionText = `${JSON.stringify(emptyProjection, null, 2)}\n`;
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
    "rejects an existing $caseName projection path (#10754)",
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

  it("rejects a projection symlink without reading its target (#10754)", () => {
    const result = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "v2",
      undefined,
      0o600,
      { symlink: true, targetReadProbe: true, timeoutMs: managedCommandTimeoutMs },
    );
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: symbolic link",
    );
    expect(result.managedSymlinkTargetExists).toBe(true);
    expect(result.managedTargetReadAccessed).toBe(false);
  });

  it("rejects an existing socket projection path (#10754)", () => {
    const result = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "v2",
      undefined,
      0o600,
      { socket: true, timeoutMs: managedCommandTimeoutMs },
    );
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: non-regular file",
    );
    expect(result.configIsSocket).toBe(true);
  });

  it.each([
    {
      expectedConfigIsFifo: false,
      expectedConfigIsSymlink: true,
      expectedTargetText: emptyProjectionText,
      raceProjection: "symlink" as const,
    },
    {
      expectedConfigIsFifo: true,
      expectedConfigIsSymlink: false,
      expectedTargetText: null,
      raceProjection: "fifo" as const,
    },
  ])(
    "rejects or safely loses a concurrent $raceProjection projection race (#10754)",
    { timeout: 60_000 },
    ({ expectedConfigIsFifo, expectedConfigIsSymlink, expectedTargetText, raceProjection }) => {
      const result = runDeepAgentsConfigCommand(
        buildDeepAgentsMcpStatusCommand(baseEntry),
        emptyProjection,
        "v2",
        undefined,
        0o600,
        { raceProjection, timeoutMs: managedCommandTimeoutMs },
      );

      expect(result.managedRaceIterations).toBeGreaterThan(0);
      expect(isSafeManagedProjectionRaceResult(result)).toBe(true);
      expect(result.configIsSymlink).toBe(expectedConfigIsSymlink);
      expect(result.configIsFifo).toBe(expectedConfigIsFifo);
      expect(result.managedSymlinkTargetText).toBe(expectedTargetText);
    },
  );

  it("rejects a symlinked projection parent without reading its target (#10754)", () => {
    const status = runDeepAgentsConfigCommand(
      buildDeepAgentsMcpStatusCommand(baseEntry),
      undefined,
      "v2",
      undefined,
      0o600,
      { parentSymlink: true, targetReadProbe: true, timeoutMs: managedCommandTimeoutMs },
    );
    expect(status.status).toBe(2);
    expect(status.stdout.trim()).toBe("");
    expect(status.stderr).toContain(
      "Unsafe managed Deep Agents MCP projection path: symbolic link",
    );
    expect(status.managedParentIsSymlink).toBe(true);
    expect(status.managedTargetReadAccessed).toBe(false);
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
  ])("rejects duplicate JSON during %s", (_name, command) => {
    const duplicate = runDeepAgentsConfigCommand(command, duplicateProjection);
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain("duplicate JSON key: mcpServers");
    expect(duplicate.configText).toBe(duplicateProjection);
  });

  it.each([
    ["registration", registrationCommand],
    ["v2 rollback", rollbackCommand],
  ])("rejects an unsafe projection mode during %s", (_name, command) => {
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
  });

  it.each([
    ["registration", registrationCommand],
    ["v2 rollback", rollbackCommand],
  ])("rejects a projection symlink during %s without mutating its target", (_name, command) => {
    const symlink = runDeepAgentsConfigCommand(command, emptyProjection, "v2", undefined, 0o600, {
      symlink: true,
    });
    expect(symlink.status).toBe(2);
    expect(symlink.managedSymlinkTargetText).toBe(`${JSON.stringify(emptyProjection, null, 2)}\n`);
  });

  it(
    "preserves a projection that appears during absent publication (#10754)",
    { timeout: 60_000 },
    () => {
      const absentResult = runDeepAgentsConfigCommand(
        registrationCommand,
        undefined,
        "v2",
        undefined,
        0o600,
        { raceAbsentPublication: attackerProjection, timeoutMs: managedCommandTimeoutMs },
      );
      expect(absentResult.managedRaceIterations).toBeGreaterThan(0);
      expect(absentResult.status).toBe(2);
      expect(absentResult.configIsSymlink).toBe(true);
      expect(absentResult.managedSymlinkTargetText).toBe(attackerProjection);
    },
  );

  it("preserves a replacement during a descriptor rewrite (#10754)", { timeout: 60_000 }, () => {
    const existingResult = runDeepAgentsConfigCommand(
      registrationCommand,
      emptyProjection,
      "v2",
      undefined,
      0o600,
      { raceProjection: "symlink", timeoutMs: managedCommandTimeoutMs },
    );
    expect(existingResult.managedRaceIterations).toBeGreaterThan(0);
    expect([0, 2]).toContain(existingResult.status);
    expect(existingResult.configIsSymlink).toBe(true);
    expect(existingResult.managedSymlinkTargetText).toBe(
      `${JSON.stringify(emptyProjection, null, 2)}\n`,
    );
  });

  it(
    "keeps forced removal identity-bound during a descriptor rewrite (#10754)",
    { timeout: 60_000 },
    () => {
      const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
      const raced = runDeepAgentsConfigCommand(
        forcedCommand,
        { ui: { theme: "dark" } },
        "v2",
        undefined,
        0o600,
        { raceProjection: "symlink", timeoutMs: managedCommandTimeoutMs },
      );
      expect(raced.managedRaceIterations).toBeGreaterThan(0);
      expect([0, 2]).toContain(raced.status);
      expect(raced.stderr).not.toContain("Traceback");
      expect(raced.configIsSymlink).toBe(true);
      expect(raced.managedSymlinkTargetText).toBe(
        `${JSON.stringify({ ui: { theme: "dark" } }, null, 2)}\n`,
      );
    },
  );

  it("preserves a projection symlink during forced removal", () => {
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
  });

  it("preserves an unsafe projection mode during forced removal", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
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
  });

  it("preserves a projection FIFO during forced removal", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
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
  });

  it("rejects duplicate projection JSON during ordinary removal", () => {
    const duplicate = runDeepAgentsConfigCommand(removalCommand, duplicateProjection);
    expect(duplicate.status).toBe(2);
    expect(duplicate.configText).toBe(duplicateProjection);
  });

  it("repairs duplicate projection JSON during forced removal", () => {
    const forcedCommand = buildDeepAgentsMcpRemoveCommand(baseEntry, true);
    const forcedDuplicate = runDeepAgentsConfigCommand(forcedCommand, duplicateProjection);
    expect(forcedDuplicate.status, forcedDuplicate.stderr).toBe(0);
    expect(forcedDuplicate.config).toEqual(emptyProjection);
  });
});
