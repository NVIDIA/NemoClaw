// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AFFECTED_BRACE_EXPANSION_VERSION,
  FIXED_BRACE_EXPANSION_VERSION,
  patchBundledNpmBraceExpansion,
  patchBundledNpmBraceExpansionFromRegistry,
  verifyBundledNpmBraceExpansion,
} from "../../scripts/patch-bundled-npm-brace-expansion.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-brace-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(braceExpansionVersion: string) {
  const root = temporaryDirectory();
  const npmRoot = path.join(root, "npm");
  const replacementRoot = path.join(root, "replacement");
  writeJson(path.join(npmRoot, "package.json"), {
    name: "npm",
    version: "11.18.0",
  });
  writeJson(path.join(npmRoot, "node_modules", "brace-expansion", "package.json"), {
    dependencies: { "balanced-match": "^4.0.2" },
    name: "brace-expansion",
    version: braceExpansionVersion,
  });
  fs.writeFileSync(path.join(npmRoot, "node_modules", "brace-expansion", "old.js"), "old\n");
  const arboristBin = path.join(npmRoot, "node_modules", "@npmcli", "arborist", "bin", "index.js");
  fs.mkdirSync(path.dirname(arboristBin), { recursive: true });
  fs.writeFileSync(arboristBin, "#!/usr/bin/env node\n");
  const npmBin = path.join(npmRoot, "node_modules", ".bin");
  fs.mkdirSync(npmBin);
  fs.symlinkSync("../@npmcli/arborist/bin/index.js", path.join(npmBin, "arborist"));
  writeJson(path.join(replacementRoot, "package.json"), {
    dependencies: { "balanced-match": "^4.0.2" },
    name: "brace-expansion",
    version: FIXED_BRACE_EXPANSION_VERSION,
  });
  fs.mkdirSync(path.join(replacementRoot, "dist"));
  fs.writeFileSync(path.join(replacementRoot, "dist", "fixed.js"), "fixed\n");
  return { npmRoot, replacementRoot };
}

function expectAffectedTreeUnchanged(target: ReturnType<typeof fixture>): void {
  expect(
    fs.existsSync(path.join(target.npmRoot, "node_modules", "brace-expansion", "old.js")),
  ).toBe(true);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("npm bundled brace-expansion remediation", () => {
  it("replaces the complete affected private package tree", () => {
    const target = fixture(AFFECTED_BRACE_EXPANSION_VERSION);

    expect(patchBundledNpmBraceExpansion(target)).toMatchObject({
      braceExpansionVersion: FIXED_BRACE_EXPANSION_VERSION,
      npmVersion: "11.18.0",
      state: "fixed",
    });
    expect(
      fs.existsSync(path.join(target.npmRoot, "node_modules", "brace-expansion", "old.js")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(target.npmRoot, "node_modules", "brace-expansion", "dist", "fixed.js"),
        "utf8",
      ),
    ).toBe("fixed\n");
  });

  it("upgrades the previous remediation release", () => {
    const target = fixture("5.0.8");

    expect(patchBundledNpmBraceExpansion(target)).toMatchObject({
      braceExpansionVersion: FIXED_BRACE_EXPANSION_VERSION,
      state: "fixed",
    });
    expect(
      fs.existsSync(path.join(target.npmRoot, "node_modules", "brace-expansion", "old.js")),
    ).toBe(false);
  });

  it("does not invoke npm or npx until the private package is replaced and verified", () => {
    const target = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    const commands: string[] = [];
    const postPatchAssertions: Record<string, () => void> = {
      npm: () => expect(verifyBundledNpmBraceExpansion(target.npmRoot).state).toBe("fixed"),
      npx: () => expect(verifyBundledNpmBraceExpansion(target.npmRoot).state).toBe("fixed"),
    };

    const result = patchBundledNpmBraceExpansionFromRegistry(target.npmRoot, {
      commandRunner(command) {
        commands.push(command);
        postPatchAssertions[command]?.();
      },
      prepareReplacement(commandRunner) {
        commandRunner("curl", []);
        commandRunner("tar", []);
        return {
          cleanup: () => commands.push("cleanup"),
          replacementRoot: target.replacementRoot,
        };
      },
    });

    expect(result.state).toBe("fixed");
    expect(commands).toEqual(["curl", "tar", "npm", "npx", "cleanup"]);
  });

  it("is idempotent when npm already bundles the fixed release", () => {
    const target = fixture(FIXED_BRACE_EXPANSION_VERSION);
    expect(patchBundledNpmBraceExpansion(target)).toMatchObject({ state: "fixed" });
    expect(
      fs.existsSync(path.join(target.npmRoot, "node_modules", "brace-expansion", "old.js")),
    ).toBe(true);
  });

  it("restores the original package when the replacement rename fails", () => {
    const target = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw new Error("injected replacement rename failure");
      })
      .mockImplementation(originalRenameSync);
    syncBuiltinESMExports();

    try {
      expect(() => patchBundledNpmBraceExpansion(target)).toThrow(
        "injected replacement rename failure",
      );
    } finally {
      renameSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(
      fs.existsSync(path.join(target.npmRoot, "node_modules", "brace-expansion", "old.js")),
    ).toBe(true);
    expect(() => verifyBundledNpmBraceExpansion(target.npmRoot)).toThrow(
      `affected brace-expansion@${AFFECTED_BRACE_EXPANSION_VERSION}`,
    );
  });

  it("restores the original package when post-swap verification fails", () => {
    const target = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    const livePath = path.join(target.npmRoot, "node_modules", "brace-expansion");
    const originalRenameSync = fs.renameSync.bind(fs);
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce((oldPath, newPath) => {
        originalRenameSync(oldPath, newPath);
        writeJson(path.join(livePath, "package.json"), {
          dependencies: { "balanced-match": "^0.0.0" },
          name: "brace-expansion",
          version: FIXED_BRACE_EXPANSION_VERSION,
        });
      })
      .mockImplementation(originalRenameSync);
    syncBuiltinESMExports();

    try {
      expect(() => patchBundledNpmBraceExpansion(target)).toThrow(
        "npm bundled brace-expansion identity or dependency layout has drifted",
      );
    } finally {
      renameSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expectAffectedTreeUnchanged(target);
    expect(() => verifyBundledNpmBraceExpansion(target.npmRoot)).toThrow(
      `affected brace-expansion@${AFFECTED_BRACE_EXPANSION_VERSION}`,
    );
  });

  it("keeps the verified replacement authoritative when backup cleanup is partial", () => {
    const target = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    const originalRmSync = fs.rmSync.bind(fs);
    let injectedCleanupFailure = false;
    const failPartialBackupCleanup = (targetPath: fs.PathLike): never => {
      injectedCleanupFailure = true;
      originalRmSync(path.join(String(targetPath), "old.js"), { force: true });
      throw new Error("injected partial backup cleanup failure");
    };
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((targetPath, options) => {
      return !injectedCleanupFailure &&
        String(targetPath).includes("brace-expansion.nemoclaw-backup-")
        ? failPartialBackupCleanup(targetPath)
        : originalRmSync(targetPath, options);
    });
    syncBuiltinESMExports();

    try {
      expect(patchBundledNpmBraceExpansion(target)).toMatchObject({ state: "fixed" });
    } finally {
      rmSpy.mockRestore();
      syncBuiltinESMExports();
    }

    expect(injectedCleanupFailure).toBe(true);
    expect(verifyBundledNpmBraceExpansion(target.npmRoot)).toMatchObject({ state: "fixed" });
    expect(
      fs
        .readdirSync(path.join(target.npmRoot, "node_modules"))
        .some((entry) => entry.startsWith("brace-expansion.nemoclaw-backup-")),
    ).toBe(false);
  });

  it("fails closed on npm layout drift and unsafe replacement members", () => {
    const drifted = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    writeJson(path.join(drifted.npmRoot, "package.json"), {
      name: "npm",
      version: "12.0.0",
    });
    expect(() => patchBundledNpmBraceExpansion(drifted)).toThrow(
      "npm package identity has drifted",
    );
    expectAffectedTreeUnchanged(drifted);

    const unsafe = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    fs.symlinkSync("package.json", path.join(unsafe.replacementRoot, "unsafe-link"));
    expect(() => patchBundledNpmBraceExpansion(unsafe)).toThrow("unsafe member");
    expectAffectedTreeUnchanged(unsafe);

    const symlinkedNpmTree = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    fs.symlinkSync(
      "brace-expansion",
      path.join(symlinkedNpmTree.npmRoot, "node_modules", "brace-expansion-alias"),
    );
    expect(() => patchBundledNpmBraceExpansion(symlinkedNpmTree)).toThrow(
      "npm package contains an unsafe symlink",
    );
    expectAffectedTreeUnchanged(symlinkedNpmTree);

    const escapingBinLink = fixture(AFFECTED_BRACE_EXPANSION_VERSION);
    const outsideNodeModules = path.join(path.dirname(escapingBinLink.npmRoot), "outside.js");
    fs.writeFileSync(outsideNodeModules, "outside\n");
    fs.symlinkSync(
      "../../../../outside.js",
      path.join(escapingBinLink.npmRoot, "node_modules", ".bin", "escape"),
    );
    expect(() => patchBundledNpmBraceExpansion(escapingBinLink)).toThrow(
      "npm package contains an unsafe symlink",
    );
    expectAffectedTreeUnchanged(escapingBinLink);
  });
});
