// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../index.js";
import type { DescriptorRestoreReplacement } from "../shared/migration-restore-boundary.cjs";
import type { MigrationExternalRoot } from "./migration-state.js";
import { makeSnapshotManifest } from "./migration-state-test-fixtures.js";

const { boundaryFaults } = vi.hoisted(() => ({
  boundaryFaults: {
    beforeRestore: null as null | ((replacements: readonly DescriptorRestoreReplacement[]) => void),
    result: null as null | {
      ok: boolean;
      phase: "staging" | "commit" | "cleanup";
      message: string;
      rollbackFailures: string[];
      retainedArchives: string[];
      cleanupFailures: string[];
    },
  },
}));

vi.mock("../shared/migration-restore-boundary.cjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/migration-restore-boundary.cjs")>();
  return {
    ...actual,
    restoreDescriptorSnapshotReplacements: (
      replacements: readonly DescriptorRestoreReplacement[],
    ) => {
      boundaryFaults.beforeRestore?.(replacements);
      return boundaryFaults.result ?? actual.restoreDescriptorSnapshotReplacements(replacements);
    },
  };
});

import { restoreSnapshotToHost } from "./migration-state.js";

const temporaryRoots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "nemoclaw-restore-transaction-"));
  temporaryRoots.push(home);
  return home;
}

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function externalRoot(sourcePath: string, id = "workspace-root"): MigrationExternalRoot {
  return {
    id,
    kind: "workspace",
    label: "Workspace",
    sourcePath,
    snapshotRelativePath: `external/${id}`,
    sandboxPath: `/sandbox/.nemoclaw/migration/workspaces/${id}`,
    symlinkPaths: [],
    bindings: [{ configPath: "agents.defaults.workspace" }],
  };
}

function writeRestoreSnapshot(home: string, roots: MigrationExternalRoot[]): string {
  const snapshotDir = path.join(home, "snapshot");
  const stateDir = path.join(home, ".openclaw");
  mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  for (const root of roots) {
    mkdirSync(path.join(snapshotDir, root.snapshotRelativePath), { recursive: true });
    writeFileSync(path.join(snapshotDir, root.snapshotRelativePath, "marker"), "snapshot-root");
  }
  writeFileSync(path.join(snapshotDir, "openclaw", "marker"), "snapshot-state");
  writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify(makeSnapshotManifest({ homeDir: home, stateDir, externalRoots: roots })),
  );
  return snapshotDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  boundaryFaults.beforeRestore = null;
  boundaryFaults.result = null;
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("migration-state restore transaction", () => {
  it("removes replacement archives after a successful restore", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(stateDir, "old"), "state");
    writeFileSync(path.join(workspacePath, "old"), "workspace");
    writeFileSync(path.join(snapshotDir, "openclaw", "openclaw.json"), "{}\n", { mode: 0o644 });
    vi.stubEnv("HOME", home);

    expect(restoreSnapshotToHost(snapshotDir, makeLogger())).toBe(true);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("snapshot-state");
    expect(statSync(path.join(stateDir, "openclaw.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((entry) => entry.includes(".nemoclaw-archived-"))).toEqual([]);
  });

  it("rolls back every replacement when committing a later target fails", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    writeFileSync(path.join(workspacePath, "marker"), "current-root");
    boundaryFaults.result = {
      ok: false,
      phase: "commit",
      message: "injected commit failure",
      rollbackFailures: [],
      retainedArchives: [],
      cleanupFailures: [],
    };
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("current-state");
    expect(readFileSync(path.join(workspacePath, "marker"), "utf8")).toBe("current-root");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Previous host state was restored"),
    );
  });

  it("reports retained archives when rollback cannot restore a target", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    boundaryFaults.result = {
      ok: false,
      phase: "commit",
      message: "injected commit failure",
      rollbackFailures: ["Workspace: injected rollback failure"],
      retainedArchives: [`${workspacePath}.nemoclaw-archived-test`],
      cleanupFailures: [],
    };
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Rollback incomplete .*Workspace.*Archives:/),
    );
  });

  it("reports archives retained after successful replacement cleanup", () => {
    const home = makeHome();
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    const retainedArchive = path.join(home, ".nemoclaw-archived-test");
    boundaryFaults.result = {
      ok: true,
      phase: "cleanup",
      message: "restore transaction committed",
      rollbackFailures: [],
      retainedArchives: [retainedArchive],
      cleanupFailures: ["Workspace: injected cleanup failure"],
    };
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(retainedArchive));
  });

  it("rejects a missing external config snapshot before staging", () => {
    const home = makeHome();
    const workspacePath = path.join(home, "workspace");
    const configPath = path.join(home, "external-openclaw.json");
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    writeFileSync(
      path.join(snapshotDir, "snapshot.json"),
      JSON.stringify(
        makeSnapshotManifest({
          homeDir: home,
          stateDir: path.join(home, ".openclaw"),
          configPath,
          hasExternalConfig: true,
          externalRoots: [externalRoot(workspacePath)],
        }),
      ),
    );
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external config is missing or invalid"),
    );
  });

  it("removes parent directories created before a later staging failure", () => {
    const home = makeHome();
    const missingParent = path.join(home, "missing-parent");
    const first = externalRoot(path.join(missingParent, "workspace"), "first-root");
    const second = externalRoot(path.join(home, "second-workspace"), "second-root");
    const snapshotDir = writeRestoreSnapshot(home, [first, second]);
    boundaryFaults.beforeRestore = () =>
      rmSync(path.join(snapshotDir, second.snapshotRelativePath), { recursive: true, force: true });
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(existsSync(missingParent)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("host state was not changed"),
    );
  });

  it("rejects a target parent replaced by a symlink after validation", () => {
    const home = makeHome();
    const targetParent = path.join(home, "target-parent");
    const originalParent = path.join(home, "target-parent-original");
    const outside = path.join(home, "outside");
    const workspacePath = path.join(targetParent, "workspace");
    mkdirSync(targetParent);
    mkdirSync(outside);
    const snapshotDir = writeRestoreSnapshot(home, [externalRoot(workspacePath)]);
    boundaryFaults.beforeRestore = () => {
      renameSync(targetParent, originalParent);
      symlinkSync(outside, targetParent, "dir");
    };
    vi.stubEnv("HOME", home);

    expect(restoreSnapshotToHost(snapshotDir, makeLogger())).toBe(false);
    expect(existsSync(path.join(outside, "workspace"))).toBe(false);
  });
});
