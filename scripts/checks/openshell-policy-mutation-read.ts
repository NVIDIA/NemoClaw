// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Prevent provider-composed OpenShell policy entries from entering mutation paths. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MUTATION_SOURCES = ["src/lib/policy/index.ts", "nemoclaw/src/blueprint/runner.ts"];
const FORBIDDEN_FULL_READS = [
  "policy get --full",
  '"policy", "get", "--full"',
  "'policy', 'get', '--full'",
];
const REQUIRED_BASE_READS = new Map([
  [
    "src/lib/policy/index.ts",
    'return [resolveOpenshellBinary(), "policy", "get", "--base", sandboxName]',
  ],
  ["nemoclaw/src/blueprint/runner.ts", '["openshell", "policy", "get", "--base", sandboxName]'],
]);

const violations: string[] = [];
for (const relativePath of MUTATION_SOURCES) {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  const requiredBaseRead = REQUIRED_BASE_READS.get(relativePath) ?? "";
  if (!source.includes(requiredBaseRead)) {
    violations.push(`${relativePath}: expected the audited policy mutation read to use --base`);
  }
  for (const forbidden of FORBIDDEN_FULL_READS) {
    if (source.includes(forbidden)) {
      violations.push(`${relativePath}: policy mutation code must never read --full output`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("OpenShell policy mutation reads use --base and exclude --full output.");
