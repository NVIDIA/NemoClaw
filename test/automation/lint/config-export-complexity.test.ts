// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const branches = `export function read(flags: boolean[]) { return ${Array.from({ length: 12 }, (_, index) => `flags[${index}]`).join(" || ")}; }`;
const nesting = `function verify(value: boolean) { ${"if (value) { ".repeat(6)}return true;${" }".repeat(6)} return false; }`;

it.each([
  {
    name: "branch limit for new adapters",
    file: "src/lib/adapters/config/new-reader.ts",
    source: branches,
    rules: ["eslint(complexity)"],
  },
  {
    name: "nesting limit for new verifiers",
    file: "src/lib/domain/config/new-verifier.ts",
    source: nesting,
    rules: ["sonarjs(cognitive-complexity)"],
  },
  {
    name: "length limit for new actions",
    file: "src/lib/actions/config/new-action.ts",
    source: `function write(value: number) {\n${"value += 1;\n".repeat(61)}return value;\n}`,
    rules: ["eslint(max-lines-per-function)"],
  },
  {
    name: "nested ternary rejection in SDK reads",
    file: "src/lib/adapters/openshell/sdk-read.ts",
    source: "export function classify(a: boolean, b: boolean) { return a ? 1 : b ? 2 : 3; }",
    rules: ["eslint(no-nested-ternary)"],
  },
  {
    name: "existing test limits",
    file: "src/lib/adapters/config/new-reader.test.ts",
    source: branches,
    rules: [],
  },
  { name: "legacy limits", file: "src/lib/legacy.ts", source: nesting, rules: [] },
  {
    name: "maintained source inside build directories",
    file: "src/lib/messaging/applier/build/example.mts",
    source: "export const value = undeclaredValue;",
    rules: ["eslint(no-undef)"],
  },
  {
    name: "compiled output exclusions",
    file: "nemoclaw/runner-dist/example.js",
    source: "export const value = undeclaredValue;",
    rules: [],
  },
])("enforces $name", ({ file, source, rules }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-export-lint-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    const result = spawnSync(
      path.resolve("node_modules/.bin/oxlint"),
      ["--format=json", "--no-error-on-unmatched-pattern", file],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(rules.length > 0 ? 1 : 0);
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ filename: string; code: string }>;
    };
    expect(report.diagnostics.map(({ code }) => code)).toEqual(rules);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
