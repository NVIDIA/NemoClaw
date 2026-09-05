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

function requiredLockedVersion(version: string | undefined, dependency: string): string {
  expect(version, `${dependency} lockfile version`).toBeTypeOf("string");
  expect(version, `${dependency} lockfile version`).not.toBe("");
  return version as string;
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

    expect(requiredLockedVersion(pluginTree.dependencies?.vitest?.version, "plugin vitest")).toBe(
      requiredLockedVersion(rootTree.dependencies?.vitest?.version, "root vitest"),
    );
    expect(
      requiredLockedVersion(
        pluginTree.dependencies?.vitest?.dependencies?.vite?.version,
        "plugin vite",
      ),
    ).toBe(
      requiredLockedVersion(
        rootTree.dependencies?.vitest?.dependencies?.vite?.version,
        "root vite",
      ),
    );
    expect(
      requiredLockedVersion(pluginTree.dependencies?.typescript?.version, "plugin typescript"),
    ).toBe(requiredLockedVersion(rootTree.dependencies?.typescript?.version, "root typescript"));
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
