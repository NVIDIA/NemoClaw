// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs, {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_UNDICI_PATCHES,
  patchInstalledOpenClawUndici,
  patchVerifiedOfficialPluginUndici,
  UndiciPatchRecoveryError,
  hashPackageTree,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    rmSync: vi.fn(actual.rmSync),
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
vi.mock("../../../scripts/lib/reviewed-npm-archive.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../scripts/lib/reviewed-npm-archive.mts")>();
  return { ...actual, packReviewedNpmArchive: vi.fn(actual.packReviewedNpmArchive) };
});
import {
  failMetadataWrites,
  failBundleRestoration,
  interleavePatchWorkspace,
  createProjectLock,
  createInvalidProjectLock,
  claimLockDuringRelease,
  duringWorkspaceCleanup,
  redirectProjectLock,
} from "../../helpers/openclaw-undici-faults";
import { packReviewedNpmArchive } from "../../../scripts/lib/reviewed-npm-archive.mts";

beforeEach(async () => {
  vi.mocked(mkdtempSync).mockReset().mockImplementation(fs.mkdtempSync);
  vi.mocked(rmSync).mockReset().mockImplementation(fs.rmSync);
  vi.mocked(unlinkSync).mockReset().mockImplementation(fs.unlinkSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(fs.writeFileSync);
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
  vi.mocked(readFileSync).mockReset().mockImplementation(fs.readFileSync);
  const actual = await vi.importActual<
    typeof import("../../../scripts/lib/reviewed-npm-archive.mts")
  >("../../../scripts/lib/reviewed-npm-archive.mts");
  vi.mocked(packReviewedNpmArchive).mockReset().mockImplementation(actual.packReviewedNpmArchive);
});

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function metadataParseable(npmRoot: string): boolean {
  try {
    readJson(path.join(npmRoot, "package.json"));
    readJson(path.join(npmRoot, "package-lock.json"));
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
function fixture(packageName: keyof typeof OPENCLAW_UNDICI_PATCHES = "@openclaw/slack") {
  const state = fs.mkdtempSync(path.join(tmpdir(), "openclaw-undici-patch-"));
  roots.push(state);
  const npmRoot = path.join(state, "npm/projects/plugin");
  const plugin = path.join(npmRoot, "node_modules", packageName);
  const undici = path.join(plugin, "node_modules/undici");
  fs.mkdirSync(undici, { recursive: true });
  fs.writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: packageName, version: "2026.9.1" }),
  );
  fs.writeFileSync(
    path.join(undici, "package.json"),
    JSON.stringify({ name: "undici", version: OPENCLAW_UNDICI_PATCHES[packageName].affected }),
  );
  return { state, npmRoot, plugin, undici, packageName };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function replacementFixture(packageName: keyof typeof OPENCLAW_UNDICI_PATCHES) {
  const f = fixture(packageName);
  const patch = OPENCLAW_UNDICI_PATCHES[packageName];
  const originalPins = { ...patch };
  const location = `node_modules/${packageName}/node_modules/undici`;
  const project = { name: "fixture", private: true };
  const lock = { lockfileVersion: 3, packages: { [location]: { version: patch.affected } } };
  fs.writeFileSync(path.join(f.npmRoot, "package.json"), JSON.stringify(project));
  fs.writeFileSync(path.join(f.npmRoot, "package-lock.json"), JSON.stringify(lock));
  const replacement = path.join(f.state, "replacement/package");
  fs.mkdirSync(replacement, { recursive: true });
  fs.writeFileSync(
    path.join(replacement, "package.json"),
    JSON.stringify({ name: "undici", version: patch.version }),
  );
  const archivePath = path.join(f.state, "replacement.tgz");
  execFileSync("tar", ["-czf", archivePath, "-C", path.dirname(replacement), "package"]);
  // Synthetic pins retain real archive extraction and tree verification without npm downloads.
  patch.affectedTree = hashPackageTree(f.undici);
  patch.fixedTree = hashPackageTree(replacement);
  vi.mocked(packReviewedNpmArchive).mockReturnValue({ archivePath, rootDirectory: f.state });
  return {
    ...f,
    patch,
    project,
    lock,
    location,
    restorePins: () => Object.assign(patch, originalPins),
  };
}

function mockLinuxProcessIdentity() {
  const procFiles = new Map([
    ["/proc/sys/kernel/random/boot_id", "11111111-1111-1111-1111-111111111111\n"],
    [
      `/proc/${process.pid}/stat`,
      `${process.pid} (node worker) ${["S", ...Array(18).fill("0"), "100"].join(" ")}`,
    ],
  ]);
  vi.mocked(readFileSync).mockImplementation(
    (filename, options) => procFiles.get(String(filename)) ?? fs.readFileSync(filename, options),
  );
}

function interruptReplacement(f: ReturnType<typeof replacementFixture>, pid: number) {
  const workspace = fs.mkdtempSync(path.join(f.npmRoot, ".nemoclaw-undici-"));
  fs.writeFileSync(
    path.join(workspace, "recovery.json"),
    JSON.stringify({ packageName: f.packageName, pid }),
  );
  fs.renameSync(f.undici, path.join(workspace, "original"));
  return workspace;
}

describe("official OpenClaw bundled Undici patch", () => {
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "records the %s writer before downloading and cleans up a failed download",
    (packageName) => {
      const f = replacementFixture(packageName);
      let owner: unknown;
      vi.mocked(packReviewedNpmArchive).mockImplementation(({ tempDirectory }) => {
        owner = readJson(path.join(tempDirectory!, "recovery.json"));
        throw new Error("download failed");
      });
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow("download failed");
        expect(owner).toMatchObject({ packageName, pid: process.pid });
        expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
        expect(
          fs.readdirSync(f.npmRoot).filter((name) => name.startsWith(".nemoclaw-undici-")),
        ).toEqual([]);
      } finally {
        f.restorePins();
      }
    },
  );
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "rejects changed %s bundle contents even when the affected version matches",
    (packageName) => {
      const f = fixture(packageName);
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed bundled Undici tree");
      expect(JSON.parse(fs.readFileSync(path.join(f.undici, "package.json"), "utf8")).version).toBe(
        OPENCLAW_UNDICI_PATCHES[packageName].affected,
      );
      expect(fs.readdirSync(f.npmRoot)).toEqual(["node_modules"]);
    },
  );
  it("rejects a forged fixed-version manifest without accepting the package as patched", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.undici, "package.json"),
      JSON.stringify({ name: "undici", version: "7.29.1" }),
    );
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed bundled Undici tree");
  });
  it("rejects a different OpenClaw release before modifying its dependencies", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.plugin, "package.json"),
      JSON.stringify({ name: f.packageName, version: "2026.9.5" }),
    );
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("2026.9.1");
  });
  it("rejects a bundled dependency redirected through a symlink", () => {
    const f = fixture();
    const outside = path.join(f.state, "outside");
    fs.renameSync(f.undici, outside);
    fs.symlinkSync(outside, f.undici);
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("real directory");
    expect(fs.existsSync(path.join(outside, "package.json"))).toBe(true);
  });
  it("rejects a symlink inside the installed dependency before changing files", () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.plugin, "package.json"), path.join(f.undici, "linked.json"));
    expect(() => patchInstalledOpenClawUndici(f)).toThrow();
    expect(fs.lstatSync(path.join(f.undici, "linked.json")).isSymbolicLink()).toBe(true);
  });
  it("rejects inspection paths outside the managed npm projects", () => {
    const f = fixture();
    const outside = path.join(f.state, "other");
    fs.mkdirSync(outside);
    expect(() =>
      patchVerifiedOfficialPluginUndici({
        packageSpec: "@openclaw/slack@2026.9.1",
        installPath: path.join(outside, "node_modules/@openclaw/slack"),
        env: { OPENCLAW_STATE_DIR: f.state },
      }),
    ).toThrow("escaped");
  });
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "patches %s beneath a symlinked state directory",
    (packageName) => {
      const f = replacementFixture(packageName);
      const alias = `${f.state}-alias`;
      roots.push(alias);
      fs.symlinkSync(f.state, alias);
      try {
        expect(
          patchVerifiedOfficialPluginUndici({
            packageSpec: `${packageName}@2026.9.1`,
            installPath: path.join(alias, path.relative(f.state, f.plugin)),
            env: { OPENCLAW_STATE_DIR: alias },
          }),
        ).toBe(true);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      } finally {
        f.restorePins();
      }
    },
  );
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "rejects a symlinked %s plugin directory without modifying its target",
    (packageName) => {
      const f = fixture(packageName);
      const outside = path.join(f.state, "outside");
      fs.renameSync(f.plugin, outside);
      fs.symlinkSync(outside, f.plugin);
      const before = hashPackageTree(outside);
      expect(() =>
        patchVerifiedOfficialPluginUndici({
          packageSpec: `${packageName}@2026.9.1`,
          installPath: f.plugin,
          env: { OPENCLAW_STATE_DIR: f.state },
        }),
      ).toThrow();
      expect(hashPackageTree(outside)).toBe(before);
      expect(fs.lstatSync(f.plugin).isSymbolicLink()).toBe(true);
    },
  );
  it("requires an absolute path from official plugin inspection", () => {
    expect(() =>
      patchVerifiedOfficialPluginUndici({
        packageSpec: "@openclaw/slack@2026.9.1",
        installPath: "relative",
        env: {},
      }),
    ).toThrow("absolute install path");
  });
  it.each(["@openclaw/msteams@2026.9.1", "@openclaw/slack@2026.9.5"])(
    "leaves %s outside the patch scope untouched",
    (packageSpec) => {
      expect(
        patchVerifiedOfficialPluginUndici({ packageSpec, installPath: undefined, env: {} }),
      ).toBe(false);
    },
  );
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "patches %s and persists matching metadata without leaving a workspace",
    (packageName) => {
      const f = replacementFixture(packageName);
      try {
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(readJson(path.join(f.undici, "package.json"))).toEqual({
          name: "undici",
          version: f.patch.version,
        });
        expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual({
          ...f.project,
          overrides: { [packageName]: { undici: f.patch.version } },
        });
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual({
          lockfileVersion: 3,
          packages: {
            [f.location]: {
              version: f.patch.version,
              resolved: `https://registry.npmjs.org/undici/-/undici-${f.patch.version}.tgz`,
              integrity: f.patch.integrity,
            },
          },
        });
        expect(fs.readdirSync(f.npmRoot).sort()).toEqual([
          "node_modules",
          "package-lock.json",
          "package.json",
        ]);
        patchInstalledOpenClawUndici(f);
        expect(packReviewedNpmArchive).toHaveBeenCalledTimes(1);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      } finally {
        f.restorePins();
      }
    },
  );
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "removes an exited %s workspace recorded before the first rename",
    (packageName) => {
      const f = replacementFixture(packageName);
      const exited = spawnSync(process.execPath, ["-e", ""]);
      const workspace = interruptReplacement(f, exited.pid);
      fs.renameSync(path.join(workspace, "original"), f.undici);
      try {
        patchInstalledOpenClawUndici(f);
        expect(fs.existsSync(workspace)).toBe(false);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toMatchObject({
          overrides: { [packageName]: { undici: f.patch.version } },
        });
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toMatchObject({
          packages: { [f.location]: { version: f.patch.version, integrity: f.patch.integrity } },
        });
      } finally {
        f.restorePins();
      }
    },
  );
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "rejects an active %s writer before the first rename",
    (packageName) => {
      const f = replacementFixture(packageName);
      const workspace = interruptReplacement(f, process.pid);
      fs.renameSync(path.join(workspace, "original"), f.undici);
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow("still running");
        expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
        expect(fs.existsSync(workspace)).toBe(true);
        expect(packReviewedNpmArchive).not.toHaveBeenCalled();
      } finally {
        f.restorePins();
      }
    },
  );
  it("restores an interrupted replacement before permitting a fresh retry", () => {
    const f = replacementFixture("@openclaw/slack");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    expect(exited.status).toBe(0);
    const workspace = interruptReplacement(f, exited.pid);
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(
        "Original Undici bundle restored after interruption; retry the operation",
      );
      expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
      expect(fs.existsSync(workspace)).toBe(false);
      expect(packReviewedNpmArchive).not.toHaveBeenCalled();
      patchInstalledOpenClawUndici(f);
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
    } finally {
      f.restorePins();
    }
  });
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "finishes metadata and removes the interrupted workspace for a fixed %s bundle",
    (packageName) => {
      const f = replacementFixture(packageName);
      const exited = spawnSync(process.execPath, ["-e", ""]);
      const workspace = interruptReplacement(f, exited.pid);
      fs.cpSync(path.join(f.state, "replacement/package"), f.undici, { recursive: true });
      try {
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toMatchObject({
          overrides: { [packageName]: { undici: f.patch.version } },
        });
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toMatchObject({
          packages: {
            [f.location]: { version: f.patch.version, integrity: f.patch.integrity },
          },
        });
        expect(fs.existsSync(workspace)).toBe(false);
        expect(packReviewedNpmArchive).not.toHaveBeenCalled();
      } finally {
        f.restorePins();
      }
    },
  );
  it("preserves a fixed bundle and its recovery workspace while the writer is active", () => {
    const f = replacementFixture("@openclaw/slack");
    const workspace = interruptReplacement(f, process.pid);
    fs.cpSync(path.join(f.state, "replacement/package"), f.undici, { recursive: true });
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("still running");
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      expect(hashPackageTree(path.join(workspace, "original"))).toBe(f.patch.affectedTree);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
    } finally {
      f.restorePins();
    }
  });
  it("retains an interrupted fixed bundle workspace when metadata cannot be written", () => {
    const f = replacementFixture("@openclaw/slack");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const workspace = interruptReplacement(f, exited.pid);
    fs.cpSync(path.join(f.state, "replacement/package"), f.undici, { recursive: true });
    const failure = failMetadataWrites(["project.next", "project.original"], new Error("ENOSPC"));
    vi.mocked(writeFileSync).mockImplementation(failure.write);
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(UndiciPatchRecoveryError);
      expect(failure.reached()).toBe(true);
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      expect(hashPackageTree(path.join(workspace, "original"))).toBe(f.patch.affectedTree);
    } finally {
      f.restorePins();
    }
  });
  it.each([
    ["@openclaw/slack", "package.json"],
    ["@openclaw/slack", "package-lock.json"],
    ["@openclaw/discord", "package.json"],
    ["@openclaw/discord", "package-lock.json"],
  ] as const)(
    "reports the retained %s backup after rolling back a failed %s write",
    (packageName, file) => {
      const f = replacementFixture(packageName);
      const exited = spawnSync(process.execPath, ["-e", ""]);
      expect(exited.status).toBe(0);
      const workspace = interruptReplacement(f, exited.pid);
      fs.cpSync(path.join(f.state, "replacement/package"), f.undici, { recursive: true });
      const npmRoot = fs.realpathSync(f.npmRoot);
      const manifestPath = path.join(npmRoot, "package.json");
      const lockPath = path.join(npmRoot, "package-lock.json");
      const writeError = new Error("ENOSPC: recovery metadata write failed");
      const stagedName = file === "package.json" ? "project.next" : "lock.next";
      const failureInjection = failMetadataWrites([stagedName], writeError, true);
      vi.mocked(writeFileSync).mockImplementation(failureInjection.write);
      try {
        let failure: unknown;
        try {
          patchInstalledOpenClawUndici(f);
        } catch (error) {
          failure = error;
        }
        expect(failureInjection.reached()).toBe(true);
        expect(failure).toBeInstanceOf(UndiciPatchRecoveryError);
        expect(failure).toMatchObject({
          cause: writeError,
          message: expect.stringContaining(JSON.stringify(fs.realpathSync(workspace))),
        });
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(hashPackageTree(path.join(workspace, "original"))).toBe(f.patch.affectedTree);
        expect(readJson(manifestPath)).toEqual(f.project);
        expect(readJson(lockPath)).toEqual(f.lock);
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(fs.existsSync(workspace)).toBe(false);
      } finally {
        f.restorePins();
      }
    },
  );
  it.each([
    ["@openclaw/slack", "package.json"],
    ["@openclaw/slack", "package-lock.json"],
    ["@openclaw/discord", "package.json"],
    ["@openclaw/discord", "package-lock.json"],
  ] as const)(
    "preserves metadata after partial %s %s writes and rollback failure",
    (packageName, file) => {
      const f = replacementFixture(packageName);
      const manifestPath = path.join(f.npmRoot, "package.json");
      const lockPath = path.join(f.npmRoot, "package-lock.json");
      fs.chmodSync(manifestPath, 0o600);
      fs.chmodSync(lockPath, 0o640);
      const originalUmask = process.umask(0o077);
      const prefix = new Map([
        ["package.json", "project"],
        ["package-lock.json", "lock"],
      ]).get(file);
      const failWrite: typeof fs.writeFileSync = (filename, _contents, options) => {
        fs.writeFileSync(filename, "{", options);
        throw new Error("ENOSPC: partial metadata write");
      };
      const writes = new Map<string, typeof fs.writeFileSync>([
        [`${prefix}.next`, failWrite],
        [`${prefix}.original`, failWrite],
      ]);
      vi.mocked(writeFileSync).mockImplementation((filename, contents, options) =>
        (writes.get(path.basename(String(filename))) ?? fs.writeFileSync)(
          filename,
          contents,
          options,
        ),
      );
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow("rollback failed");
        expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
        expect(readJson(manifestPath)).toEqual(f.project);
        expect(readJson(lockPath)).toEqual(f.lock);
        vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(readJson<Record<string, any>>(manifestPath).overrides[packageName].undici).toBe(
          f.patch.version,
        );
        expect(readJson<Record<string, any>>(lockPath).packages[f.location].version).toBe(
          f.patch.version,
        );
        expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(lockPath).mode & 0o777).toBe(0o640);
        expect(
          fs.readdirSync(f.npmRoot).filter((name) => name.startsWith(".nemoclaw-undici-")),
        ).toEqual([]);
      } finally {
        process.umask(originalUmask);
        f.restorePins();
      }
    },
  );
  it("preserves an unverified retained workspace beside a fixed bundle", () => {
    const f = replacementFixture("@openclaw/slack");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const workspace = interruptReplacement(f, exited.pid);
    fs.cpSync(path.join(f.state, "replacement/package"), f.undici, { recursive: true });
    fs.writeFileSync(path.join(workspace, "original", "unexpected.js"), "changed");
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed Undici recovery bundle");
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      expect(fs.readFileSync(path.join(workspace, "original", "unexpected.js"), "utf8")).toBe(
        "changed",
      );
    } finally {
      f.restorePins();
    }
  });
  it("does not restore a bundle while its patch process is still running", () => {
    const f = replacementFixture("@openclaw/slack");
    const workspace = interruptReplacement(f, process.pid);
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(
        "Undici patch process is still running",
      );
      expect(fs.existsSync(f.undici)).toBe(false);
      expect(hashPackageTree(path.join(workspace, "original"))).toBe(f.patch.affectedTree);
    } finally {
      f.restorePins();
    }
  });
  it.each([
    ["reused PID", "11111111-1111-1111-1111-111111111111:99", true],
    ["earlier boot", "22222222-2222-2222-2222-222222222222:100", true],
    ["same writer", "11111111-1111-1111-1111-111111111111:100", false],
  ])("checks process identity when the recovery record names a %s", (_, identity, restores) => {
    const f = replacementFixture("@openclaw/slack");
    const workspace = interruptReplacement(f, process.pid);
    fs.writeFileSync(
      path.join(workspace, "recovery.json"),
      JSON.stringify({ packageName: f.packageName, pid: process.pid, processIdentity: identity }),
    );
    mockLinuxProcessIdentity();
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(
        restores
          ? "Original Undici bundle restored after interruption; retry the operation"
          : "Undici patch process is still running",
      );
      expect(fs.existsSync(f.undici)).toBe(restores);
      expect(hashPackageTree(restores ? f.undici : path.join(workspace, "original"))).toBe(
        f.patch.affectedTree,
      );
      expect(fs.existsSync(workspace)).toBe(!restores);
      expect(packReviewedNpmArchive).not.toHaveBeenCalled();
    } finally {
      f.restorePins();
    }
  });
  it("retains an unverified recovery bundle without installing it", () => {
    const f = replacementFixture("@openclaw/slack");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const workspace = interruptReplacement(f, exited.pid);
    fs.writeFileSync(path.join(workspace, "original", "unexpected.js"), "changed");
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("Unreviewed Undici recovery bundle");
      expect(fs.existsSync(f.undici)).toBe(false);
      expect(fs.existsSync(path.join(workspace, "original", "unexpected.js"))).toBe(true);
    } finally {
      f.restorePins();
    }
  });
  it.each(["workspace", "original", "record"])(
    "rejects a recovery %s symlink without following it",
    (entry) => {
      const f = replacementFixture("@openclaw/slack");
      const exited = spawnSync(process.execPath, ["-e", ""]);
      const workspace = interruptReplacement(f, exited.pid);
      const target =
        entry === "workspace"
          ? workspace
          : path.join(workspace, entry === "record" ? "recovery.json" : "original");
      const outside = path.join(f.state, "outside");
      fs.renameSync(target, outside);
      fs.symlinkSync(outside, target);
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow();
        expect(fs.existsSync(f.undici)).toBe(false);
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(outside)).toBe(true);
      } finally {
        f.restorePins();
      }
    },
  );
  it("retains ambiguous recovery bundles for inspection", () => {
    const f = replacementFixture("@openclaw/slack");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const workspace = interruptReplacement(f, exited.pid);
    const duplicate = fs.mkdtempSync(path.join(f.npmRoot, ".nemoclaw-undici-"));
    fs.cpSync(workspace, duplicate, { recursive: true });
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("Multiple Undici recovery bundles");
      expect(fs.existsSync(f.undici)).toBe(false);
      expect(fs.existsSync(path.join(workspace, "original"))).toBe(true);
      expect(fs.existsSync(path.join(duplicate, "original"))).toBe(true);
    } finally {
      f.restorePins();
    }
  });
  it("retains the verified backup when bundle rollback cannot restore it", () => {
    const f = replacementFixture("@openclaw/slack");
    mockLinuxProcessIdentity();
    vi.mocked(renameSync).mockImplementation(failBundleRestoration(fs.realpathSync(f.undici)));
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(
        "recovery is incomplete; recovery workspace retained",
      );
      const workspaces = fs
        .readdirSync(f.npmRoot)
        .filter((name) => name.startsWith(".nemoclaw-undici-"));
      expect(workspaces).toHaveLength(1);
      expect(readJson(path.join(f.npmRoot, workspaces[0]!, "recovery.json"))).toEqual({
        packageName: f.packageName,
        pid: process.pid,
        processIdentity: "11111111-1111-1111-1111-111111111111:100",
      });
      expect(hashPackageTree(path.join(f.npmRoot, workspaces[0]!, "original"))).toBe(
        f.patch.affectedTree,
      );
      expect(fs.existsSync(f.undici)).toBe(false);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
    } finally {
      f.restorePins();
    }
  });
  it("removes an exhausted rollback workspace before a later interrupted replacement", () => {
    const f = replacementFixture("@openclaw/slack");
    const failure = failMetadataWrites(
      ["project.next", "project.original"],
      new Error("ENOSPC: metadata write failed"),
    );
    vi.mocked(writeFileSync).mockImplementation(failure.write);
    try {
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("rollback failed");
      expect(failure.reached()).toBe(true);
      expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
      expect(fs.readdirSync(f.npmRoot).sort()).toEqual([
        "node_modules",
        "package-lock.json",
        "package.json",
      ]);
      vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
      const exited = spawnSync(process.execPath, ["-e", ""]);
      expect(exited.status).toBe(0);
      const workspace = interruptReplacement(f, exited.pid);
      expect(() => patchInstalledOpenClawUndici(f)).toThrow(
        "Original Undici bundle restored after interruption; retry the operation",
      );
      expect(fs.existsSync(workspace)).toBe(false);
      expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
      patchInstalledOpenClawUndici(f);
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
    } finally {
      f.restorePins();
    }
  });
});

describe("OpenClaw Undici metadata recovery", () => {
  it.each(["project.next", "lock.next"] as const)(
    "keeps both project files parseable when the %s write stops midway",
    (stagedName) => {
      const f = replacementFixture("@openclaw/slack");
      try {
        let interrupted = false;
        let parseableAtInterruption = false;
        const interrupt = (filename: fs.PathOrFileDescriptor): never => {
          interrupted = true;
          fs.writeFileSync(filename, "{");
          parseableAtInterruption = metadataParseable(f.npmRoot);
          throw new Error("interrupted metadata write");
        };
        vi.mocked(writeFileSync).mockImplementation((filename, data, options) =>
          !interrupted && String(filename).endsWith(`/${stagedName}`)
            ? interrupt(filename)
            : fs.writeFileSync(filename, data, options),
        );
        expect(() => patchInstalledOpenClawUndici(f)).toThrow("interrupted metadata write");
        expect(interrupted).toBe(true);
        expect(parseableAtInterruption).toBe(true);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      } finally {
        f.restorePins();
      }
    },
  );

  it("keeps the last complete metadata when rollback stops midway", () => {
    const f = replacementFixture("@openclaw/slack");
    try {
      let rollbackInterrupted = false;
      let parseableAtInterruption = false;
      vi.mocked(writeFileSync).mockImplementation((filename, data, options) => {
        switch (path.basename(String(filename))) {
          case "lock.next":
            throw new Error("metadata write failed");
          case "project.original":
            rollbackInterrupted = true;
            fs.writeFileSync(filename, "{");
            parseableAtInterruption = metadataParseable(f.npmRoot);
            throw new Error("interrupted rollback");
          default:
            return fs.writeFileSync(filename, data, options);
        }
      });
      expect(() => patchInstalledOpenClawUndici(f)).toThrowError(
        expect.objectContaining({
          name: "UndiciPatchRecoveryError",
          message: expect.stringContaining('metadata rollback failed for "@openclaw/slack"; retry'),
          cause: expect.any(AggregateError),
        }),
      );
      expect(rollbackInterrupted).toBe(true);
      expect(parseableAtInterruption).toBe(true);
      expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
      vi.mocked(writeFileSync).mockImplementation(fs.writeFileSync);
      patchInstalledOpenClawUndici(f);
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
      expect(readJson(path.join(f.npmRoot, "package.json"))).toMatchObject({
        overrides: { [f.packageName]: { undici: f.patch.version } },
      });
      expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toMatchObject({
        packages: {
          [`node_modules/${f.packageName}/node_modules/undici`]: { version: f.patch.version },
        },
      });
    } finally {
      f.restorePins();
    }
  });
  it("preserves metadata permissions under a restrictive process umask", () => {
    const f = replacementFixture("@openclaw/slack");
    try {
      const manifest = path.join(f.npmRoot, "package.json");
      const lock = path.join(f.npmRoot, "package-lock.json");
      fs.chmodSync(manifest, 0o640);
      fs.chmodSync(lock, 0o644);
      const originalUmask = process.umask(0o077);
      try {
        patchInstalledOpenClawUndici(f);
        expect(fs.statSync(manifest).mode & 0o777).toBe(0o640);
        expect(fs.statSync(lock).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(originalUmask);
      }
    } finally {
      f.restorePins();
    }
  });
});

describe("Undici project transaction ownership", () => {
  it.each(["@openclaw/slack", "@openclaw/discord"] as const)(
    "rejects overlapping %s attempts before stale rollback can undo a completed patch",
    (packageName) => {
      const f = replacementFixture(packageName);
      let overlap: unknown;
      const failure = failMetadataWrites(["lock.next"], new Error("overlap rollback probe"), true);
      vi.mocked(mkdtempSync).mockImplementation(
        interleavePatchWorkspace(f.npmRoot, () => {
          try {
            patchInstalledOpenClawUndici(f);
          } catch (error) {
            overlap = error;
          }
          vi.mocked(writeFileSync).mockImplementation(failure.write);
        }),
      );
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow("overlap rollback probe");
        expect(overlap).toBeInstanceOf(Error);
        expect(String(overlap)).toContain("still running");
        expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
        expect(readJson(path.join(f.npmRoot, "package.json"))).toEqual(f.project);
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(
          readJson<any>(path.join(f.npmRoot, "package.json")).overrides[packageName].undici,
        ).toBe(f.patch.version);
        expect(
          readJson<any>(path.join(f.npmRoot, "package-lock.json")).packages[f.location].version,
        ).toBe(f.patch.version);
        expect(fs.existsSync(path.join(f.npmRoot, ".nemoclaw-undici.lock"))).toBe(false);
      } finally {
        f.restorePins();
      }
    },
  );

  it("locks the canonical project across plugin names during metadata-only repair", () => {
    const f = replacementFixture("@openclaw/slack");
    try {
      patchInstalledOpenClawUndici(f);
      const alias = path.join(f.state, "project-alias");
      fs.symlinkSync(f.npmRoot, alias);
      let entered = false;
      let overlap: unknown;
      vi.mocked(mkdtempSync).mockImplementation(
        interleavePatchWorkspace(f.npmRoot, () => {
          entered = true;
          try {
            patchInstalledOpenClawUndici({ npmRoot: alias, packageName: "@openclaw/discord" });
          } catch (error) {
            overlap = error;
          }
        }),
      );
      patchInstalledOpenClawUndici(f);
      expect(entered).toBe(true);
      expect(String(overlap)).toContain("still running");
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
    } finally {
      f.restorePins();
    }
  });

  it.each(["empty", "exited"])(
    "recovers a %s project lock without accepting a live writer",
    (state) => {
      const f = replacementFixture("@openclaw/slack");
      const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
      expect(child.status).toBe(0);
      const directory = createProjectLock(f.npmRoot, state === "exited" ? child.pid : undefined);
      try {
        patchInstalledOpenClawUndici(f);
        expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
        expect(fs.existsSync(directory)).toBe(false);
      } finally {
        f.restorePins();
      }
    },
  );

  it.each(["symlink", "malformed"])(
    "rejects a %s project lock before changing metadata",
    (kind) => {
      const f = replacementFixture("@openclaw/slack");
      const target = path.join(f.state, "foreign-lock");
      createInvalidProjectLock(f.npmRoot, target, kind);
      try {
        expect(() => patchInstalledOpenClawUndici(f)).toThrow();
        expect(hashPackageTree(f.undici)).toBe(f.patch.affectedTree);
        expect(readJson(path.join(f.npmRoot, "package-lock.json"))).toEqual(f.lock);
        expect(fs.readFileSync(path.join(target, "foreign"), "utf8")).toBe("retain");
      } finally {
        f.restorePins();
      }
    },
  );

  it("does not remove a successor that claims the lock during release", () => {
    const f = replacementFixture("@openclaw/slack");
    const directory = path.join(f.npmRoot, ".nemoclaw-undici.lock");
    const successor = "owner-22222222-2222-2222-2222-222222222222.json";
    vi.mocked(unlinkSync).mockImplementation(claimLockDuringRelease(f.npmRoot, successor));
    try {
      patchInstalledOpenClawUndici(f);
      expect(fs.readdirSync(directory)).toEqual([successor]);
      expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
    } finally {
      f.restorePins();
    }
  });
});

it("holds project ownership until the replacement workspace cleanup completes", () => {
  const f = replacementFixture("@openclaw/slack");
  let checked = false;
  vi.mocked(rmSync).mockImplementation(
    duringWorkspaceCleanup(() => {
      checked = true;
      expect(() => patchInstalledOpenClawUndici(f)).toThrow("still running");
    }),
  );
  try {
    patchInstalledOpenClawUndici(f);
    expect(checked).toBe(true);
    expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
    expect(fs.existsSync(path.join(f.npmRoot, ".nemoclaw-undici.lock"))).toBe(false);
  } finally {
    f.restorePins();
  }
});

it("preserves foreign ownership when the project lock becomes a symlink before release", () => {
  const f = replacementFixture("@openclaw/slack");
  let foreignOwner = "";
  vi.mocked(rmSync).mockImplementation(
    duringWorkspaceCleanup(() => {
      foreignOwner = redirectProjectLock(f.npmRoot, path.join(f.state, "foreign-lock"));
    }),
  );
  try {
    expect(() => patchInstalledOpenClawUndici(f)).toThrow("Invalid Undici project lock directory");
    expect(foreignOwner).not.toBe("");
    expect(readJson(foreignOwner)).toMatchObject({ pid: process.pid });
    expect(hashPackageTree(f.undici)).toBe(f.patch.fixedTree);
  } finally {
    f.restorePins();
  }
});
