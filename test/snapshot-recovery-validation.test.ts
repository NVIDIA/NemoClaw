// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-validation-"));
vi.stubEnv("HOME", TMP_HOME);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as typeof import("../src/lib/state/sandbox.js");
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function writeBackup(
  sandboxName: string,
  timestamp: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, timestamp);
  fs.mkdirSync(backupPath, { recursive: true });
  const manifest = {
    version: 1,
    sandboxName,
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

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("prepared rebuild backup recovery validation (#6114)", () => {
  it("does not expose a latest backup with a missing or malformed manifest", () => {
    const backupPath = path.join(BACKUPS_ROOT, "alpha", "2026-07-01T06-50-41-044Z");
    fs.mkdirSync(backupPath, { recursive: true });

    expect(sandboxState.getLatestBackup("alpha")).toBeNull();

    fs.writeFileSync(path.join(backupPath, "rebuild-manifest.json"), "{malformed");
    expect(sandboxState.getLatestBackup("alpha")).toBeNull();
  });

  it("accepts an exact sandbox and agent identity from its timestamped backup path", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      agentVersion: "2026.5.27",
      expectedVersion: "2026.5.27",
    });
    const latest = sandboxState.getLatestBackup("alpha");

    expect(latest).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, latest!)).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        sandboxName: "alpha",
        agentType: "openclaw",
        timestamp: "2026-07-01T06-50-42-044Z",
      }),
    });
  });

  it("rejects a persisted manifest that disappears or becomes malformed after discovery", () => {
    const candidate = writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      agentVersion: "2026.5.27",
      expectedVersion: "2026.5.27",
    });
    const manifestPath = path.join(
      BACKUPS_ROOT,
      "alpha",
      "2026-07-01T06-50-42-044Z",
      "rebuild-manifest.json",
    );

    fs.unlinkSync(manifestPath);
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, candidate as never)).toEqual(
      {
        ok: false,
        reason: "latest backup manifest is missing, malformed, or unsupported",
      },
    );

    fs.writeFileSync(manifestPath, "{malformed");
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, candidate as never)).toEqual(
      {
        ok: false,
        reason: "latest backup manifest is missing, malformed, or unsupported",
      },
    );
  });

  it("rejects sandbox, agent, and backup-path identity mismatches", () => {
    writeBackup("alpha", "2026-07-01T06-50-42-044Z", {
      sandboxName: "beta",
      agentType: "hermes",
    });
    const mismatched = sandboxState.getLatestBackup("alpha");

    expect(mismatched).not.toBeNull();
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", "hermes", mismatched!)).toEqual({
      ok: false,
      reason: "manifest sandbox 'beta' does not match 'alpha'",
    });

    writeBackup("alpha", "2026-07-01T06-50-43-044Z", { agentType: "hermes" });
    const agentMismatch = sandboxState.getLatestBackup("alpha");
    expect(agentMismatch).not.toBeNull();
    expect(
      sandboxState.validateRebuildRecoveryManifest("alpha", "openclaw", agentMismatch!),
    ).toEqual({
      ok: false,
      reason: "manifest agent 'hermes' does not match registry agent 'openclaw'",
    });

    const exact = writeBackup("alpha", "2026-07-01T06-51-42-044Z", {
      backupPath: path.join(BACKUPS_ROOT, "alpha", "some-other-backup"),
    });
    expect(sandboxState.validateRebuildRecoveryManifest("alpha", null, exact as never)).toEqual({
      ok: false,
      reason: "backup path does not match 'alpha' and timestamp '2026-07-01T06-51-42-044Z'",
    });
  });

  it("requires a non-empty managed-image fingerprint", () => {
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: "0.0.71" })).toBe(true);
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: null })).toBe(false);
    expect(sandboxState.hasPositiveManagedImageEvidence({ nemoclawVersion: "  " })).toBe(false);
  });
});
