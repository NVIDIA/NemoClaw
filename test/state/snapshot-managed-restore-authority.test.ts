// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-authority-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import("../../src/lib/state/sandbox.js");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

afterAll(() => {
  void (ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME));
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

function managedAuthority() {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  return {
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      release: "v0.0.97",
      sourceRevision: "b".repeat(40),
      sourceCohort: "ghrun-123456-1",
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
      providerHandle: "opaque-provider-handle",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "opaque-container-id" },
        acceleration: { kind: "none" },
      },
    },
  } as const;
}

function writeBackup(overrides: Record<string, unknown> = {}) {
  const timestamp = "2026-04-21T14-00-00-000Z";
  const backupPath = path.join(BACKUPS_ROOT, "alpha", timestamp);
  fs.mkdirSync(backupPath, { recursive: true });
  const manifest = {
    version: 1,
    sandboxName: "alpha",
    timestamp,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox/.openclaw",
    backupPath,
    blueprintDigest: null,
    ...overrides,
  };
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

function writeOpenClawRegistry(): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "alpha",
      sandboxes: {
        alpha: {
          name: "alpha",
          model: "demo",
          provider: "compatible-endpoint",
          gpuEnabled: false,
          agent: "openclaw",
        },
      },
    }),
  );
}

describe("managed snapshot restore authority", () => {
  it("binds every normalized restore-relevant manifest field selected by the operator", () => {
    const manifest = writeBackup({ backedUpDirs: ["workspace"], stateDirs: ["workspace"] });
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();

    fs.writeFileSync(
      path.join(manifest.backupPath, "rebuild-manifest.json"),
      JSON.stringify({ ...manifest, stateDirs: ["workspace", "agents"] }, null, 2),
    );

    expect(sandboxState.captureSnapshotRestoreAuthority(manifest.backupPath, selected!)).toBeNull();
  });

  it.each([
    { scenario: "missing authority and validator" },
    { scenario: "missing validator" },
    { scenario: "missing authority" },
  ])(
    "requires both content and runtime fences at each raw state entry point [$scenario]",
    ({ scenario }) => {
      const manifest = writeBackup(managedAuthority());
      const contentAuthority = sandboxState.captureSnapshotRestoreAuthority(manifest.backupPath);
      expect(contentAuthority).not.toBeNull();

      const partialAuthority = (
        {
          "missing authority and validator": {},
          "missing validator": { authority: contentAuthority! },
          "missing authority": { validateBeforeMutation: vi.fn() },
        } as const
      )[scenario]!;
      expect(
        sandboxState.restoreRecreatedSandboxState("alpha", manifest.backupPath, {
          targetAgentType: "openclaw",
          ...partialAuthority,
        }),
      ).toMatchObject({
        success: false,
        error: sandboxState.MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
      });

      writeOpenClawRegistry();
      expect(sandboxState.restoreSandboxState("alpha", manifest.backupPath)).toMatchObject({
        success: false,
        error: sandboxState.MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
      });

      const validateBeforeMutation = vi.fn();
      expect(
        sandboxState.restoreRecreatedSandboxState("alpha", manifest.backupPath, {
          targetAgentType: "openclaw",
          freshOpenClawImagePluginInstalls: [],
          authority: contentAuthority!,
          validateBeforeMutation,
        }),
      ).toMatchObject({ success: true });
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
    },
  );
});
