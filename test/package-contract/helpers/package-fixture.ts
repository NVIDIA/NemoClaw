// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.join(import.meta.dirname, "..", "..", "..");

export function createPackageFixture(options: {
  readonly prefix: string;
  readonly entries: readonly string[];
  readonly omitRuntimeDependencies?: boolean;
}): string {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), options.prefix));
  const packageJson = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  // npm runs `prepare` when it packs a local directory, even with
  // `--ignore-scripts`. Remove package scripts so parallel package-contract
  // workers only read the copied package inputs.
  packageJson.scripts = {};
  if (options.omitRuntimeDependencies) {
    // A subpath contract with an exact module-load allowlist does not need to
    // refetch the repository's separately reviewed production dependency graph.
    packageJson.dependencies = {};
    packageJson.optionalDependencies = {};
    packageJson.peerDependencies = {};
  }
  writeFileSync(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  copyFileSync(path.join(REPOSITORY_ROOT, ".gitignore"), path.join(fixtureRoot, ".gitignore"));

  for (const entry of options.entries) {
    const destination = path.join(fixtureRoot, entry);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPOSITORY_ROOT, entry), destination, { recursive: true });
  }

  return fixtureRoot;
}
