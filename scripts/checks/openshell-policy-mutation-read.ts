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
    diagnosticFullRead: "runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true })",
    fullBuilderName: "buildPolicyGetFullCommand",
  },
  {
    relativePath: "nemoclaw/src/blueprint/runner.ts",
    baseCommand: '["openshell", "policy", "get", "--base", sandboxName]',
    fullCommand: '["openshell", "policy", "get", "--full", sandboxName]',
    diagnosticFullRead: undefined,
    fullBuilderName: undefined,
  },
];

const violations: string[] = [];
for (const {
  relativePath,
  baseCommand,
  fullCommand,
  diagnosticFullRead,
  fullBuilderName,
} of MUTATION_READS) {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  if (!source.includes(baseCommand)) {
    violations.push(`${relativePath}: expected the audited policy mutation read to use --base`);
  }
  if (!diagnosticFullRead && source.includes(fullCommand)) {
    violations.push(`${relativePath}: audited policy mutation read must never use --full output`);
  }
  if (diagnosticFullRead && fullBuilderName) {
    const builderReferences = source.match(new RegExp(`${fullBuilderName}\\s*\\(`, "g")) ?? [];
    if (!source.includes(fullCommand) || !source.includes(diagnosticFullRead)) {
      violations.push(`${relativePath}: expected the audited diagnostic read to use --full`);
    }
    // One definition and one diagnostic call are allowed. Any additional call
    // would let a mutation path consume provider-composed effective policy.
    if (builderReferences.length !== 2) {
      violations.push(
        `${relativePath}: --full policy reads must remain isolated to the diagnostic path`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("OpenShell policy mutations use --base; read-only diagnostics isolate --full output.");
