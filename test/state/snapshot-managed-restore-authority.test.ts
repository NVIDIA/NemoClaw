// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-authority-"));
process.env.HOME = TMP_HOME;
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_OPENSHELL = process.env.NEMOCLAW_OPENSHELL_BIN;
const BIN_DIR = path.join(TMP_HOME, "bin");

fs.mkdirSync(BIN_DIR, { recursive: true });
fs.writeFileSync(
  path.join(BIN_DIR, "openshell"),
  `#!/bin/sh
if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then
  printf '{"name":"alpha"}\n'
  exit 0
fi
if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then
  printf 'Host openshell-alpha\n  HostName 127.0.0.1\n  User sandbox\n'
  exit 0
fi
exit 1
`,
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(BIN_DIR, "ssh"),
  `#!/usr/bin/env node
const command = process.argv.at(-1) || "";
if (command.includes("printf") && command.includes("$HOME")) {
  process.stdout.write(Buffer.from("/sandbox\\0/sandbox\\0"));
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);
process.env.NEMOCLAW_OPENSHELL_BIN = path.join(BIN_DIR, "openshell");
process.env.PATH = `${BIN_DIR}:${ORIGINAL_PATH ?? ""}`;
const sandboxState = await import("../../src/lib/state/sandbox.js");

afterAll(() => {
  void (ORIGINAL_HOME === undefined
    ? Reflect.deleteProperty(process.env, "HOME")
    : Reflect.set(process.env, "HOME", ORIGINAL_HOME));
  void (ORIGINAL_PATH === undefined
    ? Reflect.deleteProperty(process.env, "PATH")
    : Reflect.set(process.env, "PATH", ORIGINAL_PATH));
  void (ORIGINAL_OPENSHELL === undefined
    ? Reflect.deleteProperty(process.env, "NEMOCLAW_OPENSHELL_BIN")
    : Reflect.set(process.env, "NEMOCLAW_OPENSHELL_BIN", ORIGINAL_OPENSHELL));
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
  const archivePath = path.join(backupPath, "native-home.tar");
  const tar = spawnSync("tar", ["-cf", archivePath, "--files-from", "/dev/null"]);
  assert.equal(tar.status, 0, "Could not create native-state test archive");
  const manifest = {
    version: 2,
    sandboxName: "alpha",
    timestamp,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    nativeState: {
      root: "/sandbox",
      archive: "native-home.tar",
      sha256: createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex"),
    },
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

describe("managed rebuild restore authority", () => {
  it.each([0, 42])(
    "preserves native-state outcomes with SSH exit %s and cleanup failure (#10947)",
    async (exitCode) => {
      const fixture = fs.mkdtempSync(path.join(TMP_HOME, "cleanup-source-"));
      const sshFile = path.join(BIN_DIR, "ssh");
      const originalSsh = fs.readFileSync(sshFile);
      const remove = fs.rmSync;
      const retained: string[] = [];
      const rejectRemoval = (target: fs.PathLike): never => {
        retained.push(String(target));
        throw new Error("injected cleanup failure");
      };
      try {
        fs.writeFileSync(path.join(fixture, "state.txt"), "preserved");
        writeOpenClawRegistry();
        const complete = sandboxState.backupSandboxState("alpha", {
          nativeStateSource: { root: "/sandbox", directory: fixture, assertCurrent: vi.fn() },
        });
        expect(complete.success, complete.error).toBe(true);
        fs.writeFileSync(
          sshFile,
          `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv.at(-1) || "";
if (${exitCode} !== 0) { process.stderr.write("operation failed"); process.exit(${exitCode}); }
if (command.includes("printf") && command.includes("$HOME")) {
  process.stdout.write(Buffer.from("/sandbox\\0/sandbox\\0"));
  process.exit(0);
}
if (command.includes("tar -C")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(complete.manifest!.backupPath, "native-home.tar"))}));
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`,
        );
        vi.spyOn(fs, "rmSync").mockImplementation((target, options) =>
          /^nemoclaw-native-(?:state|restore)-/u.test(path.basename(String(target)))
            ? rejectRemoval(target)
            : remove(target, options),
        );
        const backup = sandboxState.backupSandboxState("alpha");
        const restore = await sandboxState.restoreSandboxState(
          "alpha",
          complete.manifest!.backupPath,
        );

        expect(backup.success).toBe(false);
        expect(restore.success).toBe(false);
        expect(backup.error).toContain(JSON.stringify(retained[0]));
        expect(restore.error).toContain(JSON.stringify(retained[1]));
        expect(backup.error).toContain("Remove that directory before retrying");
        expect(restore.error).toContain("Remove that directory before retrying");
        expect(backup.error).toContain(exitCode === 0 ? "failed to remove" : "operation failed");
        expect(restore.error).toContain(exitCode === 0 ? "failed to remove" : "operation failed");
        expect(backup.backedUpDirs, backup.error).toEqual(exitCode === 0 ? ["."] : []);
        expect(restore.restoredDirs, restore.error).toEqual(exitCode === 0 ? ["."] : []);
        expect(retained).toHaveLength(2);
        expect(fs.readFileSync(path.join(fixture, "state.txt"), "utf8")).toBe("preserved");
      } finally {
        vi.restoreAllMocks();
        fs.writeFileSync(sshFile, originalSsh);
        remove(retained[0] ?? path.join(fixture, "missing-0"), { recursive: true, force: true });
        remove(retained[1] ?? path.join(fixture, "missing-1"), { recursive: true, force: true });
        remove(fixture, { recursive: true, force: true });
      }
    },
  );

  it("binds every normalized restore-relevant manifest field selected by the operator", () => {
    const manifest = writeBackup({ agentVersion: "1.0.0" });
    const selected = sandboxState.getLatestBackup("alpha");
    expect(selected).not.toBeNull();

    fs.writeFileSync(
      path.join(manifest.backupPath, "rebuild-manifest.json"),
      JSON.stringify({ ...manifest, agentVersion: "1.0.1" }, null, 2),
    );

    expect(sandboxState.captureSnapshotRestoreAuthority(manifest.backupPath, selected!)).toBeNull();
  });

  it.each([
    { scenario: "missing authority and validator" },
    { scenario: "missing validator" },
    { scenario: "missing authority" },
  ])(
    "requires both content and runtime fences at each raw state entry point [$scenario]",
    async ({ scenario }) => {
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
        await sandboxState.restoreRecreatedSandboxState("alpha", manifest.backupPath, {
          targetAgentType: "openclaw",
          ...partialAuthority,
        }),
      ).toMatchObject({
        success: false,
        error: sandboxState.MANAGED_REBUILD_RESTORE_AUTHORITY_ERROR,
      });

      writeOpenClawRegistry();
      expect(await sandboxState.restoreSandboxState("alpha", manifest.backupPath)).toMatchObject({
        success: false,
        error: sandboxState.MANAGED_REBUILD_RESTORE_AUTHORITY_ERROR,
      });

      const validateBeforeMutation = vi.fn();
      const restored = await sandboxState.restoreRecreatedSandboxState(
        "alpha",
        manifest.backupPath,
        {
          targetAgentType: "openclaw",
          authority: contentAuthority!,
          validateBeforeMutation,
        },
      );
      expect(restored.success, restored.error).toBe(true);
      expect(validateBeforeMutation).toHaveBeenCalledOnce();
    },
  );
});

it.each([
  {
    outcome: "allow",
    validate: () => undefined,
    mutate: (_manifest: ReturnType<typeof writeBackup>) => undefined,
    expected: { success: true },
  },
  {
    outcome: "reject",
    validate: () => {
      throw new Error("policy observation rejected");
    },
    mutate: (_manifest: ReturnType<typeof writeBackup>) => undefined,
    expected: {
      success: false,
      error: expect.stringContaining("policy observation rejected"),
    },
  },
  {
    outcome: "content-drift",
    validate: () => undefined,
    mutate: (manifest: ReturnType<typeof writeBackup>) =>
      fs.writeFileSync(
        path.join(manifest.backupPath, "rebuild-manifest.json"),
        JSON.stringify({ ...manifest, agentVersion: "drifted" }),
      ),
    expected: {
      success: false,
      error: expect.stringContaining("Selected snapshot content changed"),
    },
  },
])(
  "awaits $outcome authority before completing an empty restore",
  async ({ validate, mutate, expected }) => {
    const manifest = writeBackup(managedAuthority());
    const contentAuthority = sandboxState.captureSnapshotRestoreAuthority(manifest.backupPath)!;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let completed = false;
    const restoring = sandboxState
      .restoreRecreatedSandboxState("alpha", manifest.backupPath, {
        targetAgentType: "openclaw",
        authority: contentAuthority,
        validateBeforeMutation: async () => {
          entered();
          await pending;
          validate();
        },
      })
      .then((result) => {
        completed = true;
        return result;
      });
    await observing;
    expect(completed).toBe(false);
    mutate(manifest);
    release();
    const result = await restoring;
    expect(result).toMatchObject(expected);
  },
);
