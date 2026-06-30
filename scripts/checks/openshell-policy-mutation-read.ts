// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Prevent provider-composed OpenShell policy entries from entering mutation paths. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MUTATION_READS = [
  {
    relativePath: "src/lib/policy/index.ts",
    baseCommand: 'return [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName]',
    fullCommand: 'return [resolveOpenshellBinary(), "policy", "get", "--full", sandboxName]',
  },
  {
    relativePath: "nemoclaw/src/blueprint/runner.ts",
    baseCommand: '["openshell", "policy", "get", "--base", sandboxName]',
    fullCommand: '["openshell", "policy", "get", "--full", sandboxName]',
  },
];

const violations: string[] = [];
for (const { relativePath, baseCommand, fullCommand } of MUTATION_READS) {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  if (!source.includes(baseCommand)) {
    violations.push(`${relativePath}: expected the audited policy mutation read to use --base`);
  }
  if (source.includes(fullCommand)) {
    violations.push(`${relativePath}: audited policy mutation read must never use --full output`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("OpenShell policy mutation reads use --base and exclude --full output.");
