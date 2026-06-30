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
    baseCommand: "runCapture(buildPolicyGetCommand(sandboxName))",
    unsafeBaseCommand: "runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true })",
    fullCommand: "runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true })",
    diagnosticFullRead: "runCapture(buildPolicyGetFullCommand(sandboxName), { ignoreError: true })",
  },
  {
    relativePath: "nemoclaw/src/blueprint/runner.ts",
    baseCommand: '["openshell", "policy", "get", "--base", sandboxName]',
    unsafeBaseCommand: undefined,
    fullCommand: '["openshell", "policy", "get", "--full", sandboxName]',
    diagnosticFullRead: undefined,
  },
];

const violations: string[] = [];
for (const {
  relativePath,
  baseCommand,
  unsafeBaseCommand,
  fullCommand,
  diagnosticFullRead,
} of MUTATION_READS) {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  if (!source.includes(baseCommand)) {
    violations.push(`${relativePath}: expected the audited policy mutation read to use --base`);
  }
  if (unsafeBaseCommand && source.includes(unsafeBaseCommand)) {
    violations.push(`${relativePath}: policy mutation reads must preserve command failures`);
  }
  if (!diagnosticFullRead && source.includes(fullCommand)) {
    violations.push(`${relativePath}: audited policy mutation read must never use --full output`);
  }
  if (diagnosticFullRead) {
    const diagnosticReads = source.split(diagnosticFullRead).length - 1;
    if (!source.includes(fullCommand) || diagnosticReads === 0) {
      violations.push(`${relativePath}: expected the audited diagnostic read to use --full`);
    }
    if (diagnosticReads !== 1) {
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
