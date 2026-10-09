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
    "allows preflight before the active npm binary exists, then refreshes the wrapper",
    () => {
      const scenario = createScenario("empty-new-prefix");
      const activeCli = path.join(scenario.prefixBin, "nemoclaw-acp");
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, activeCli);
      const oldContents = fs.readFileSync(scenario.shimPath);
      fs.rmSync(activeCli);

      const result = runInstallerFunction(
        scenario,
        {},
        `preflight_nemoclaw_acp_shim
printf '%s\\n' '#!/usr/bin/env bash' 'echo nemoclaw-acp v0.1.0' > "$ACTIVE_NPM_PREFIX/bin/nemoclaw-acp"
chmod 755 "$ACTIVE_NPM_PREFIX/bin/nemoclaw-acp"
ensure_cli_shim "nemoclaw-acp"`,
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(scenario.shimPath)).toEqual(oldContents);
      expect(fs.existsSync(path.join(scenario.prefixBin, "nemoclaw-acp"))).toBe(true);
      expect(fs.readFileSync(scenario.shimPath, "utf-8")).toContain(
        path.join(scenario.prefixBin, "nemoclaw-acp"),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refreshes a verified stale source wrapper after creating the active CLI",
    () => {
      const scenario = createScenario("empty-prefix-stale-source");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix);
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const oldContents = fs.readFileSync(scenario.shimPath);
      fs.rmSync(path.join(scenario.prefixBin, "nemoclaw-acp"));

      const result = runInstallerFunction(
        scenario,
        {},
        `preflight_nemoclaw_acp_shim
printf '%s\\n' '#!/usr/bin/env bash' 'echo nemoclaw-acp v0.1.0' > "$ACTIVE_NPM_PREFIX/bin/nemoclaw-acp"
chmod 755 "$ACTIVE_NPM_PREFIX/bin/nemoclaw-acp"
ensure_cli_shim "nemoclaw-acp"`,
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(fs.readFileSync(scenario.shimPath)).not.toEqual(oldContents);
      expect(fs.readFileSync(scenario.shimPath, "utf-8")).toContain(
        path.join(scenario.prefixBin, "nemoclaw-acp"),
      );
    },
  );

  it.skipIf(process.platform === "win32")("leaves a foreign wrapper unchanged", () => {
    const scenario = createScenario("foreign-shim");
    fs.mkdirSync(path.dirname(scenario.shimPath), { recursive: true });
    fs.writeFileSync(scenario.shimPath, "#!/usr/bin/env bash\necho foreign\n", { mode: 0o755 });
    const originalContents = fs.readFileSync(scenario.shimPath);

    expectRejectedUnchanged(runInstallerFunction(scenario), scenario, originalContents);
  });

  it.skipIf(process.platform === "win32")(
    "does not execute a forged npm-layout ACP target when rejecting its wrapper",
    () => {
      const scenario = createScenario("forged-npm-layout-shim");
      const oldCli = createNpmManagedNemoClawAcp(scenario.oldPrefix);
      const sentinel = path.join(scenario.tmp, "npm-layout-executed");
      fs.writeFileSync(
        path.join(
          scenario.oldPrefix,
          "lib",
          "node_modules",
          "nemoclaw",
          "dist",
          "lib",
          "acp",
          "main.js",
        ),
        `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n`,
      );
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(
        runInstallerFunction(scenario, {}, "preflight_nemoclaw_acp_shim"),
        scenario,
        originalContents,
      );
      expect(fs.existsSync(sentinel)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects managed-source metadata with an invalid build identity",
    () => {
      const scenario = createScenario("invalid-source-identity");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix);
      const identityPath = path.join(
        scenario.tmp,
        ".nemoclaw",
        "source",
        "dist",
        "build-identity.json",
      );
      fs.writeFileSync(
        identityPath,
        JSON.stringify({ nemoclawVersion: "0.0.131", sourceRevision: "not-a-revision" }),
      );
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(
        runInstallerFunction(scenario, {}, "preflight_nemoclaw_acp_shim"),
        scenario,
        originalContents,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a committed symlinked managed-source package.json",
    () => {
      const scenario = createScenario("symlinked-source-package");
      const externalPath = path.join(scenario.tmp, "external-package.json");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix, externalPath);
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(
        runInstallerFunction(scenario, {}, "preflight_nemoclaw_acp_shim"),
        scenario,
        originalContents,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked managed-source build identity",
    () => {
      const scenario = createScenario("symlinked-source-identity");
      const oldCli = createManagedSourceNemoClawAcp(scenario.tmp, scenario.oldPrefix);
      const metadataPath = path.join(
        scenario.tmp,
        ".nemoclaw",
        "source",
        "dist",
        "build-identity.json",
      );
      const externalPath = path.join(scenario.tmp, "external-build-identity.json");
      fs.copyFileSync(metadataPath, externalPath);
      fs.unlinkSync(metadataPath);
      fs.symlinkSync(externalPath, metadataPath);
      writeInstallerGeneratedAcpShim(scenario.shimPath, scenario.fakeBin, oldCli);
      const originalContents = fs.readFileSync(scenario.shimPath);

      expectRejectedUnchanged(
        runInstallerFunction(scenario, {}, "preflight_nemoclaw_acp_shim"),
        scenario,
        originalContents,
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
