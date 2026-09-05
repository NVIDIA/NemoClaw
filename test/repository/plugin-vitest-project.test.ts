// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const rootTypeScript = rootRequire.resolve("typescript/bin/tsc");

type NpmDependencyTree = {
  dependencies?: Record<string, NpmDependencyTree>;
  version?: string;
};

function lockedDependencyTree(prefix?: string): NpmDependencyTree {
  const prefixArgs = prefix ? ["--prefix", prefix] : [];
  return JSON.parse(
    execFileSync(
      "npm",
      [...prefixArgs, "ls", "--package-lock-only", "--json", "typescript", "vitest", "vite"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ),
  ) as NpmDependencyTree;
}

function listedTypeScriptFiles(configPath: string): string[] {
  return execFileSync(
    process.execPath,
    [rootTypeScript, "--noEmit", "-p", configPath, "--listFilesOnly"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((file) => path.normalize(file));
}

describe("plugin Vitest project contract", () => {
  it("keeps the standalone plugin lock on the root test toolchain", () => {
    const rootTree = lockedDependencyTree();
    const pluginTree = lockedDependencyTree("nemoclaw");

    expect(pluginTree.dependencies?.vitest?.version, "vitest").toBe(
      rootTree.dependencies?.vitest?.version,
    );
    expect(pluginTree.dependencies?.vitest?.dependencies?.vite?.version, "vite").toBe(
      rootTree.dependencies?.vitest?.dependencies?.vite?.version,
    );
    expect(pluginTree.dependencies?.typescript?.version, "typescript").toBe(
      rootTree.dependencies?.typescript?.version,
    );
  });

  it("typechecks plugin production and test sources without emitting tests", () => {
    const productionFiles = listedTypeScriptFiles("nemoclaw/tsconfig.json");
    const testFiles = listedTypeScriptFiles("nemoclaw/tsconfig.test.json");

    expect(productionFiles.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "src", "register.test.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.config.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.project.ts"));
  });
});
