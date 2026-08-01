// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { MANAGED_IMAGE_REPOSITORIES } from "../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import * as fixture from "./snapshot-restore-test-fixture";

beforeEach(() => fixture.resetSnapshotRestoreMocks());
afterEach(() => fixture.cleanupSnapshotRestoreMocks());

describe("managed snapshot clone activation boundary", () => {
  it("rejects managed cross-sandbox restore before destination effects (#7744)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
    fixture.getLatestBackupMock.mockReturnValue({
      snapshotVersion: 4,
      timestamp: "2026-07-30T00:00:00.000Z",
      backupPath: "/tmp/backup-alpha",
      agentType: "openclaw",
      workload: {
        schemaVersion: 1,
        kind: "managed-image",
        reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`,
        platform: "linux/amd64",
        release: "v0.0.100",
        sourceRevision: "b".repeat(40),
        sourceCohort: "ghrun-123-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
        credentialProxyReplayRequired: false,
        shared: true,
      },
      runtimeSnapshot: {
        schemaVersion: 1,
        providerId: "docker",
        providerHandle: "snapshot-provider-handle",
        lifecycleState: "running",
        lifecycleGeneration: "snapshot-generation",
        runtime: {
          schemaVersion: 1,
          providerId: "docker",
          runtime: { kind: "docker-container", handle: "container-id" },
          acceleration: { kind: "none" },
        },
      },
    });
    fixture.getSandboxMock.mockImplementation((name) =>
      name === "alpha" ? { name: "alpha", agent: "openclaw", openshellDriver: "docker" } : null,
    );
    const { runSandboxSnapshot } = await import("./snapshot");

    await expect(
      runSandboxSnapshot("alpha", { kind: "restore", to: "beta", force: true, yes: true }),
    ).rejects.toMatchObject({ exitCode: 1 });

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "requires managed-profile clone rebind",
    );
    expect(fixture.lifecycleMock.events).not.toContain("delete");
    expect(fixture.streamSandboxCreateMock).not.toHaveBeenCalled();
    expect(fixture.restoreSandboxStateMock).not.toHaveBeenCalled();
  });
});
