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
} from "../../scripts/patch-bundled-npm-tar.mts";
import {
  REVIEWED_NPM_PACKAGES,
  REVIEWED_NPM_VERSION,
  upgradeBundledNpm,
  verifyReviewedNpm,
  verifyReviewedNpmArchive,
} from "../../scripts/upgrade-bundled-npm.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(root: string, location: string, name: string, version: string): void {
  writeJson(path.join(root, "node_modules", location, "package.json"), { name, version });
}

function affectedNpm(version: "10.9.8" | "11.13.0" | "11.16.0"): string {
  const root = path.join(temporaryDirectory(), "npm");
  writeJson(path.join(root, "package.json"), { name: "npm", version });
  writePackage(root, "brace-expansion", "brace-expansion", "2.0.2");
  writePackage(root, "picomatch", "picomatch", "4.0.3");
  writePackage(root, "sigstore", "sigstore", version === "10.9.8" ? "3.1.0" : "4.0.0");
  writePackage(root, "tar", "tar", "7.5.20");
  return root;
}

function reviewedNpm(): string {
  const root = path.join(temporaryDirectory(), "npm");
  writeJson(path.join(root, "package.json"), {
    bundleDependencies: ["tar"],
    dependencies: { tar: "^7.5.19" },
    engines: { node: "^20.17.0 || >=22.9.0" },
    name: "npm",
    version: REVIEWED_NPM_VERSION,
  });
  writePackage(
    root,
    "brace-expansion",
    "brace-expansion",
    REVIEWED_NPM_PACKAGES["brace-expansion"],
  );
  writePackage(
    root,
    path.join("tinyglobby", "node_modules", "picomatch"),
    "picomatch",
    REVIEWED_NPM_PACKAGES.picomatch,
  );
  writePackage(root, "sigstore", "sigstore", REVIEWED_NPM_PACKAGES.sigstore);
  writePackage(root, "tar", "tar", REVIEWED_NPM_PACKAGES.tar);
  const binDirectory = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(binDirectory);
  fs.symlinkSync("../../brace-expansion/index.js", path.join(binDirectory, "brace-expansion"));
  return root;
}

function fixedTar(): string {
  const root = path.join(temporaryDirectory(), "tar");
  writeJson(path.join(root, "package.json"), { name: "tar", version: FIXED_TAR_VERSION });
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("reviewed bundled npm upgrade", () => {
  it("verifies the complete reviewed dependency set", () => {
    const state = verifyReviewedNpm(reviewedNpm());

    expect(state).toEqual({
      npmVersion: REVIEWED_NPM_VERSION,
      packages: {
        "brace-expansion": [REVIEWED_NPM_PACKAGES["brace-expansion"]],
        picomatch: [REVIEWED_NPM_PACKAGES.picomatch],
        sigstore: [REVIEWED_NPM_PACKAGES.sigstore],
        tar: [REVIEWED_NPM_PACKAGES.tar],
      },
    });
  });

  it("requires the first patched tar release after installing the reviewed npm tree", () => {
    const npmRoot = reviewedNpm();

    expect(verifyReviewedNpm(npmRoot).packages.tar).toEqual(["7.5.19"]);
    expect(() => verifyBundledNpmTar(npmRoot)).toThrow("bundles affected tar@7.5.19");
    expect(patchBundledNpmTar({ npmRoot, replacementRoot: fixedTar() })).toMatchObject({
      npmVersion: REVIEWED_NPM_VERSION,
      state: "fixed",
      tarVersion: "7.5.21",
    });
    expect(verifyBundledNpmTar(npmRoot).tarVersion).toBe("7.5.21");
  });

  it.each(["10.9.8", "11.13.0", "11.16.0"] as const)(
    "replaces npm %s before running npm or npx",
    (version) => {
      const npmRoot = affectedNpm(version);
      const replacementRoot = reviewedNpm();
      const commands: string[] = [];
      const archivePath = path.join(temporaryDirectory(), "npm.tgz");
      fs.writeFileSync(archivePath, "reviewed fixture\n");
      const verifyReviewedCommand: Readonly<Record<string, (() => void) | undefined>> = {
        npm: () => expect(verifyReviewedNpm(npmRoot).npmVersion).toBe(REVIEWED_NPM_VERSION),
        npx: () => expect(verifyReviewedNpm(npmRoot).npmVersion).toBe(REVIEWED_NPM_VERSION),
      };

      const result = upgradeBundledNpm(npmRoot, {
        commandRunner(command) {
          commands.push(command);
          verifyReviewedCommand[command]?.();
        },
        installArchive(_archive, commandRunner) {
          commandRunner("install-reviewed-npm", []);
          fs.rmSync(npmRoot, { recursive: true });
          fs.cpSync(replacementRoot, npmRoot, { recursive: true });
        },
        prepareArchive(commandRunner) {
          commandRunner("curl", []);
          return {
            archivePath,
            cleanup: () => commands.push("cleanup"),
          };
        },
      });

      expect(result.npmVersion).toBe(REVIEWED_NPM_VERSION);
      expect(commands).toEqual(["curl", "install-reviewed-npm", "npm", "npx", "cleanup"]);
    },
  );

  it("does not download npm when the reviewed tree is already installed", () => {
    const npmRoot = reviewedNpm();
    const commands: string[] = [];

    expect(
      upgradeBundledNpm(npmRoot, {
        commandRunner: (command) => commands.push(command),
        prepareArchive: () => {
          throw new Error("unexpected download");
        },
      }).npmVersion,
    ).toBe(REVIEWED_NPM_VERSION);
    expect(commands).toEqual(["npm", "npx"]);
  });

  it("fails closed on reviewed-package drift", () => {
    const drifted = reviewedNpm();
    writePackage(drifted, "sigstore", "sigstore", "4.1.0");
    expect(() => verifyReviewedNpm(drifted)).toThrow("expected only 4.1.1");
  });

  it("fails closed on an unreviewed current npm version", () => {
    const unreviewed = affectedNpm("10.9.8");
    const manifestPath = path.join(unreviewed, "package.json");
    writeJson(manifestPath, { name: "npm", version: "12.0.1" });
    expect(() => upgradeBundledNpm(unreviewed)).toThrow("outside the reviewed upgrade path");
  });

  it("rejects an archive whose SHA-512 does not match the reviewed npm release", () => {
    const archivePath = path.join(temporaryDirectory(), "npm.tgz");
    fs.writeFileSync(archivePath, "not npm\n");
    expect(() => verifyReviewedNpmArchive(archivePath)).toThrow("integrity mismatch");
  });
});
