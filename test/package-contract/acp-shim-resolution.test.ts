// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createCleanManagedSourceAcpWorkTree,
  createManagedSourceNemoClawAcp,
  createNpmManagedNemoClawAcp,
  createPackagedCliTree,
  dirtyManagedSourceNemoClawAcp,
  runInstallerFunction,
  symlinkNpmManagedAcpMetadata,
  writeInstallerGeneratedAcpShim,
} from "./helpers/acp-shim-fixtures.js";

type Scenario = {
  tmp: string;
  fakeBin: string;
  prefixBin: string;
  oldPrefix: string;
  shimPath: string;
};

function createScenario(name: string): Scenario {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-acp-contract-${name}-`));
  const { fakeBin, prefixBin } = createPackagedCliTree(tmp);
  return {
    tmp,
    fakeBin,
    prefixBin,
    oldPrefix: path.join(tmp, "old-prefix"),
    shimPath: path.join(tmp, ".local", "bin", "nemoclaw-acp"),
  };
}

function expectRejectedUnchanged(
  result: ReturnType<typeof runInstallerFunction>,
  scenario: Scenario,
  originalContents: Buffer,
): void {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
  expect(fs.readFileSync(scenario.shimPath)).toEqual(originalContents);
  expect(`${result.stdout}${result.stderr}`).toContain(
    `${scenario.shimPath} already exists and is not a NemoClaw-managed shim`,
  );
}

describe("installer recognition of stale NemoClaw ACP shims (#12738)", () => {
  it.skipIf(process.platform === "win32")(
    "refreshes a prior NemoClaw-owned npm ACP wrapper after the active CLI path changes",
    () => {
      const scenario = createScenario("old-managed-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const oldContents = fs.readFileSync(scenario.shimPath);

      const result = runInstallerFunction(scenario);

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(scenario.shimPath)).not.toEqual(oldContents);
      expect(fs.readFileSync(scenario.shimPath, "utf-8")).toContain(
        path.join(scenario.prefixBin, "nemoclaw-acp"),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generated-shape wrapper with a non-NemoClaw npm package",
    () => {
      const scenario = createScenario("foreign-package-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      const packageJson = path.join(
        scenario.oldPrefix,
        "lib",
        "node_modules",
        "nemoclaw",
        "package.json",
      );
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf-8")) as {
        name: string;
        version: string;
        bin: Record<string, string>;
      };
      pkg.name = "foreign-package";
      fs.writeFileSync(packageJson, JSON.stringify(pkg));
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generated-shape wrapper with invalid NemoClaw build identity",
    () => {
      const scenario = createScenario("invalid-identity-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      const identityPath = path.join(
        scenario.oldPrefix,
        "lib",
        "node_modules",
        "nemoclaw",
        "dist",
        "build-identity.json",
      );
      fs.writeFileSync(
        identityPath,
        JSON.stringify({ nemoclawVersion: "0.0.131", sourceRevision: "not-a-revision" }),
      );
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generated-shape wrapper with a symlinked NemoClaw package.json",
    () => {
      const scenario = createScenario("symlinked-package-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      symlinkNpmManagedAcpMetadata(scenario.oldPrefix, "package");
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a generated-shape wrapper with a symlinked build identity",
    () => {
      const scenario = createScenario("symlinked-identity-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      symlinkNpmManagedAcpMetadata(scenario.oldPrefix, "identity");
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a NemoClaw-shaped package whose executable reports a different version",
    () => {
      const scenario = createScenario("foreign-executable-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix, "foreign-cli v0.0.131");
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refreshes a prior managed-source ACP wrapper after the active CLI path changes",
    () => {
      const scenario = createScenario("old-source-shim");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix);
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const oldContents = fs.readFileSync(scenario.shimPath);

      const result = runInstallerFunction(scenario);

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(scenario.shimPath)).not.toEqual(oldContents);
      expect(fs.readFileSync(scenario.shimPath, "utf-8")).toContain(
        path.join(scenario.prefixBin, "nemoclaw-acp"),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a dirty managed-source tree despite ambient Git overrides",
    () => {
      const scenario = createScenario("dirty-source-shim");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix);
      const cleanWorkTree = path.join(scenario.tmp, "clean-source-worktree");
      createCleanManagedSourceAcpWorkTree(scenario.tmp, cleanWorkTree);
      dirtyManagedSourceNemoClawAcp(scenario.tmp);
      const sourceRoot = path.join(scenario.tmp, ".nemoclaw", "source");
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(
        runInstallerFunction(scenario, {
          GIT_DIR: path.join(sourceRoot, ".git"),
          GIT_WORK_TREE: cleanWorkTree,
        }),
        scenario,
        originalContents,
      );
    },
  );
});
