// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXED_TAR_VERSION,
  patchBundledNpmTar,
  verifyBundledNpmTar,
} from "../scripts/patch-bundled-npm-tar.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-tar-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(npmVersion: "10.9.7" | "11.13.0", tarVersion: string) {
  const root = temporaryDirectory();
  const npmRoot = path.join(root, "npm");
  const replacementRoot = path.join(root, "replacement");
  writeJson(path.join(npmRoot, "package.json"), {
    name: "npm",
    version: npmVersion,
    dependencies: { tar: npmVersion.startsWith("10.") ? "^7.5.11" : "^7.5.13" },
    bundleDependencies: ["other", "tar"],
  });
  writeJson(path.join(npmRoot, "node_modules", "tar", "package.json"), {
    name: "tar",
    version: tarVersion,
  });
  fs.writeFileSync(path.join(npmRoot, "node_modules", "tar", "old.js"), "old\n");
  writeJson(path.join(replacementRoot, "package.json"), {
    name: "tar",
    version: FIXED_TAR_VERSION,
  });
  fs.mkdirSync(path.join(replacementRoot, "lib"));
  fs.writeFileSync(path.join(replacementRoot, "lib", "fixed.js"), "fixed\n");
  return { npmRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("npm bundled node-tar remediation", () => {
  it.each([
    ["Node 22 npm", "10.9.7", "7.5.11"],
    ["Node 24 npm", "11.13.0", "7.5.13"],
  ] as const)("replaces the complete affected tree for %s", (_label, npmVersion, tarVersion) => {
    const target = fixture(npmVersion, tarVersion);

    expect(patchBundledNpmTar(target)).toMatchObject({
      npmVersion,
      state: "fixed",
      tarVersion: FIXED_TAR_VERSION,
    });
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(false);
    expect(
      fs.readFileSync(path.join(target.npmRoot, "node_modules", "tar", "lib", "fixed.js"), "utf8"),
    ).toBe("fixed\n");
    expect(verifyBundledNpmTar(target.npmRoot).tarVersion).toBe(FIXED_TAR_VERSION);
  });

  it("is idempotent when npm already bundles a safe release", () => {
    const target = fixture("10.9.7", FIXED_TAR_VERSION);
    expect(patchBundledNpmTar(target)).toMatchObject({ state: "fixed" });
    expect(fs.existsSync(path.join(target.npmRoot, "node_modules", "tar", "old.js"))).toBe(true);
  });

  it("fails closed on npm layout drift and unsafe replacement members", () => {
    const drifted = fixture("10.9.7", "7.5.11");
    const manifestPath = path.join(drifted.npmRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "12.0.0";
    writeJson(manifestPath, manifest);
    expect(() => patchBundledNpmTar(drifted)).toThrow("layout has drifted");

    const unsafe = fixture("11.13.0", "7.5.13");
    fs.symlinkSync("package.json", path.join(unsafe.replacementRoot, "unsafe-link"));
    expect(() => patchBundledNpmTar(unsafe)).toThrow("unsafe member");
  });
});
