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
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
} from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../../state/registry/types";
import type {
  RebuildManifest,
  RecreatedSandboxRestoreOptions,
  RestoreResult,
} from "../../../state/sandbox";
import { restoreRecreatedSandboxStateWithManagedAuthority } from "./restore-authority";

function workload(
  agent: ShippedManagedImageAgent,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
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

function runtimeSnapshot() {
  return {
    schemaVersion: 1,
    providerId: "mxc",
    providerHandle: "opaque-preflight",
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle: "session-1" },
      acceleration: { kind: "none" },
    },
  } as const;
}

function manifest(agent: ShippedManagedImageAgent): RebuildManifest {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-07-31T00-00-00-000Z",
    agentType: agent,
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox",
    backupPath: "/tmp/alpha",
    blueprintDigest: null,
    workload: workload(agent),
    runtimeSnapshot: runtimeSnapshot(),
  };
}

function sandbox(agent: ShippedManagedImageAgent): SandboxEntry {
  const receipt = workload(agent);
  return {
    name: "alpha",
    agent,
    openshellDriver: "mxc",
    imageTag: receipt.reference,
    fromDockerfile: null,
    workload: receipt,
  };
}

function provider(agent: ShippedManagedImageAgent) {
  const preflight = vi.fn((operation: "backup" | "restore", entry: SandboxEntry) => ({
    schemaVersion: 1 as const,
    providerId: "mxc",
    operation,
    sandboxName: entry.name,
    providerHandle: "opaque-preflight",
    lifecycleState: "running" as const,
    lifecycleGeneration: "generation-1",
  }));
  const validateRestore = vi.fn();
  const restore = vi.fn(
    (
      entry: SandboxEntry,
      _preflight: unknown,
      _source: unknown,
      authority: RuntimeProviderManagedProfileRestoreAuthority,
    ) => ({
      schemaVersion: 1 as const,
      providerId: "mxc",
      sandboxName: entry.name,
      providerHandle: "opaque-restore",
      lifecycleState: "running" as const,
      lifecycleGeneration: "generation-1",
      runtime: runtimeSnapshot().runtime,
      managedProfile: authority,
    }),
  );
  const bundle = {
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
      acceptsReceipt: (receipt: SandboxWorkloadReceipt | undefined) =>
        receipt?.kind === "managed-image" && receipt.reference === workload(agent).reference,
    },
    snapshot: {
      providerId: "mxc",
      supported: true,
      contractVersion: 1,
      capabilities: { backup: true, restore: true, managedProfileRestore: true },
      preflight,
      capture: () => runtimeSnapshot().runtime,
      validateRestore,
      restore,
    },
  } as unknown as RuntimeProviderBundle;
  return { bundle, preflight, validateRestore, restore };
}

describe("managed rebuild restore authority", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("revalidates %s content and provider authority at the mutation edge", (agent) => {
    const target = sandbox(agent);
    const runtimeProvider = provider(agent);
    const restore = vi.fn(
      (_name: string, _path: string, options: RecreatedSandboxRestoreOptions): RestoreResult => {
        options.validateBeforeMutation?.();
        return {
          success: true,
          restoredDirs: ["workspace"],
          failedDirs: [],
          restoredFiles: [],
          failedFiles: [],
        };
      },
    );

    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      manifest(agent),
      { targetAgentType: agent },
      {
        getSandbox: () => target,
        requireProvider: () => runtimeProvider.bundle,
        captureContentAuthority: () => ({
          schemaVersion: 1,
          backupPath: "/tmp/alpha",
          contentSha256: "c".repeat(64),
        }),
        restore,
      },
    );

    expect(result.success).toBe(true);
    expect(restore).toHaveBeenCalledWith(
      "alpha",
      "/tmp/alpha",
      expect.objectContaining({
        authority: expect.objectContaining({ contentSha256: "c".repeat(64) }),
        validateBeforeMutation: expect.any(Function),
      }),
    );
    expect(runtimeProvider.preflight).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.validateRestore).toHaveBeenCalledTimes(2);
    expect(runtimeProvider.restore).toHaveBeenCalledOnce();
  });

  it("keeps legacy rebuild manifests on the state-only restore path", () => {
    const legacy = { ...manifest("openclaw"), workload: undefined, runtimeSnapshot: undefined };
    const restore = vi.fn(() => ({
      success: true,
      restoredDirs: [],
      failedDirs: [],
      restoredFiles: [],
      failedFiles: [],
    }));

    expect(
      restoreRecreatedSandboxStateWithManagedAuthority(
        "alpha",
        legacy,
        { targetAgentType: "openclaw" },
        {
          getSandbox: vi.fn(),
          requireProvider: vi.fn() as never,
          captureContentAuthority: vi.fn(),
          restore,
        },
      ).success,
    ).toBe(true);
    expect(restore).toHaveBeenCalledWith("alpha", "/tmp/alpha", {
      targetAgentType: "openclaw",
    });
  });

  it("rejects a managed manifest without provider runtime authority", () => {
    const restore = vi.fn();
    const result = restoreRecreatedSandboxStateWithManagedAuthority(
      "alpha",
      { ...manifest("hermes"), runtimeSnapshot: undefined },
      { targetAgentType: "hermes" },
      {
        getSandbox: vi.fn(),
        requireProvider: vi.fn() as never,
        captureContentAuthority: vi.fn(),
        restore,
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("missing provider runtime authority"),
    });
    expect(restore).not.toHaveBeenCalled();
  });
});
