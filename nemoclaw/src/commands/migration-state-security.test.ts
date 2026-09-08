// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listSnapshots, pruneSnapshots } from "../blueprint/snapshot-management.js";
import type { PluginLogger } from "../index.js";
import * as credentialFilter from "../security/credential-filter.js";
import * as snapshotSanitizer from "../security/snapshot-sanitizer.js";
import * as snapshotBoundary from "../shared/snapshot-sanitizer-boundary.cjs";
import {
  cleanupSnapshotBundle,
  createSnapshotBundle,
  type HostOpenClawState,
  type MigrationExternalRoot,
  restoreSnapshotToHost,
  setConfigValue,
} from "./migration-state.js";
import { makeSnapshotManifest } from "./migration-state-test-fixtures.js";

const roots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "nemoclaw-migration-state-security-"));
  roots.push(home);
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

function makeHostState(homeDir: string, configPath: string): HostOpenClawState {
  const stateDir = path.join(homeDir, ".openclaw");
  return {
    exists: true,
    homeDir,
    stateDir,
    configDir: stateDir,
    configPath,
    workspaceDir: null,
    extensionsDir: null,
    skillsDir: null,
    hooksDir: null,
    externalRoots: [],
    warnings: [],
    errors: [],
    hasExternalConfig: false,
  };
}

function expectSnapshotBundle(
  bundle: ReturnType<typeof createSnapshotBundle>,
): asserts bundle is NonNullable<ReturnType<typeof createSnapshotBundle>> {
  expect(bundle).not.toBeNull();
}

function makeMinimalHostSnapshot(): {
  home: string;
  configPath: string;
  logger: PluginLogger;
} {
  const home = makeHome();
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, "{}");
  return { home, configPath, logger: makeLogger() };
}

function expectSnapshotFailure(
  home: string,
  logger: PluginLogger,
  bundle: ReturnType<typeof createSnapshotBundle>,
  message: string,
): void {
  expect(bundle).toBeNull();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(readdirSync(path.join(home, ".nemoclaw", "staging"))).toEqual([]);
}

function writeExternalRestoreSnapshot(
  home: string,
  externalRoots: MigrationExternalRoot[],
): { snapshotDir: string; stateDir: string } {
  const snapshotDir = path.join(home, "snapshot");
  const stateDir = path.join(home, ".openclaw");
  mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
  for (const root of externalRoots) {
    mkdirSync(path.join(snapshotDir, root.snapshotRelativePath), { recursive: true });
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(snapshotDir, "snapshot.json"),
    JSON.stringify(
      makeSnapshotManifest({
        homeDir: home,
        stateDir,
        externalRoots,
      }),
    ),
  );
  return { snapshotDir, stateDir };
}

function externalRoot(sourcePath: string, id: string): MigrationExternalRoot {
  return {
    id,
    kind: "workspace",
    label: id,
    sourcePath,
    snapshotRelativePath: path.join("external", id),
    sandboxPath: path.posix.join("/sandbox/.nemoclaw/migration/workspaces", id),
    symlinkPaths: [],
    bindings: [{ configPath: "agents.defaults.workspace" }],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("migration-state external restore security", () => {
  it("restores an external root inside the trusted host root", () => {
    const home = makeHome();
    const workspacePath = path.join(home, "workspace");
    const skillsPath = path.join(home, "skills-extra");
    const workspace = externalRoot(workspacePath, "workspaces-default-workspace");
    const skills = externalRoot(skillsPath, "skills-extra-1");
    const { snapshotDir } = writeExternalRestoreSnapshot(home, [workspace, skills]);
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(skillsPath, { recursive: true });
    writeFileSync(path.join(workspacePath, "marker"), "after");
    writeFileSync(path.join(skillsPath, "marker"), "after");
    writeFileSync(path.join(snapshotDir, workspace.snapshotRelativePath, "marker"), "before");
    writeFileSync(path.join(snapshotDir, skills.snapshotRelativePath, "marker"), "before");
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(true);
    expect(readFileSync(path.join(workspacePath, "marker"), "utf8")).toBe("before");
    expect(readFileSync(path.join(skillsPath, "marker"), "utf8")).toBe("before");
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`Restored ${workspace.id}`));
  });

  it("rejects an external root outside the trusted host root", () => {
    const home = makeHome();
    const outsideHome = makeHome();
    const root = externalRoot(path.join(outsideHome, "workspace"), "workspaces-default-workspace");
    const { snapshotDir, stateDir } = writeExternalRestoreSnapshot(home, [root]);
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(existsSync(stateDir)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root is outside the trusted host root"),
    );
  });

  it("rejects an external root snapshot path that does not match its ID", () => {
    const home = makeHome();
    const root = externalRoot(path.join(home, "workspace"), "workspaces-default-workspace");
    root.snapshotRelativePath = "external/another-workspace";
    const { snapshotDir } = writeExternalRestoreSnapshot(home, [root]);
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root is missing or invalid"),
    );
  });

  it("rejects duplicate external root targets", () => {
    const home = makeHome();
    const sourcePath = path.join(home, "workspace");
    const first = externalRoot(sourcePath, "workspaces-default-workspace");
    const second = externalRoot(sourcePath, "workspaces-second-workspace");
    const { snapshotDir } = writeExternalRestoreSnapshot(home, [first, second]);
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root target is duplicated"),
    );
  });

  it("rejects overlapping external root targets before changing host state", () => {
    const home = makeHome();
    const parentPath = path.join(home, "workspace");
    const childPath = path.join(parentPath, "skills");
    const parent = externalRoot(parentPath, "workspaces-default-workspace");
    const child = externalRoot(childPath, "skills-extra-1");
    const { snapshotDir, stateDir } = writeExternalRestoreSnapshot(home, [parent, child]);
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    mkdirSync(childPath, { recursive: true });
    writeFileSync(path.join(parentPath, "marker"), "current-parent");
    writeFileSync(path.join(childPath, "marker"), "current-child");
    writeFileSync(path.join(snapshotDir, parent.snapshotRelativePath, "marker"), "snapshot-parent");
    writeFileSync(path.join(snapshotDir, child.snapshotRelativePath, "marker"), "snapshot-child");
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("current-state");
    expect(readFileSync(path.join(parentPath, "marker"), "utf8")).toBe("current-parent");
    expect(readFileSync(path.join(childPath, "marker"), "utf8")).toBe("current-child");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root targets overlap"),
    );
  });

  it("rejects an external root whose parent symlink escapes the trusted host root", () => {
    const home = makeHome();
    const outsideHome = makeHome();
    const outsideWorkspace = path.join(outsideHome, "workspace");
    mkdirSync(outsideWorkspace, { recursive: true });
    writeFileSync(path.join(outsideWorkspace, "marker"), "outside-current");
    symlinkSync(outsideHome, path.join(home, "linked-parent"));
    const root = externalRoot(
      path.join(home, "linked-parent", "workspace"),
      "workspaces-default-workspace",
    );
    const { snapshotDir, stateDir } = writeExternalRestoreSnapshot(home, [root]);
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    writeFileSync(path.join(snapshotDir, root.snapshotRelativePath, "marker"), "snapshot-root");
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("current-state");
    expect(readFileSync(path.join(outsideWorkspace, "marker"), "utf8")).toBe("outside-current");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root is outside the trusted host root"),
    );
  });

  it("rejects an external root snapshot whose parent symlink escapes the snapshot", () => {
    const home = makeHome();
    const outsideHome = makeHome();
    const root = externalRoot(path.join(home, "workspace"), "workspaces-default-workspace");
    const { snapshotDir, stateDir } = writeExternalRestoreSnapshot(home, [root]);
    const snapshotExternalPath = path.join(snapshotDir, "external");
    rmSync(snapshotExternalPath, { recursive: true });
    mkdirSync(path.join(outsideHome, "external", root.id), { recursive: true });
    symlinkSync(path.join(outsideHome, "external"), snapshotExternalPath);
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("current-state");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("external root is missing or invalid"),
    );
  });

  it("stages every replacement before changing host state", () => {
    const home = makeHome();
    const firstPath = path.join(home, "workspace");
    const blockedParent = path.join(home, "blocked-parent");
    const secondPath = path.join(blockedParent, "skills");
    const first = externalRoot(firstPath, "workspaces-default-workspace");
    const second = externalRoot(secondPath, "skills-extra-1");
    const { snapshotDir, stateDir } = writeExternalRestoreSnapshot(home, [first, second]);
    writeFileSync(path.join(stateDir, "marker"), "current-state");
    mkdirSync(firstPath, { recursive: true });
    writeFileSync(path.join(firstPath, "marker"), "current-first");
    writeFileSync(blockedParent, "not-a-directory");
    writeFileSync(path.join(snapshotDir, first.snapshotRelativePath, "marker"), "snapshot-first");
    writeFileSync(path.join(snapshotDir, second.snapshotRelativePath, "marker"), "snapshot-second");
    vi.stubEnv("HOME", home);
    const logger = makeLogger();

    expect(restoreSnapshotToHost(snapshotDir, logger)).toBe(false);
    expect(readFileSync(path.join(stateDir, "marker"), "utf8")).toBe("current-state");
    expect(readFileSync(path.join(firstPath, "marker"), "utf8")).toBe("current-first");
    expect(readFileSync(blockedParent, "utf8")).toBe("not-a-directory");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("host state was not changed"),
    );
  });
});

describe("migration-state snapshot directory reservation", () => {
  it("takes its snapshot directory from the shared reservation (#9433)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T06:43:16.500Z"));
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const hostState = makeHostState(home, configPath);

    const first = createSnapshotBundle(hostState, logger, { persist: true });
    expectSnapshotBundle(first);
    const second = createSnapshotBundle(hostState, logger, { persist: true });
    expectSnapshotBundle(second);

    // The clock has not moved, so an unreserved leaf would be the first snapshot's directory.
    // Reservation grammar and same-second advance are owned by snapshot-directory.test.ts.
    expect(second.snapshotDir).not.toBe(first.snapshotDir);
    expect(path.basename(first.snapshotDir)).toBe(first.manifest.timestamp);
    expect(path.basename(second.snapshotDir)).toBe(second.manifest.timestamp);
  });

  it("publishes persisted migration snapshots to the retention reader (#9433)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-18T06:43:16.500Z"));
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: true,
    });
    expectSnapshotBundle(bundle);
    const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");

    expect(listSnapshots({ snapshotsDir })).toEqual([
      expect.objectContaining({
        path: bundle.snapshotDir,
        timestamp: bundle.manifest.timestamp,
      }),
    ]);

    const result = pruneSnapshots(0, {
      snapshotsDir,
      deleteDirectory: (root, name) => {
        expect(root).toBe(snapshotsDir);
        expect(name).toBe(bundle.manifest.timestamp);
        rmSync(path.join(root, name), { force: true, recursive: true });
        return true;
      },
    });
    expect(result).toEqual({ deleted: [bundle.snapshotDir], failed: [], kept: [] });
    expect(listSnapshots({ snapshotsDir })).toEqual([]);
  });
});

describe("migration-state prepared config security", () => {
  it("installs a mode-0600 config after scrubbing contextual secrets in memory", () => {
    const home = makeHome();
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { auth: { token: "must-not-migrate" } },
        metadata: {
          environmentAssignment: "GITHUB_TOKEN=opaque-secret-value-123",
          camelAssignment: "apiKey=opaque-secret-value-123",
          model: "keep-me",
        },
      }),
    );

    const bundle = createSnapshotBundle(makeHostState(home, configPath), makeLogger(), {
      persist: false,
    });
    expectSnapshotBundle(bundle);

    const preparedConfigPath = path.join(bundle.preparedStateDir, "openclaw.json");
    const preparedConfig = JSON.parse(readFileSync(preparedConfigPath, "utf-8")) as {
      gateway?: unknown;
      metadata: Record<string, string>;
    };
    expect(preparedConfig.gateway).toBeUndefined();
    expect(preparedConfig.metadata).toEqual({
      environmentAssignment: "[STRIPPED_BY_MIGRATION]",
      camelAssignment: "[STRIPPED_BY_MIGRATION]",
      model: "keep-me",
    });
    expect(statSync(preparedConfigPath).mode & 0o777).toBe(0o600);

    cleanupSnapshotBundle(bundle);
  });

  it.runIf(process.platform !== "win32")(
    "rejects an in-tree config symlink without touching its external target",
    () => {
      const home = makeHome();
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const externalConfigPath = path.join(home, "external-openclaw.json");
      const original = JSON.stringify({ external: "must-remain" });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(externalConfigPath, original, { mode: 0o640 });
      const externalConfigFd = openSync(externalConfigPath, "r");
      try {
        const originalMode = fstatSync(externalConfigFd).mode & 0o777;
        symlinkSync(externalConfigPath, configPath);
        const logger = makeLogger();

        const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
          persist: false,
        });

        expect(bundle).toBeNull();
        expect(logger.error).toHaveBeenCalled();
        expect(readFileSync(externalConfigFd, "utf-8")).toBe(original);
        expect(fstatSync(externalConfigFd).mode & 0o777).toBe(originalMode);
        const stagingDir = path.join(home, ".nemoclaw", "staging");
        expect(existsSync(stagingDir) ? readdirSync(stagingDir) : []).toEqual([]);
      } finally {
        closeSync(externalConfigFd);
      }
    },
  );
});

describe("migration-state prepared config fail-closed boundaries", () => {
  it("removes staging when the copied config parent cannot be inspected", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const inspect = vi
      .spyOn(snapshotBoundary, "inspectDescriptorSnapshotRoot")
      .mockReturnValue(null);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(home, logger, bundle, "Failed to inspect copied OpenClaw config parent");
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("removes staging when copied config bytes cannot be decoded", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const decodeDescriptorSnapshotContent = snapshotBoundary.decodeDescriptorSnapshotContent;
    const decode = vi
      .spyOn(snapshotBoundary, "decodeDescriptorSnapshotContent")
      .mockImplementationOnce(decodeDescriptorSnapshotContent)
      .mockReturnValue(null);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed canonical decoding of copied OpenClaw config",
    );
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("removes staging when in-memory credential stripping returns a non-object", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const stripCredentials = credentialFilter.stripCredentials;
    const strip = vi
      .spyOn(credentialFilter, "stripCredentials")
      .mockImplementationOnce(stripCredentials)
      .mockReturnValue([]);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed to sanitize prepared OpenClaw config in memory",
    );
    expect(strip).toHaveBeenCalledTimes(2);
  });

  it("removes staging when the prepared config cannot be installed", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const install = vi
      .spyOn(snapshotBoundary, "installDescriptorSnapshotFile")
      .mockReturnValue(false);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(
      home,
      logger,
      bundle,
      "Failed descriptor-bound installation of prepared OpenClaw config",
    );
    expect(install).toHaveBeenCalledOnce();
  });

  it("removes staging when the installed config cannot be sanitized", () => {
    const { home, configPath, logger } = makeMinimalHostSnapshot();
    const sanitize = vi
      .spyOn(snapshotSanitizer, "sanitizeOpenClawConfigFile")
      .mockReturnValue(false);

    const bundle = createSnapshotBundle(makeHostState(home, configPath), logger, {
      persist: false,
    });

    expectSnapshotFailure(home, logger, bundle, "Failed to sanitize prepared OpenClaw config");
    expect(sanitize).toHaveBeenCalledOnce();
  });
});

describe("migration-state config path security", () => {
  const expectPrototypeClean = (): void => {
    const probe: Record<string, unknown> = {};
    for (const key of ["polluted", "isAdmin", "bar"]) {
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, key)).toBe(false);
      expect(probe[key]).toBeUndefined();
    }
  };

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects prototype-related config path segment: %s",
    (segment) => {
      const doc: Record<string, unknown> = {};
      expect(() => {
        setConfigValue(doc, `${segment}.polluted`, "true");
      }).toThrow(/Unsafe config path segment/);
      expectPrototypeClean();
    },
  );

  it("rejects __proto__ in nested position", () => {
    const doc: Record<string, unknown> = {};
    expect(() => {
      setConfigValue(doc, "agents.__proto__.isAdmin", "true");
    }).toThrow(/Unsafe config path segment/);
    expectPrototypeClean();
  });

  it.each(["foo.prototype.bar", "foo.constructor.bar"])(
    "rejects prototype-related segment in nested config path: %s",
    (configPath) => {
      const doc: Record<string, unknown> = {};
      expect(() => {
        setConfigValue(doc, configPath, "true");
      }).toThrow(/Unsafe config path segment/);
      expectPrototypeClean();
    },
  );

  it("allows simple top-level keys", () => {
    const doc: Record<string, unknown> = {};
    setConfigValue(doc, "theme", "dark");
    expect(doc.theme).toBe("dark");
  });
});
