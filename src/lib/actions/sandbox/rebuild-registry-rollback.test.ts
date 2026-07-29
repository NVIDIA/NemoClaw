// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry, SandboxRegistry, SandboxRemovalReceipt } from "../../state/registry";
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

function removalReceipt(
  entry: SandboxEntry,
  options: {
    wasDefault?: boolean;
    fallbackDefault?: string | null;
    postRemovalDefaultSelectionRevision?: number;
  } = {},
): SandboxRemovalReceipt {
  return {
    entry,
    wasDefault: options.wasDefault ?? true,
    fallbackDefault: options.fallbackDefault ?? "beta",
    postRemovalDefaultSelectionRevision: options.postRemovalDefaultSelectionRevision ?? 17,
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
    rollback.recordRemoval(removalReceipt(original));
    snapshot = registrySnapshot(refreshed, "alpha");

    rollback.restoreForRetry();
    rollback.restoreForRetry();

    expect(restoreSandboxEntry).toHaveBeenCalledOnce();
    expect(restoreSandboxEntry).toHaveBeenCalledWith(refreshed, {
      defaultTransition: { from: "beta", to: "alpha", expectedRevision: 17 },
    });
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
    rollback.recordRemoval(removalReceipt(removed));

    rollback.restoreForRetry();
    rollback.restoreForRetry();

    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledOnce();
    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledWith({
      entry: { ...removed, imageTag: null },
      wasDefault: true,
      fallbackDefault: "beta",
      postRemovalDefaultSelectionRevision: 17,
    });
    expect(log).toHaveBeenCalledWith("Recreate failed: restored registry metadata for retry");
  });

  it("preserves the image tag when restoring a shared managed workload receipt", () => {
    const removed = sandboxEntry({
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference: "ghcr.io/nvidia/nemoclaw-openclaw@sha256:managed",
        release: "v0.0.99",
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        sourceCohort: "ghrun-123456-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: "e30",
        startupProfileSha256: "beab987bef9c00dfc301b490ddb45321517e7d6a6bb3d31d259898b7d46393d8",
        credentialProxyReplayRequired: false,
        shared: true,
      },
    });
    const restoreSandboxEntryIfMissing = vi.fn(() => true);
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: false,
        staleRecovery: false,
        getRecoveryRegistrySnapshot: () => null,
        log: vi.fn(),
      },
      { restoreSandboxEntryIfMissing },
    );
    rollback.recordRemoval(removalReceipt(removed));

    rollback.restoreForRetry();

    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledWith({
      entry: removed,
      wasDefault: true,
      fallbackDefault: "beta",
      postRemovalDefaultSelectionRevision: 17,
    });
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
    rollback.recordRemoval(removalReceipt(sandboxEntry()));

    rollback.restoreForRetry();

    expect(log).toHaveBeenCalledWith(
      "Recreate failed: kept the replacement registry metadata already present",
    );
  });

  it("restores a stale-recovery snapshot when MCP kept the registry entry", () => {
    const original = sandboxEntry({ model: "preserved-model" });
    const restoreSandboxEntry = vi.fn();
    const restoreSandboxEntryIfMissing = vi.fn(() => true);
    const rollback = createRebuildRegistryRollback(
      {
        sandboxName: "alpha",
        preparedBackupRecovery: false,
        staleRecovery: true,
        getRecoveryRegistrySnapshot: () => registrySnapshot(original, "alpha"),
        log: vi.fn(),
      },
      { restoreSandboxEntry, restoreSandboxEntryIfMissing },
    );
    rollback.recordRemoval(null);

    rollback.restoreForRetry();

    expect(restoreSandboxEntry).toHaveBeenCalledWith(original, {});
    expect(restoreSandboxEntryIfMissing).not.toHaveBeenCalled();
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
    rollback.recordRemoval(removalReceipt(sandboxEntry()));
    expect(() => rollback.restoreForRetry()).not.toThrow();
    rollback.restoreForRetry();

    expect(restoreSandboxEntryIfMissing).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "Failed to restore registry metadata after recreate failure: Error: registry locked",
    );
  });
});
