// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  finalizeRebuildPostRestore,
  type RebuildPostRestoreFinalizationOptions,
  resetRebuildShieldsStateAfterRecreate,
} from "./rebuild-finalization";

function options(
  overrides: Partial<RebuildPostRestoreFinalizationOptions> = {},
): RebuildPostRestoreFinalizationOptions {
  return {
    sandboxName: "alpha",
    agentExpectedVersion: "2026.6.10",
    reportedVersion: "2026.6.10",
    rebuiltAgentName: "OpenClaw",
    restoredPresets: ["github"],
    failedPresets: [],
    rebuildMessagingPlan: null,
    restoreSucceeded: true,
    mutablePermsRepairUnverified: false,
    mutableConfigHashRefreshUnverified: false,
    staleRecovery: false,
    backup: { backupPath: "/tmp/alpha-backup" },
    recoveryRecreate: false,
    staleSandboxWasLocked: false,
    preparedBackupRecovery: false,
    relockShields: vi.fn(() => true),
    log: vi.fn(),
    bail: vi.fn((message: string) => {
      throw new Error(message);
    }),
    ...overrides,
  };
}

describe("resetRebuildShieldsStateAfterRecreate", () => {
  it("clears prior shields state only after a recovery recreate succeeds", () => {
    const clearShieldsState = vi.fn();

    resetRebuildShieldsStateAfterRecreate("alpha", false, { clearShieldsState });
    resetRebuildShieldsStateAfterRecreate("alpha", true, { clearShieldsState });

    expect(clearShieldsState).toHaveBeenCalledOnce();
    expect(clearShieldsState).toHaveBeenCalledWith("alpha");
  });
});

describe("finalizeRebuildPostRestore", () => {
  it("reconciles policy state, relocks, and verifies forwarding in order", () => {
    const calls: string[] = [];
    const updateSandbox = vi.fn(() => {
      calls.push("registry");
      return true;
    });
    const log = vi.fn(() => calls.push("log"));
    const relockShields = vi.fn(() => {
      calls.push("relock");
      return true;
    });
    const ensureMessagingHostForward = vi.fn(() => {
      calls.push("forward");
      return true;
    });
    const writeLine = vi.fn((message: string) => calls.push(`write:${message}`));

    const input = options({ relockShields, log, preparedBackupRecovery: true });
    const result = finalizeRebuildPostRestore(input, {
      updateSandbox,
      ensureMessagingHostForward,
      writeLine,
    });

    expect(calls.slice(0, 4)).toEqual(["registry", "log", "relock", "forward"]);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      agentVersion: "2026.6.10",
      policies: ["github"],
    });
    expect(writeLine.mock.calls.flat().join("\n")).toContain(
      "Sandbox 'alpha' rebuilt successfully",
    );
    expect(result).toEqual({
      postRestoreComplete: true,
      messagingHostForwardUnverified: false,
    });
    expect(input.bail).not.toHaveBeenCalled();
  });

  it("bails after a failed relock without attempting host forwarding", () => {
    const ensureMessagingHostForward = vi.fn(() => true);

    expect(() =>
      finalizeRebuildPostRestore(options({ relockShields: () => false }), {
        updateSandbox: vi.fn(),
        ensureMessagingHostForward,
      }),
    ).toThrow("Failed to re-apply shields lockdown.");
    expect(ensureMessagingHostForward).not.toHaveBeenCalled();
  });

  it("reports every incomplete recovery dimension and the stale shields warning", () => {
    const writeLine = vi.fn();

    const result = finalizeRebuildPostRestore(
      options({
        failedPresets: ["messaging-telegram"],
        restoreSucceeded: false,
        mutablePermsRepairUnverified: true,
        mutableConfigHashRefreshUnverified: true,
        recoveryRecreate: true,
        staleSandboxWasLocked: true,
      }),
      {
        updateSandbox: vi.fn(),
        ensureMessagingHostForward: () => false,
        writeLine,
      },
    );

    const output = writeLine.mock.calls.flat().join("\n");
    expect(output).toContain("State restore was incomplete");
    expect(output).toContain("Mutable config permissions were not verified");
    expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
    expect(output).toContain("Messaging webhook forward was not verified");
    expect(output).toContain("Policy presets failed to reapply: messaging-telegram");
    expect(output).toContain("Shields were previously enabled");
    const orderedFragments = [
      "State restore was incomplete",
      "Mutable config permissions were not verified",
      "Mutable OpenClaw config hash was not refreshed",
      "Messaging webhook forward was not verified",
      "Policy presets failed to reapply",
      "Shields were previously enabled",
    ];
    const fragmentOffsets = orderedFragments.map((fragment) => output.indexOf(fragment));
    expect(fragmentOffsets).toEqual([...fragmentOffsets].sort((left, right) => left - right));
    expect(result).toEqual({
      postRestoreComplete: false,
      messagingHostForwardUnverified: true,
    });
  });

  it("fails closed when prepared recovery finishes with unverified state", () => {
    const events: string[] = [];
    const writeLine = vi.fn((message: string) => events.push(`write:${message}`));
    const bail = vi.fn((message: string): never => {
      events.push(`bail:${message}`);
      throw new Error(message);
    });

    expect(() =>
      finalizeRebuildPostRestore(
        options({
          preparedBackupRecovery: true,
          mutablePermsRepairUnverified: true,
          recoveryRecreate: true,
          staleSandboxWasLocked: true,
          bail,
        }),
        {
          updateSandbox: vi.fn(),
          ensureMessagingHostForward: () => true,
          writeLine,
        },
      ),
    ).toThrow("Prepared backup recovery for 'alpha' completed with unverified post-restore state.");
    expect(events.at(-1)).toContain("bail:Prepared backup recovery");
    expect(events.at(-2)).toContain("Shields were previously enabled");
  });

  it("reports stale recovery success without backup state", () => {
    const writeLine = vi.fn();

    finalizeRebuildPostRestore(options({ staleRecovery: true, backup: null }), {
      updateSandbox: vi.fn(),
      ensureMessagingHostForward: () => true,
      writeLine,
    });

    expect(writeLine.mock.calls.flat().join("\n")).toContain(
      "Recovered from a stale registry entry",
    );
  });
});
