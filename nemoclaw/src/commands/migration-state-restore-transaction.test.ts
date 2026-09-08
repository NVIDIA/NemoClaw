// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../index.js";
import type { MigrationExternalRoot } from "./migration-state.js";
import { makeSnapshotManifest } from "./migration-state-test-fixtures.js";

const { fsFaults } = vi.hoisted(() => ({
  fsFaults: {
    realpathResults: new Map<string, string[]>(),
    renameFailures: new Map<string, number>(),
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const resolveRealPath = (targetPath: string): string =>
    fsFaults.realpathResults.get(targetPath)?.shift() ?? actual.realpathSync(targetPath);
  return {
    ...actual,
    realpathSync: Object.assign(resolveRealPath, { native: resolveRealPath }),
    renameSync: (oldPath: string, newPath: string): void => {
      const failuresRemaining = fsFaults.renameFailures.get(newPath) ?? 0;
      failuresRemaining > 0
        ? (() => {
            fsFaults.renameFailures.set(newPath, failuresRemaining - 1);
            throw new Error(`injected rename failure for ${newPath}`);
          })()
        : actual.renameSync(oldPath, newPath);
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

function externalRoot(sourcePath: string): MigrationExternalRoot {
  return {
    id: "workspace-root",
    kind: "workspace",
    label: "Workspace",
    sourcePath,
    snapshotRelativePath: "external/workspace-root",
    sandboxPath: "/sandbox/.nemoclaw/migration/workspaces/workspace-root",
    symlinkPaths: [],
    bindings: [{ configPath: "agents.defaults.workspace" }],
  };
}

function writeRestoreSnapshot(home: string, root: MigrationExternalRoot): string {
  const snapshotDir = path.join(home, "snapshot");
  const stateDir = path.join(home, ".openclaw");
  mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  mkdirSync(path.join(snapshotDir, root.snapshotRelativePath), { recursive: true });
  writeFileSync(path.join(snapshotDir, "openclaw", "marker"), "snapshot-state");
  writeFileSync(path.join(snapshotDir, root.snapshotRelativePath, "marker"), "snapshot-root");
  writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify(makeSnapshotManifest({ homeDir: home, stateDir, externalRoots: [root] })),
  );
  return snapshotDir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fsFaults.realpathResults.clear();
  fsFaults.renameFailures.clear();
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("migration-state restore transaction", () => {
  it("uses a new staging sibling when the first name is occupied", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T03:50:00Z"));
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, externalRoot(workspacePath));
    mkdirSync(`${stateDir}.nemoclaw-staging-${String(Date.now())}`, { recursive: true });
    vi.stubEnv("HOME", home);

    expect(restoreSnapshotToHost(snapshotDir, makeLogger())).toBe(true);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("snapshot-state");
  });

  it("rolls back every replacement when committing a later target fails", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, externalRoot(workspacePath));
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    writeFileSync(path.join(workspacePath, "marker"), "current-root");
    fsFaults.renameFailures.set(workspacePath, 1);
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
    const snapshotDir = writeRestoreSnapshot(home, externalRoot(workspacePath));
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    fsFaults.renameFailures.set(workspacePath, 2);
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Rollback incomplete .*Workspace.*Archives:/),
    );
  });

  it("rejects a restore target that changes after validation", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const workspacePath = path.join(home, "workspace");
    const snapshotDir = writeRestoreSnapshot(home, externalRoot(workspacePath));
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    fsFaults.realpathResults.set(workspacePath, [
      workspacePath,
      workspacePath,
      path.join(home, "changed-workspace"),
    ]);
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("changed after validation"));
  });
});
