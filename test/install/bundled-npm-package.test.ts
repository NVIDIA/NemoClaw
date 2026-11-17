// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  jsonObject,
  reconcileBundledPackageBackup,
  restoreMissingBundledPackage,
  prepareBundledPackageReplacement,
  runBundledNpmCommand,
  readJsonObject,
  rejectUnsafePackageTree,
  requireRealDirectory,
} from "../../scripts/lib/bundled-npm-package.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-package-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("bundled npm package utilities", () => {
  it("accepts a real JSON object without following file or directory symlinks", () => {
    const root = temporaryDirectory();
    const manifest = path.join(root, "package.json");
    fs.writeFileSync(manifest, '{"name":"npm"}\n');
    expect(jsonObject({ name: "npm" }, "manifest")).toEqual({ name: "npm" });
    expect(() => jsonObject([], "manifest")).toThrow("manifest must be a JSON object");
    expect(readJsonObject(manifest, "npm manifest")).toEqual({ name: "npm" });
    expect(requireRealDirectory(root, "npm root")).toBe(fs.realpathSync(root));

    const fileLink = path.join(root, "package-link.json");
    fs.symlinkSync("package.json", fileLink);
    expect(() => readJsonObject(fileLink, "npm manifest")).toThrow();
    const directoryLink = path.join(temporaryDirectory(), "npm-link");
    fs.symlinkSync(root, directoryLink);
    expect(() => requireRealDirectory(directoryLink, "npm root")).toThrow(
      `npm root must be a real directory: ${directoryLink}`,
    );
  });

  it("accepts regular nested trees and rejects symlinked members", () => {
    const root = temporaryDirectory();
    const nested = path.join(root, "lib");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "index.js"), "export {};\n");
    expect(() => rejectUnsafePackageTree(root, "replacement package")).not.toThrow();

    fs.symlinkSync("lib/index.js", path.join(root, "unsafe-link"));
    expect(() => rejectUnsafePackageTree(root, "replacement package")).toThrow(
      "replacement package contains an unsafe member: unsafe-link",
    );
  });
});

function retainedBackupFixture() {
  const npmRoot = fs.realpathSync(temporaryDirectory());
  const backup = path.join(npmRoot, "node_modules", "undici.nemoclaw-backup-123-0123456789abcdef");
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "package.json"), '{"name":"undici","version":"6.27.0"}');
  fs.writeFileSync(path.join(backup, "original.js"), "original bytes\n");
  return {
    backup,
    originalPath: path.join(backup, "original.js"),
    options: {
      npmRoot,
      packageName: "undici" as const,
      fixed: true,
      verifyBackup(manifest: Record<string, unknown>) {
        expect(manifest).toEqual({ name: "undici", version: "6.27.0" });
      },
    },
  };
}

describe("retained npm dependency backup recovery", () => {
  it("preserves a missing live package and its backup when restore is interrupted", () => {
    const { backup, options, originalPath } = retainedBackupFixture();
    const live = path.join(options.npmRoot, "node_modules", "undici");
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename denied");
    });
    syncBuiltinESMExports();
    try {
      expect(() => restoreMissingBundledPackage(options)).toThrow("rename denied");
      expect(fs.existsSync(live)).toBe(false);
      expect(fs.readFileSync(originalPath, "utf8")).toBe("original bytes\n");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    restoreMissingBundledPackage(options);
    expect(fs.readFileSync(path.join(live, "original.js"), "utf8")).toBe("original bytes\n");
    expect(fs.existsSync(backup)).toBe(false);
  });

  it("does not overwrite a dangling live symlink with the retained tree", () => {
    const { options, originalPath } = retainedBackupFixture();
    const live = path.join(options.npmRoot, "node_modules", "undici");
    fs.symlinkSync("absent-target", live);
    restoreMissingBundledPackage(options);
    expect(fs.readlinkSync(live)).toBe("absent-target");
    expect(fs.readFileSync(originalPath, "utf8")).toBe("original bytes\n");
  });

  it.each([
    {
      scenario: "wrong identity",
      mutate: (backup: string) =>
        fs.writeFileSync(path.join(backup, "package.json"), '{"name":"other"}'),
    },
    { scenario: "multiple backups", mutate: (backup: string) => fs.mkdirSync(`${backup}0`) },
    {
      scenario: "unsafe member",
      mutate: (backup: string) => fs.symlinkSync("original.js", path.join(backup, "unsafe")),
    },
  ])("refuses missing-live recovery with $scenario", ({ mutate }) => {
    const { backup, options, originalPath } = retainedBackupFixture();
    mutate(backup);
    expect(() => restoreMissingBundledPackage(options)).toThrow();
    expect(fs.existsSync(path.join(options.npmRoot, "node_modules", "undici"))).toBe(false);
    expect(fs.readFileSync(originalPath, "utf8")).toBe("original bytes\n");
  });

  it("removes only the recognized backup after a verified replacement", () => {
    const { backup, options } = retainedBackupFixture();
    const unrelated = path.join(options.npmRoot, "node_modules", "unrelated");
    fs.mkdirSync(unrelated);
    reconcileBundledPackageBackup(options);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it.each([
    {
      scenario: "affected",
      mutate: (target) => {
        target.options.fixed = false;
      },
    },
    {
      scenario: "multiple",
      mutate: (target) => {
        fs.mkdirSync(`${target.backup}0`);
      },
    },
    {
      scenario: "unrecognized name",
      mutate: (target) => {
        fs.renameSync(target.backup, `${target.backup}unknown`);
        target.originalPath = path.join(`${target.backup}unknown`, "original.js");
      },
    },
    {
      scenario: "missing manifest",
      mutate: (target) => {
        fs.unlinkSync(path.join(target.backup, "package.json"));
      },
    },
    {
      scenario: "wrong identity",
      mutate: (target) => {
        fs.writeFileSync(path.join(target.backup, "package.json"), '{"name":"other"}');
      },
    },
    {
      scenario: "unsafe member",
      mutate: (target) => {
        fs.symlinkSync("original.js", path.join(target.backup, "unsafe"));
      },
    },
    {
      scenario: "linked backup",
      mutate: (target) => {
        const outside = path.join(temporaryDirectory(), "original");
        fs.renameSync(target.backup, outside);
        fs.symlinkSync(outside, target.backup);
        target.originalPath = path.join(outside, "original.js");
      },
    },
    {
      scenario: "linked parent",
      mutate: (target) => {
        fs.renameSync(
          path.join(target.options.npmRoot, "node_modules"),
          path.join(target.options.npmRoot, "actual"),
        );
        fs.symlinkSync("actual", path.join(target.options.npmRoot, "node_modules"));
      },
    },
  ] satisfies Array<{
    scenario: string;
    mutate: (target: ReturnType<typeof retainedBackupFixture>) => void;
  }>)("preserves the retained tree when recovery encounters $scenario", ({ mutate }) => {
    const target = retainedBackupFixture();
    mutate(target);
    expect(() => reconcileBundledPackageBackup(target.options)).toThrow();
    expect(fs.readFileSync(target.originalPath, "utf8")).toBe("original bytes\n");
  });

  it("reports repeated cleanup failure and allows a later verified retry", () => {
    const { backup, options } = retainedBackupFixture();
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((file) => {
      expect(String(file)).toBe(backup);
      throw new Error("cleanup denied");
    });
    syncBuiltinESMExports();
    try {
      expect(() => reconcileBundledPackageBackup(options)).toThrow(
        `affected backup cleanup failed: ${backup}`,
      );
      expect(() => reconcileBundledPackageBackup(options)).toThrow(
        `affected backup cleanup failed: ${backup}`,
      );
      expect(fs.readFileSync(path.join(backup, "original.js"), "utf8")).toBe("original bytes\n");
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    reconcileBundledPackageBackup(options);
    expect(fs.existsSync(backup)).toBe(false);
  });
});

describe("reviewed npm dependency archive preparation", () => {
  it.each([
    { offline: false, downloadCommand: "curl", requiredFlag: "=https" },
    { offline: true, downloadCommand: "npm", requiredFlag: "--ignore-scripts" },
  ])(
    "extracts only integrity-verified bytes and cleans the temporary archive (offline=$offline)",
    ({ offline, downloadCommand, requiredFlag }) => {
      const root = temporaryDirectory();
      const packageRoot = path.join(root, "package");
      fs.mkdirSync(packageRoot);
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        '{"name":"undici","version":"6.29.1"}',
      );
      const archive = path.join(root, "reviewed.tgz");
      runBundledNpmCommand("tar", ["-czf", archive, "-C", root, "package"]);
      const bytes = fs.readFileSync(archive);
      const commands: string[] = [];
      let downloadDirectory = "";
      const stageArchive = (destination: string, args: readonly string[]) => {
        expect(args).toContain(requiredFlag);
        downloadDirectory = path.dirname(destination);
        fs.copyFileSync(archive, destination);
      };
      const handlers: Record<string, (args: readonly string[]) => void> = {
        tar: (args) => runBundledNpmCommand("tar", args),
        curl: (args) => stageArchive(String(args[args.indexOf("--output") + 1]), args),
        npm: (args) =>
          stageArchive(
            path.join(String(args[args.indexOf("--pack-destination") + 1]), "undici-6.29.1.tgz"),
            args,
          ),
      };
      const prepared = prepareBundledPackageReplacement({
        packageName: "undici",
        version: "6.29.1",
        tarball: "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz",
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        offline,
        commandRunner(command, args) {
          commands.push(command);
          handlers[command](args);
        },
      });
      try {
        expect(commands).toEqual([downloadCommand, "tar"]);
        expect(
          readJsonObject(path.join(prepared.replacementRoot, "package.json"), "replacement"),
        ).toEqual({ name: "undici", version: "6.29.1" });
      } finally {
        prepared.cleanup();
      }
      expect(fs.existsSync(downloadDirectory)).toBe(false);
    },
  );

  it.each([
    {
      scenario: "tampered",
      commands: ["curl"],
      download: (archive: string, _outside: string) => fs.writeFileSync(archive, "wrong bytes"),
    },
    {
      scenario: "linked",
      commands: ["curl"],
      download: (archive: string, outside: string) => fs.symlinkSync(outside, archive),
    },
    {
      scenario: "download failure",
      commands: ["curl"],
      download: (_archive: string, _outside: string) => {
        throw new Error("download failed");
      },
    },
    {
      scenario: "extraction failure",
      commands: ["curl", "tar"],
      download: (archive: string, outside: string) => fs.copyFileSync(outside, archive),
    },
  ])(
    "cleans up without accepting $scenario archives",
    ({ commands: expectedCommands, download }) => {
      const bytes = Buffer.from("reviewed bytes");
      const outside = path.join(temporaryDirectory(), "outside.tgz");
      fs.writeFileSync(outside, bytes);
      let downloadDirectory = "";
      const commands: string[] = [];
      const handlers: Record<string, (args: readonly string[]) => void> = {
        tar: () => {
          throw new Error("extraction failed");
        },
        curl: (args) => {
          const archive = String(args[args.indexOf("--output") + 1]);
          downloadDirectory = path.dirname(archive);
          download(archive, outside);
        },
      };
      expect(() =>
        prepareBundledPackageReplacement({
          packageName: "undici",
          version: "6.29.1",
          tarball: "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz",
          offline: false,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          commandRunner(command, args) {
            commands.push(command);
            handlers[command](args);
          },
        }),
      ).toThrow();
      expect(commands).toEqual(expectedCommands);
      expect(fs.existsSync(downloadDirectory)).toBe(false);
      expect(fs.readFileSync(outside)).toEqual(bytes);
    },
  );
});
