// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_REPOSITORIES,
  type ShippedManagedImageAgent,
} from "../../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../../onboard/managed-startup/profile";
import type { RuntimeProviderBundle } from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import type { BackupOptions, BackupResult } from "../../../state/sandbox";
import { backupSandboxStateWithManagedAuthority } from "./backup-authority";

function workload(
  agent: ShippedManagedImageAgent,
  changedProfile = false,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(
    managedStartupE2eProfile(agent, changedProfile),
  );
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.88",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function sandbox(
  agent: ShippedManagedImageAgent,
  receipt: SandboxWorkloadReceipt = workload(agent),
): SandboxEntry {
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.kind === "managed-image" ? receipt.reference : null,
    fromDockerfile: null,
    workload: receipt,
  };
}

function runtime(handle = "session-1") {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    providerHandle: `opaque-${handle}`,
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle },
      acceleration: { kind: "none" },
    },
  } as const;
}

function provider(acceptsReceipt = true): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: "mxc", displayName: "MXC" },
    workload: {
      providerId: "mxc",
      supported: true,
      profile: {
        support: null,
        hostArchitectures: [],
        managedImageSelectionPolicy: "prefer-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => acceptsReceipt,
    },
  } as unknown as RuntimeProviderBundle;
}

function successfulBackup(options: BackupOptions): BackupResult {
  try {
    options.validateBeforePublish?.();
  } catch (error) {
    return {
      success: false,
      backedUpDirs: [],
      failedDirs: [],
      backedUpFiles: [],
      failedFiles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    success: true,
    manifest: {
      version: 1,
      sandboxName: "alpha",
      timestamp: "2026-07-31T00-00-00-000Z",
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      stateDirs: [],
      dir: "/sandbox",
      backupPath: "/tmp/alpha",
      blueprintDigest: null,
    },
    backedUpDirs: [],
    failedDirs: [],
    backedUpFiles: [],
    failedFiles: [],
  };
}

describe("managed snapshot backup authority", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("captures and republishes exact %s provider authority", (agent) => {
    const entry = sandbox(agent);
    const getSandbox = vi.fn(() => entry);
    const requireProvider = vi.fn(() => provider());
    const captureRuntime = vi.fn(() => runtime());
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));

    const result = backupSandboxStateWithManagedAuthority(
      "alpha",
      { name: "stable" },
      { getSandbox, requireProvider, captureRuntime, backup },
    );

    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        name: "stable",
        workload: entry.workload,
        runtimeSnapshot: runtime(),
        validateBeforePublish: expect.any(Function),
      }),
    );
    expect(getSandbox).toHaveBeenCalledTimes(2);
    expect(requireProvider).toHaveBeenCalledTimes(2);
    expect(captureRuntime).toHaveBeenCalledTimes(2);
  });

  it("keeps explicit Dockerfile backups on the legacy state-only path", () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "mxc",
      fromDockerfile: "/tmp/Dockerfile",
    } satisfies SandboxEntry;
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));
    const requireProvider = vi.fn();
    const captureRuntime = vi.fn();

    const result = backupSandboxStateWithManagedAuthority(
      "alpha",
      { name: "legacy" },
      {
        getSandbox: () => entry,
        requireProvider,
        captureRuntime: captureRuntime as never,
        backup,
      },
    );

    expect(result.success).toBe(true);
    expect(backup).toHaveBeenCalledWith("alpha", { name: "legacy" });
    expect(requireProvider).not.toHaveBeenCalled();
    expect(captureRuntime).not.toHaveBeenCalled();
  });

  it("fails before filesystem capture when the provider rejects managed authority", () => {
    const entry = sandbox("openclaw");
    const backup = vi.fn();

    const result = backupSandboxStateWithManagedAuthority(
      "alpha",
      {},
      {
        getSandbox: () => entry,
        requireProvider: () => provider(false),
        captureRuntime: vi.fn() as never,
        backup,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("does not accept the managed workload receipt"),
    });
    expect(backup).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "workload",
      secondEntry: sandbox("openclaw", workload("openclaw", true)),
      secondRuntime: runtime(),
      error: "managed workload changed during backup",
    },
    {
      label: "runtime",
      secondEntry: sandbox("openclaw"),
      secondRuntime: runtime("session-2"),
      error: "runtime changed during backup",
    },
  ])("rejects $label drift before manifest publication", ({
    secondEntry,
    secondRuntime,
    error,
  }) => {
    const initialEntry = sandbox("openclaw");
    const getSandbox = vi
      .fn<() => SandboxEntry | null>()
      .mockReturnValueOnce(initialEntry)
      .mockReturnValueOnce(secondEntry);
    const captureRuntime = vi
      .fn<() => ReturnType<typeof runtime>>()
      .mockReturnValueOnce(runtime())
      .mockReturnValueOnce(secondRuntime);
    const backup = vi.fn((_name: string, options: BackupOptions = {}) => successfulBackup(options));

    const result = backupSandboxStateWithManagedAuthority(
      "alpha",
      {},
      {
        getSandbox,
        requireProvider: () => provider(),
        captureRuntime: captureRuntime as (
          bundle: RuntimeProviderBundle,
          entry: SandboxEntry,
        ) => ReturnType<typeof runtime>,
        backup,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining(error),
    });
  });
});
