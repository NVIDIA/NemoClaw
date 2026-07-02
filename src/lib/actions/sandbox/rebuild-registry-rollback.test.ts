// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry, SandboxRegistry } from "../../state/registry";
import { createRebuildRegistryRollback } from "./rebuild-registry-rollback";

function sandboxEntry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    imageTag: "nemoclaw/alpha:old",
    policies: ["github"],
    ...overrides,
  };
}

function registrySnapshot(entry: SandboxEntry, defaultSandbox: string | null): SandboxRegistry {
  return {
    sandboxes: { [entry.name]: entry },
    defaultSandbox,
  };
}

describe("createRebuildRegistryRollback", () => {
  it("restores the latest prepared snapshot with its default pointer exactly once", () => {
    const original = sandboxEntry({ model: "old-model" });
    const refreshed = sandboxEntry({ model: "refreshed-model" });
    let snapshot = registrySnapshot(original, "alpha");
    const restoreSandboxEntry = vi.fn();
    const restoreSandboxEntryIfMissing = vi.fn(() => true);
    const log = vi.fn();
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: true,
        staleRecovery: false,
        getRecoveryRegistrySnapshot: () => snapshot,
        log,
      },
      { restoreSandboxEntry, restoreSandboxEntryIfMissing },
    );
    rollback.recordRemoval({ entry: original });
    snapshot = registrySnapshot(refreshed, "alpha");

    rollback.restoreForRetry();
    rollback.restoreForRetry();

    expect(restoreSandboxEntry).toHaveBeenCalledOnce();
    expect(restoreSandboxEntry).toHaveBeenCalledWith(refreshed, { reclaimDefault: "alpha" });
    expect(restoreSandboxEntryIfMissing).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "Recovery recreate failed: restored preserved registry entry for retry",
    );
  });

  it("restores an ordinary removal receipt only when no replacement exists", () => {
    const removed = sandboxEntry({ customPolicies: [{ name: "custom", content: "allow" }] });
    const restoreSandboxEntryIfMissing = vi.fn(() => true);
    const log = vi.fn();
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: false,
        staleRecovery: false,
        getRecoveryRegistrySnapshot: () => null,
        log,
      },
      { restoreSandboxEntryIfMissing },
    );
    rollback.recordRemoval({ entry: removed });

    rollback.restoreForRetry();
    rollback.restoreForRetry();

    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledOnce();
    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledWith({ ...removed, imageTag: null });
    expect(log).toHaveBeenCalledWith("Recreate failed: restored registry metadata for retry");
  });

  it("keeps a replacement registered by failed onboarding", () => {
    const restoreSandboxEntryIfMissing = vi.fn(() => false);
    const log = vi.fn();
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: false,
        staleRecovery: true,
        getRecoveryRegistrySnapshot: () => null,
        log,
      },
      { restoreSandboxEntryIfMissing },
    );
    rollback.recordRemoval({ entry: sandboxEntry() });

    rollback.restoreForRetry();

    expect(log).toHaveBeenCalledWith(
      "Recreate failed: kept the replacement registry metadata already present",
    );
  });

  it("can restore after an early no-op and contains restore failures", () => {
    const restoreSandboxEntryIfMissing = vi.fn(() => {
      throw new Error("registry locked");
    });
    const log = vi.fn();
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: false,
        staleRecovery: true,
        getRecoveryRegistrySnapshot: () => null,
        log,
      },
      { restoreSandboxEntryIfMissing },
    );

    rollback.restoreForRetry();
    rollback.recordRemoval({ entry: sandboxEntry() });
    expect(() => rollback.restoreForRetry()).not.toThrow();
    rollback.restoreForRetry();

    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "Failed to restore registry metadata after recreate failure: Error: registry locked",
    );
  });
});
