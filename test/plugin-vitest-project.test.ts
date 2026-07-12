// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import standalonePluginVitestConfig from "../nemoclaw/vitest.config";
import pluginVitestProjectOptions from "../nemoclaw/vitest.project";
import rootVitestConfig from "../vitest.config";

type PolicyAlias = {
  find: RegExp;
  replacement: string;
};

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureUmaskSetup = "test/helpers/normalize-fixture-umask.ts";
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const pluginRequire = createRequire(path.join(repositoryRoot, "nemoclaw", "package.json"));
const pluginTypeScript = pluginRequire.resolve("typescript/bin/tsc");

function installedVersion(requireFromPackage: NodeJS.Require, packageName: string): string {
  return (requireFromPackage(`${packageName}/package.json`) as { version: string }).version;
}

function listedTypeScriptFiles(configPath: string): string[] {
  return execFileSync(
    process.execPath,
    [pluginTypeScript, "--noEmit", "-p", configPath, "--listFilesOnly"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((file) => path.normalize(file));
}

describe("plugin Vitest project contract", () => {
  it("defines one canonical plugin project for root and standalone runs", () => {
    const sourceTransform = pluginVitestProjectOptions.oxc;
    const policyAliases = pluginVitestProjectOptions.test.alias as PolicyAlias[];
    const rootProjects = (rootVitestConfig.test?.projects ?? []) as unknown as Array<{
      test?: { name?: string };
    }>;
    const rootPluginProjects = rootProjects.filter((project) => project.test?.name === "plugin");

    expect(pluginVitestProjectOptions.root).toBe(repositoryRoot);
    expect(sourceTransform.include).toEqual(/\.(?:[cm]?ts|[jt]sx)$/);
    expect(pluginVitestProjectOptions.test.name).toBe("plugin");
    expect(pluginVitestProjectOptions.test.environment).toBe("node");
    expect(pluginVitestProjectOptions.test.env).toEqual({
      NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    });
    expect(pluginVitestProjectOptions.test.setupFiles).toEqual([fixtureUmaskSetup]);
    expect(pluginVitestProjectOptions.test.include).toEqual(["nemoclaw/src/**/*.test.ts"]);
    expect(policyAliases).toEqual([
      {
        find: /^.*openshell-policy-boundary\.cjs$/,
        replacement: path.join(repositoryRoot, "nemoclaw/src/shared/openshell-policy-boundary.cts"),
      },
    ]);
    expect(pluginVitestProjectOptions.test).not.toHaveProperty("globalSetup");
    expect(rootPluginProjects).toEqual([pluginVitestProjectOptions]);
    expect(standalonePluginVitestConfig).toEqual({
      ...pluginVitestProjectOptions,
      test: {
        ...pluginVitestProjectOptions.test,
        globalSetup: path.join(repositoryRoot, "test/helpers/vitest-temp-root.ts"),
      },
    });
  });

  it("keeps standalone plugin dependencies on the root Vitest toolchain", () => {
    for (const packageName of ["vitest", "vite"] as const) {
      expect(installedVersion(pluginRequire, packageName), packageName).toBe(
        installedVersion(rootRequire, packageName),
      );
    }
  });

  it("typechecks plugin production and test sources without emitting tests", () => {
    const productionFiles = listedTypeScriptFiles("nemoclaw/tsconfig.json");
    const testFiles = listedTypeScriptFiles("nemoclaw/tsconfig.test.json");
    const typecheckOutput = execFileSync("npm", ["--prefix", "nemoclaw", "run", "typecheck"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(productionFiles.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "src", "register.test.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.config.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.project.ts"));
    expect(typecheckOutput).toContain("tsc --noEmit -p tsconfig.test.json");
  });
});
