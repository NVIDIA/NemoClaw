// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reconcileBundledPackageBackup,
  replaceBundledPackage,
  restoreMissingBundledPackage,
} from "../../scripts/lib/bundled-npm-package.mts";

import {
  alterBackupCopy,
  alterPublishedBackup,
  racePackageFileOpen,
  snapshotBackupFiles,
} from "../support/bundled-npm-recovery-faults.js";

const roots: string[] = [];
const helper = new URL("../../scripts/lib/bundled-npm-package.mts", import.meta.url).href;
const markerName = "nemoclaw-owner.json";

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(packageName: "undici" | "ip-address") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "npm-stage-recovery-")));
  roots.push(root);
  const npmRoot = path.join(root, "npm");
  const parent = path.join(npmRoot, "node_modules");
  const live = path.join(parent, packageName);
  const replacementRoot = path.join(root, "replacement");
  for (const [directory, version] of [
    [live, "old"],
    [replacementRoot, "fixed"],
  ]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
    fs.writeFileSync(path.join(directory, "payload"), version);
  }
  const stages = () =>
    fs.readdirSync(parent).filter((name) => name.startsWith(`.${packageName}.nemoclaw-stage-`));
  const options = {
    npmRoot,
    packageName,
    verifyBackup(manifest: Record<string, unknown>) {
      expect(manifest).toEqual({ name: packageName, version: "old" });
    },
  };
  function interrupt(point = "staged-copy") {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [helper, npmRoot, packageName, replacementRoot, point] = process.argv.slice(1);
      const { replaceBundledPackage } = await import(helper);
      const copy = fs.cpSync;
      const rename = fs.renameSync;
      const kill = () => process.kill(process.pid, "SIGKILL");
      fs.cpSync = (source, destination, options) => {
        if (point === "partial-backup" && String(source).endsWith("/node_modules/" + packageName)) {
          fs.mkdirSync(destination, { recursive: true });
          copy(String(source) + "/package.json", String(destination) + "/package.json");
          kill();
        }
        copy(source, destination, options);
        if (point === "staged-copy" && String(destination).endsWith("/replacement")) kill();
        if (point === "backup-copy" && String(source).endsWith("/node_modules/" + packageName)) kill();
      };
      fs.renameSync = (source, destination) => {
        const promotion = String(source).endsWith("/replacement");
        const receipt = String(destination).endsWith("/nemoclaw-owner.json");
        if (point === "before-backup-receipt" && receipt) kill();
        if (point === "before-promotion" && promotion) kill();
        rename(source, destination);
        if (point === "after-backup-receipt" && receipt) kill();
        if (point === "after-promotion" && promotion) kill();
        if (point === "backup-publication" && String(destination).includes(".nemoclaw-backup-")) kill();
      };
      syncBuiltinESMExports();
      replaceBundledPackage({ npmRoot, packageName, replacementRoot, verify: () => true });
      throw new Error("interruption was not reached");
    `,
        helper,
        npmRoot,
        packageName,
        replacementRoot,
        point,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal, child.stderr).toBe("SIGKILL");
    return path.join(parent, stages().at(-1)!);
  }
  return { root, parent, live, replacementRoot, stages, options, interrupt };
}

function alterMarker(markerPath: string, changes: Record<string, unknown>): void {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, ...changes }));
}

describe.each(["undici", "ip-address"] as const)("%s staging recovery", (packageName) => {
  it.each([
    "partial-backup",
    "backup-copy",
    "before-backup-receipt",
    "after-backup-receipt",
    "backup-publication",
  ])(
    "retries after a hard kill at %s without manual cleanup or changing original bytes",
    (point) => {
      const f = fixture(packageName);
      f.interrupt(point);
      expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
      restoreMissingBundledPackage(f.options);
      reconcileBundledPackageBackup({ ...f.options, fixed: false });
      expect(fs.readdirSync(f.parent)).toEqual([packageName]);
      expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
      expect(
        replaceBundledPackage({
          ...f.options,
          replacementRoot: f.replacementRoot,
          verify: () => fs.readFileSync(path.join(f.live, "payload"), "utf8"),
        }),
      ).toBe("fixed");
      expect(fs.readdirSync(f.parent)).toEqual([packageName]);
    },
  );

  it("reclaims interrupted copies on retry without touching unknown stages or original bytes", () => {
    const f = fixture(packageName);
    f.interrupt();
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
    f.interrupt();
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
    f.interrupt();
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
    expect(f.stages()).toHaveLength(3);
    const unknown = path.join(f.parent, `.${packageName}.nemoclaw-stage-unknown`);
    fs.mkdirSync(unknown);
    fs.writeFileSync(path.join(unknown, "payload"), "unowned");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    restoreMissingBundledPackage(f.options);
    expect(f.stages()).toEqual([path.basename(unknown)]);
    expect(fs.readFileSync(path.join(unknown, "payload"), "utf8")).toBe("unowned");
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("staging recovery incomplete"));
    expect(
      replaceBundledPackage({
        ...f.options,
        replacementRoot: f.replacementRoot,
        verify: () => fs.readFileSync(path.join(f.live, "payload"), "utf8"),
      }),
    ).toBe("fixed");
    expect(f.stages()).toEqual([path.basename(unknown)]);
    expect(fs.readdirSync(f.parent).filter((name) => name.includes(".nemoclaw-backup-"))).toEqual(
      [],
    );
  });

  it.each([
    "changed-live",
    "partial-backup",
    "changed-backup",
    "wrong-inode",
    "wrong-digest",
    "escaped-name",
    "linked-backup",
    "hardlinked-file",
    "multiple-backups",
    "missing-marker",
  ])("retains the backup when published recovery has %s", (scenario) => {
    const f = fixture(packageName);
    const stage = f.interrupt("backup-publication");
    const markerPath = path.join(stage, markerName);
    const retainedBackup = alterPublishedBackup(f, markerPath, scenario);
    const backupBeforeRecovery = snapshotBackupFiles(retainedBackup);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    restoreMissingBundledPackage(f.options);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("staging recovery incomplete"));
    expect(fs.existsSync(stage)).toBe(true);
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe(
      scenario === "changed-live" ? "new" : "old",
    );
    expect(snapshotBackupFiles(retainedBackup)).toEqual(backupBeforeRecovery);
    expect(() => reconcileBundledPackageBackup({ ...f.options, fixed: false })).toThrow(
      /retained backup/,
    );
  });

  it("retains a published backup when live file permissions change as comparison opens it", () => {
    const f = fixture(packageName);
    const payload = path.join(f.live, "payload");
    fs.chmodSync(payload, 0o644);
    const stage = f.interrupt("backup-publication");
    const marker = JSON.parse(fs.readFileSync(path.join(stage, markerName), "utf8"));
    const backup = path.join(f.parent, marker.backup.name);
    const originalBackup = snapshotBackupFiles(backup);
    const open = fs.openSync;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const intercepted = vi
      .spyOn(fs, "openSync")
      .mockImplementation(racePackageFileOpen(open, payload, () => fs.chmodSync(payload, 0o600)));
    try {
      syncBuiltinESMExports();
      restoreMissingBundledPackage(f.options);
    } finally {
      intercepted.mockRestore();
      syncBuiltinESMExports();
    }
    const payloadDescriptor = fs.openSync(
      payload,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      expect(fs.fstatSync(payloadDescriptor).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(payloadDescriptor, "utf8")).toBe("old");
    } finally {
      fs.closeSync(payloadDescriptor);
    }
    expect(fs.existsSync(stage)).toBe(true);
    expect(snapshotBackupFiles(backup)).toEqual(originalBackup);
    expect(fs.statSync(path.join(backup, "payload")).mode & 0o777).toBe(0o644);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("staging recovery incomplete"));
    expect(() => reconcileBundledPackageBackup({ ...f.options, fixed: false })).toThrow(
      /retained backup/,
    );
  });

  it("recovers an identical nested package without changing executable permissions", () => {
    const f = fixture(packageName);
    const directory = path.join(f.live, "nested", "bin");
    const executable = path.join(directory, "tool");
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    f.interrupt("backup-publication");
    restoreMissingBundledPackage(f.options);
    reconcileBundledPackageBackup({ ...f.options, fixed: false });
    expect(fs.readdirSync(f.parent)).toEqual([packageName]);
    expect(fs.readFileSync(executable, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(fs.statSync(executable).mode & 0o777).toBe(0o755);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("retains the original when a backup copy changes restrictive directory permissions", () => {
    const f = fixture(packageName);
    const directory = path.join(f.live, "private");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "payload"), "private bytes");
    const verify = vi.fn();
    const copy = fs.cpSync;
    const intercepted = vi.spyOn(fs, "cpSync").mockImplementation(
      alterBackupCopy(copy, f.live, (destination) => {
        fs.chmodSync(path.join(destination, "private"), 0o755);
      }),
    );
    try {
      syncBuiltinESMExports();
      expect(() =>
        replaceBundledPackage({
          ...f.options,
          replacementRoot: f.replacementRoot,
          verify,
        }),
      ).toThrow(/original package changed while preparing its backup/);
    } finally {
      intercepted.mockRestore();
      syncBuiltinESMExports();
    }
    expect(verify).not.toHaveBeenCalled();
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("private bytes");
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
    expect(fs.readdirSync(f.parent)).toEqual([packageName]);
  });

  it.each([false, true])(
    "retains original backup bytes when a file becomes a symlink (after open: %s)",
    (afterOpen) => {
      const f = fixture(packageName);
      const stage = f.interrupt("backup-publication");
      const marker = JSON.parse(fs.readFileSync(path.join(stage, markerName), "utf8"));
      const backup = path.join(f.parent, marker.backup.name);
      const originalBackup = snapshotBackupFiles(backup);
      const payload = path.join(f.live, "payload");
      const retained = path.join(f.root, "original-payload");
      const outside = path.join(f.root, "outside");
      fs.writeFileSync(outside, "untouched");
      const open = fs.openSync;
      const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
      const intercepted = vi.spyOn(fs, "openSync").mockImplementation(
        racePackageFileOpen(
          open,
          payload,
          () => {
            fs.renameSync(payload, retained);
            fs.symlinkSync(outside, payload);
          },
          afterOpen,
        ),
      );
      try {
        syncBuiltinESMExports();
        restoreMissingBundledPackage(f.options);
      } finally {
        intercepted.mockRestore();
        syncBuiltinESMExports();
      }
      expect(fs.readFileSync(retained, "utf8")).toBe("old");
      expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
      expect(fs.lstatSync(payload).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(stage)).toBe(true);
      expect(snapshotBackupFiles(backup)).toEqual(originalBackup);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("staging recovery incomplete"),
      );
      expect(() => reconcileBundledPackageBackup({ ...f.options, fixed: false })).toThrow(
        /retained backup/,
      );
    },
  );

  it.each(["before-promotion", "after-promotion"])(
    "recovers a hard kill %s while preserving the recoverable package",
    (point) => {
      const f = fixture(packageName);
      f.interrupt(point);
      restoreMissingBundledPackage(f.options);
      expect(f.stages()).toEqual([]);
      expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe(
        point === "before-promotion" ? "old" : "fixed",
      );
      reconcileBundledPackageBackup({ ...f.options, fixed: point === "after-promotion" });
      expect(fs.readdirSync(f.parent)).toEqual([packageName]);
    },
  );

  it.each([
    {
      scenario: "wrong-package",
      mutate: ({ markerPath }) => alterMarker(markerPath, { packageName: "another-package" }),
    },
    {
      scenario: "wrong-inode",
      mutate: ({ markerPath }) => alterMarker(markerPath, { stageInode: -1 }),
    },
    {
      scenario: "other-scope",
      mutate: ({ markerPath }) => alterMarker(markerPath, { processScope: "another-host" }),
    },
    {
      scenario: "active-pid",
      mutate: ({ markerPath }) => alterMarker(markerPath, { pid: process.pid }),
    },
    { scenario: "malformed", mutate: ({ markerPath }) => fs.writeFileSync(markerPath, "{") },
    { scenario: "missing-marker", mutate: ({ markerPath }) => fs.unlinkSync(markerPath) },
    {
      scenario: "marker-link",
      mutate: ({ markerPath, outside }) => {
        fs.unlinkSync(markerPath);
        fs.symlinkSync(outside, markerPath);
      },
    },
    {
      scenario: "hardlinked-marker",
      mutate: ({ markerPath, root }) => fs.linkSync(markerPath, path.join(root, "marker-copy")),
    },
    { scenario: "public-marker", mutate: ({ markerPath }) => fs.chmodSync(markerPath, 0o644) },
    { scenario: "public-stage", mutate: ({ stage }) => fs.chmodSync(stage, 0o755) },
    { scenario: "public-parent", mutate: ({ parent }) => fs.chmodSync(parent, 0o777) },
    {
      scenario: "unsafe-tree",
      mutate: ({ stage, outside }) => fs.symlinkSync(outside, path.join(stage, "unsafe")),
    },
    {
      scenario: "unverifiable-pid",
      mutate: () =>
        vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }),
    },
  ] satisfies {
    scenario: string;
    mutate: (value: {
      markerPath: string;
      outside: string;
      root: string;
      parent: string;
      stage: string;
    }) => unknown;
  }[])("preserves a stage with $scenario and reports why recovery was withheld", ({ mutate }) => {
    const f = fixture(packageName);
    const stage = f.interrupt();
    const markerPath = path.join(stage, markerName);
    const outside = path.join(f.root, "outside");
    fs.writeFileSync(outside, "untouched");
    mutate({ ...f, stage, markerPath, outside });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    restoreMissingBundledPackage(f.options);
    expect(fs.readFileSync(path.join(stage, "replacement", "payload"), "utf8")).toBe("fixed");
    expect(fs.readFileSync(path.join(f.live, "payload"), "utf8")).toBe("old");
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("staging recovery incomplete"));
  });
});
