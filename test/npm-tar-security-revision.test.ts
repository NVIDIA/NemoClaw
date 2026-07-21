// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXED_TAR_VERSION,
  patchBundledNpmTar,
  prepareHistoricalNemoClawInstall,
  restoreHistoricalNemoClawInstall,
  verifyBundledNpmTar,
  verifyHistoricalNemoClawInstall,
} from "../scripts/npm-tar-security-revision.mts";

const vulnerableIntegrity =
  "sha512-ChjMH33/KetonMTAtpYdgUFr0tbz69Fp2v7zWxQfYZX4g5ZN2nOBXm1R2xyA+lMIKrLKIoKAwFj93jE/avX9cQ==";
const tempDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nemoclawFixture(): { backupDirectory: string; packageRoot: string } {
  const root = temporaryDirectory("nemoclaw-npm-tar-metadata-");
  const packageRoot = path.join(root, "nemoclaw");
  const backupDirectory = path.join(root, "backup");
  fs.mkdirSync(backupDirectory);
  writeJson(path.join(packageRoot, "package.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    dependencies: { execa: "^9.6.1", tar: "^7.0.0" },
  });
  writeJson(path.join(packageRoot, "package-lock.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "nemoclaw",
        version: "0.1.0",
        dependencies: { execa: "^9.6.1", tar: "^7.0.0" },
      },
      "node_modules/tar": {
        version: "7.5.11",
        resolved: "https://registry.npmjs.org/tar/-/tar-7.5.11.tgz",
        integrity: vulnerableIntegrity,
      },
    },
  });
  return { backupDirectory, packageRoot };
}

function npmFixture(): { npmRoot: string; replacementRoot: string } {
  const root = temporaryDirectory("nemoclaw-npm-bundled-tar-");
  const npmRoot = path.join(root, "npm");
  const replacementRoot = path.join(root, "replacement");
  writeJson(path.join(npmRoot, "package.json"), {
    name: "npm",
    version: "10.9.7",
    dependencies: { tar: "^7.5.11" },
    bundleDependencies: ["other-package", "tar"],
  });
  writeJson(path.join(npmRoot, "node_modules", "tar", "package.json"), {
    name: "tar",
    version: "7.5.11",
  });
  fs.writeFileSync(path.join(npmRoot, "node_modules", "tar", "vulnerable.js"), "old\n");
  writeJson(path.join(replacementRoot, "package.json"), {
    name: "tar",
    version: FIXED_TAR_VERSION,
  });
  fs.mkdirSync(path.join(replacementRoot, "lib"));
  fs.writeFileSync(path.join(replacementRoot, "lib", "fixed.js"), 'module.exports = "fixed";\n');
  return { npmRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("npm tar security revision (#7272)", () => {
  it("atomically revises historical NemoClaw metadata and verifies the installed package", () => {
    const target = nemoclawFixture();
    expect(prepareHistoricalNemoClawInstall(target)).toBe("vulnerable");
    writeJson(path.join(target.packageRoot, "node_modules", "tar", "package.json"), {
      name: "tar",
      version: FIXED_TAR_VERSION,
    });
    expect(() => verifyHistoricalNemoClawInstall(target.packageRoot)).not.toThrow();
  });

  it("restores the exact vulnerable metadata when npm ci fails", () => {
    const target = nemoclawFixture();
    prepareHistoricalNemoClawInstall(target);
    restoreHistoricalNemoClawInstall(target);
    fs.rmSync(target.backupDirectory, { recursive: true });
    fs.mkdirSync(target.backupDirectory);
    expect(prepareHistoricalNemoClawInstall(target)).toBe("vulnerable");
  });

  it("accepts a fully fixed idempotent state and rejects mixed or symlinked metadata", () => {
    const fixed = nemoclawFixture();
    prepareHistoricalNemoClawInstall(fixed);
    fs.rmSync(fixed.backupDirectory, { recursive: true });
    fs.mkdirSync(fixed.backupDirectory);
    expect(prepareHistoricalNemoClawInstall(fixed)).toBe("fixed");

    const mixed = nemoclawFixture();
    const manifestPath = path.join(mixed.packageRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies.tar = FIXED_TAR_VERSION;
    writeJson(manifestPath, manifest);
    expect(() => prepareHistoricalNemoClawInstall(mixed)).toThrow("mixed or has drifted");

    const symlinked = nemoclawFixture();
    const realManifest = path.join(symlinked.packageRoot, "real-package.json");
    fs.renameSync(path.join(symlinked.packageRoot, "package.json"), realManifest);
    fs.symlinkSync(realManifest, path.join(symlinked.packageRoot, "package.json"));
    expect(() => prepareHistoricalNemoClawInstall(symlinked)).toThrow("must be a real file");
  });

  it("replaces npm 10.9.7's complete bundled tar tree and preserves bundling", () => {
    const target = npmFixture();
    patchBundledNpmTar(target);
    expect(() => verifyBundledNpmTar(target.npmRoot)).not.toThrow();
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(require(process.argv[1]))",
        path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js"),
      ],
      { encoding: "utf8" },
    );
    expect(probe).toMatchObject({ status: 0, stdout: "fixed" });
    patchBundledNpmTar(target);
    expect(() => verifyBundledNpmTar(target.npmRoot)).not.toThrow();
  });

  it("rejects npm identity drift, mixed state, and unsafe replacement members", () => {
    const drifted = npmFixture();
    const npmManifestPath = path.join(drifted.npmRoot, "package.json");
    const npmManifest = JSON.parse(fs.readFileSync(npmManifestPath, "utf8"));
    npmManifest.version = "10.9.8";
    writeJson(npmManifestPath, npmManifest);
    expect(() => patchBundledNpmTar(drifted)).toThrow("does not match npm@10.9.7");

    const mixed = npmFixture();
    const mixedManifestPath = path.join(mixed.npmRoot, "package.json");
    const mixedManifest = JSON.parse(fs.readFileSync(mixedManifestPath, "utf8"));
    mixedManifest.dependencies.tar = FIXED_TAR_VERSION;
    writeJson(mixedManifestPath, mixedManifest);
    expect(() => patchBundledNpmTar(mixed)).toThrow("mixed or has drifted");

    const unsafe = npmFixture();
    fs.symlinkSync("package.json", path.join(unsafe.replacementRoot, "unsafe-link"));
    expect(() => patchBundledNpmTar(unsafe)).toThrow("unsafe member");
  });
});
