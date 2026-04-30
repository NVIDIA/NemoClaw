// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for snapshot versioning and naming added alongside the --name flag:
//   - validateSnapshotName accepts/rejects names
//   - listBackups computes virtual v<N> versions by timestamp-ascending position
//   - findBackup resolves selectors (v<N>, name, exact timestamp)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, afterAll, beforeEach } from "vitest";

// Override HOME BEFORE importing sandbox-state — it reads process.env.HOME
// at module-load time to compute REBUILD_BACKUPS_DIR. Captured original is
// restored in afterAll so sibling tests running in the same worker don't
// inherit a deleted temp directory.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snap-naming-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");

type BackupScalar = string | number | boolean | null | undefined;
type BackupValue = BackupScalar | BackupManifestOverrides | BackupValue[];

type SandboxStateModule = typeof import("../dist/lib/sandbox-state.js");
type SandboxStateModuleCandidate = Partial<SandboxStateModule> | null;

function isSandboxStateModule(value: SandboxStateModuleCandidate): value is SandboxStateModule {
  return (
    value !== null &&
    typeof value.listBackups === "function" &&
    typeof value.findBackup === "function" &&
    typeof value.validateSnapshotName === "function" &&
    typeof value.parseRestoreArgs === "function"
  );
}

const loadedSandboxState = await import(
  pathToFileURL(path.join(REPO_ROOT, "dist", "lib", "sandbox-state.js")).href
);
if (!isSandboxStateModule(loadedSandboxState)) {
  throw new Error("Expected sandbox-state module exports to be available");
}
const sandboxState = loadedSandboxState;
const { parseRestoreArgs } = sandboxState;

const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

type BackupManifestOverrides = { [key: string]: BackupValue };

function writeBackup(
  sandboxName: string,
  dirName: string,
  overrides: BackupManifestOverrides = {},
): BackupManifestOverrides {
  const dir = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    version: 1,
    sandboxName,
    timestamp: dirName,
    agentType: "openclaw",
    agentVersion: null,
    expectedVersion: null,
    stateDirs: [],
    dir: "/sandbox/.openclaw",
    backupPath: dir,
    blueprintDigest: null,
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "rebuild-manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("validateSnapshotName", () => {
  it("accepts normal names", () => {
    expect(sandboxState.validateSnapshotName("before-upgrade")).toBeNull();
    expect(sandboxState.validateSnapshotName("clean_state.v2")).toBeNull();
    expect(sandboxState.validateSnapshotName("A")).toBeNull();
  });

  it("rejects names matching the v<N> version pattern", () => {
    expect(sandboxState.validateSnapshotName("v1")).toMatch(/conflicts with.*v<N>/);
    expect(sandboxState.validateSnapshotName("V42")).toMatch(/conflicts with.*v<N>/);
  });

  it("rejects empty, leading-symbol, or too-long names", () => {
    expect(sandboxState.validateSnapshotName("")).toMatch(/Invalid/);
    expect(sandboxState.validateSnapshotName("-foo")).toMatch(/Invalid/);
    expect(sandboxState.validateSnapshotName(".hidden")).toMatch(/Invalid/);
    expect(sandboxState.validateSnapshotName("x".repeat(64))).toMatch(/Invalid/);
  });

  it("rejects names with spaces or slashes", () => {
    expect(sandboxState.validateSnapshotName("hello world")).toMatch(/Invalid/);
    expect(sandboxState.validateSnapshotName("foo/bar")).toMatch(/Invalid/);
  });
});

describe("listBackups computes virtual versions", () => {
  it("assigns v1 to the oldest by timestamp and vN to the newest", () => {
    // Written out of chronological order to verify sort-by-timestamp.
    writeBackup("test-sandbox", "2026-04-21T14-05-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-01-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-10-00-000Z");
    const list = sandboxState.listBackups("test-sandbox");
    // Newest first in display order.
    expect(list.map((b) => [b.snapshotVersion, b.timestamp])).toEqual([
      [3, "2026-04-21T14-10-00-000Z"],
      [2, "2026-04-21T14-05-00-000Z"],
      [1, "2026-04-21T14-01-00-000Z"],
    ]);
  });

  it("ignores any snapshotVersion persisted in legacy manifests", () => {
    // Old on-disk value should be overridden by position-based virtual version.
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", { snapshotVersion: 99 });
    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry.snapshotVersion).toBe(1);
  });

  it("surfaces the name field when present", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", { name: "before-upgrade" });
    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry.name).toBe("before-upgrade");
    expect(entry.snapshotVersion).toBe(1);
  });

  it("preserves legacy manifests created before blueprintDigest existed", () => {
    const dir = path.join(BACKUPS_ROOT, "test-sandbox", "2026-04-21T13-59-00-000Z");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rebuild-manifest.json"),
      JSON.stringify({
        version: 1,
        sandboxName: "test-sandbox",
        timestamp: "2026-04-21T13-59-00-000Z",
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        writableDir: "/sandbox/.openclaw-data",
        backupPath: dir,
      }),
    );

    const [entry] = sandboxState.listBackups("test-sandbox");
    expect(entry?.timestamp).toBe("2026-04-21T13-59-00-000Z");
    expect(entry?.dir).toBe("/sandbox/.openclaw-data");
    expect(entry?.writableDir).toBe("/sandbox/.openclaw-data");
    expect(entry?.blueprintDigest).toBeNull();
  });

  it("ignores rebuild manifests with invalid typed fields", () => {
    const dir = path.join(BACKUPS_ROOT, "test-sandbox", "2026-04-21T14-00-00-000Z");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rebuild-manifest.json"),
      JSON.stringify({
        version: 1,
        sandboxName: "test-sandbox",
        timestamp: "2026-04-21T14-00-00-000Z",
        agentType: "openclaw",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: [],
        writableDir: "/sandbox/.openclaw-data",
        backupPath: dir,
        blueprintDigest: null,
        policyPresets: [1],
      }),
    );

    expect(sandboxState.listBackups("test-sandbox")).toEqual([]);
  });
});

describe("findBackup", () => {
  it("matches v<N> against the computed version", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z"); // v1 (oldest)
    writeBackup("test-sandbox", "2026-04-21T14-05-00-000Z"); // v2 (newest)
    const r = sandboxState.findBackup("test-sandbox", "v2");
    expect(r.match?.timestamp).toBe("2026-04-21T14-05-00-000Z");
    expect(r.match?.snapshotVersion).toBe(2);
  });

  it("is case-insensitive on the v prefix", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-05-00-000Z");
    writeBackup("test-sandbox", "2026-04-21T14-10-00-000Z");
    expect(sandboxState.findBackup("test-sandbox", "V3").match?.timestamp).toBe(
      "2026-04-21T14-10-00-000Z",
    );
  });

  it("returns null for a non-existent version", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    expect(sandboxState.findBackup("test-sandbox", "v99").match).toBeNull();
  });

  it("matches by exact user-assigned name", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z", { name: "before-upgrade" });
    expect(sandboxState.findBackup("test-sandbox", "before-upgrade").match?.name).toBe(
      "before-upgrade",
    );
  });

  it("matches exact timestamp", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    const r = sandboxState.findBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    expect(r.match?.timestamp).toBe("2026-04-21T14-00-00-000Z");
  });

  it("does NOT match on timestamp prefix (exact-only)", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    expect(sandboxState.findBackup("test-sandbox", "2026-04-21").match).toBeNull();
  });

  it("returns no match for an unknown selector", () => {
    writeBackup("test-sandbox", "2026-04-21T14-00-00-000Z");
    expect(sandboxState.findBackup("test-sandbox", "nonexistent").match).toBeNull();
  });

  it("returns no match when the sandbox has no snapshots", () => {
    expect(sandboxState.findBackup("unknown-sandbox", "v1").match).toBeNull();
  });
});

// Argv parser for `snapshot restore [selector] [--to <dst>]`. Added alongside
// the cross-sandbox restore flag: covers positional selectors, --to extraction,
// ordering permutations, and error cases for a missing or flag-shaped value.
describe("parseRestoreArgs", () => {
  it("defaults to self-restore when --to is absent", () => {
    expect(parseRestoreArgs("src", ["restore"])).toEqual({
      ok: true,
      targetSandbox: "src",
      selector: null,
    });
  });

  it("carries a positional selector through without --to", () => {
    expect(parseRestoreArgs("src", ["restore", "v3"])).toEqual({
      ok: true,
      targetSandbox: "src",
      selector: "v3",
    });
  });

  it("accepts a user-assigned snapshot name as selector", () => {
    expect(parseRestoreArgs("src", ["restore", "before-upgrade"])).toEqual({
      ok: true,
      targetSandbox: "src",
      selector: "before-upgrade",
    });
  });

  it("extracts --to and redirects the restore target", () => {
    expect(parseRestoreArgs("src", ["restore", "--to", "dst"])).toEqual({
      ok: true,
      targetSandbox: "dst",
      selector: null,
    });
  });

  it("combines selector + --to with selector first", () => {
    expect(parseRestoreArgs("src", ["restore", "v3", "--to", "dst"])).toEqual({
      ok: true,
      targetSandbox: "dst",
      selector: "v3",
    });
  });

  it("combines selector + --to with --to first", () => {
    expect(parseRestoreArgs("src", ["restore", "--to", "dst", "v3"])).toEqual({
      ok: true,
      targetSandbox: "dst",
      selector: "v3",
    });
  });

  it("preserves timestamp-shaped selectors alongside --to", () => {
    expect(parseRestoreArgs("src", ["restore", "2026-04-21T14-00-00-000Z", "--to", "dst"])).toEqual(
      {
        ok: true,
        targetSandbox: "dst",
        selector: "2026-04-21T14-00-00-000Z",
      },
    );
  });

  it("rejects --to at end-of-args with no value", () => {
    const result = parseRestoreArgs("src", ["restore", "--to"]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected parseRestoreArgs() to reject a trailing --to flag");
    }
    expect(result.error).toMatch(/--to requires a target sandbox name/);
  });

  it("rejects --to when followed immediately by another flag", () => {
    // Without this guard, `--to --other` would swallow the flag as the dst
    // name and confuse validateName with an error about a weird name.
    const result = parseRestoreArgs("src", ["restore", "--to", "--other"]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected parseRestoreArgs() to reject --to without a target name");
    }
    expect(result.error).toMatch(/--to requires a target sandbox name/);
  });

  it("returns self-restore when target equals source explicitly", () => {
    expect(parseRestoreArgs("src", ["restore", "--to", "src"])).toEqual({
      ok: true,
      targetSandbox: "src",
      selector: null,
    });
  });

  it("uses only the first positional as selector; ignores trailing positionals", () => {
    // Trailing positionals are silently accepted today — pin that behavior so
    // future changes notice if it shifts.
    expect(parseRestoreArgs("src", ["restore", "v1", "v2"])).toEqual({
      ok: true,
      targetSandbox: "src",
      selector: "v1",
    });
  });
});
