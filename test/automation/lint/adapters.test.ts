// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  {
    name: "unused declarations",
    source: "export function read() { const unused = 1; }",
    rule: "eslint(no-unused-vars)",
  },
  {
    name: "explicit any",
    source: "export type Result = any;",
    rule: "typescript(no-explicit-any)",
  },
  {
    name: "value imports used only as types",
    source: 'import { Stats } from "node:fs"; export type Result = Stats;',
    rule: "typescript(consistent-type-imports)",
    fixes: true,
  },
  {
    name: "value exports used only as types",
    source: "type Result = string; export { Result };",
    rule: "typescript(consistent-type-exports)",
    typed: true,
  },
  {
    name: "loose equality",
    source: "export function read(value: string) { return value == 'a'; }",
    rule: "eslint(eqeqeq)",
  },
  {
    name: "debugger statements",
    source: "export function read() { debugger; }",
    rule: "eslint(no-debugger)",
  },
  {
    name: "production non-null assertions",
    source: "export function read(values: string[]) { return values.at(0)!; }",
    rule: "typescript(no-non-null-assertion)",
  },
  {
    name: "production nested ternaries",
    source: "export function read(a: boolean, b: boolean) { return a ? 1 : b ? 2 : 3; }",
    rule: "eslint(no-nested-ternary)",
  },
  {
    name: "floating promises",
    source: "export function read() { Promise.resolve(); }",
    rule: "typescript(no-floating-promises)",
    typed: true,
  },
  {
    name: "promise conditions",
    source: "export function read() { if (Promise.resolve(false)) return 1; return 0; }",
    rule: "typescript(no-misused-promises)",
    typed: true,
  },
  {
    name: "await on synchronous values",
    source: "export async function read() { return await 1; }",
    rule: "typescript(await-thenable)",
    typed: true,
  },
  {
    name: "missing union cases",
    source: 'export function read(kind: "one" | "two") { switch (kind) { case "one": return 1; } }',
    rule: "typescript(switch-exhaustiveness-check)",
    typed: true,
  },
  {
    name: "handled promises",
    source: "export async function read() { return await Promise.resolve(1); }",
    rule: "",
    typed: true,
  },
  {
    name: "test assertion allowance",
    source: "export function read(values: string[]) { return values.at(0)!; }",
    rule: "",
    test: true,
  },
])("checks adapter $name through the commit hook", ({ source, rule, typed, test, fixes }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-lint-"));
  try {
    const file = `src/lib/adapters/example/read${test ? ".test" : ""}.ts`;
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxlint.type-aware.config.ts", path.join(root, "oxlint.type-aware.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync("tsconfig.cli.json", path.join(root, "tsconfig.cli.json"));
    fs.copyFileSync(".pre-commit-config.yaml", path.join(root, ".pre-commit-config.yaml"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const add = spawnSync("git", ["add", "--", file], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const result = spawnSync(
      path.resolve("node_modules/.bin/prek"),
      ["run", typed ? "oxlint-adapters-type-aware" : "oxlint-fix", "--files", file],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(rule ? 1 : 0);
    expect(fs.readFileSync(path.join(root, file), "utf8") !== source).toBe(fixes ?? false);
    expect(result.stdout + result.stderr).toContain(rule && !fixes ? rule : "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
