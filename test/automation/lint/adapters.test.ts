// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

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
    fixes: true,
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
    name: "promises from imported source",
    source: 'import { readRemote } from "./dependency"; export function read() { readRemote(); }',
    rule: "typescript(no-floating-promises)",
  },
  {
    name: "promises from Node declarations",
    source:
      'import { readFile } from "node:fs/promises"; export function read() { readFile("example"); }',
    rule: "typescript(no-floating-promises)",
  },
  {
    name: "floating promises",
    source: "export function read() { Promise.resolve(); }",
    rule: "typescript(no-floating-promises)",
  },
  {
    name: "promise conditions",
    source: "export function read() { if (Promise.resolve(false)) return 1; return 0; }",
    rule: "typescript(no-misused-promises)",
  },
  {
    name: "await on synchronous values",
    source: "export async function read() { return await 1; }",
    rule: "typescript(await-thenable)",
  },
  {
    name: "missing union cases",
    source: 'export function read(kind: "one" | "two") { switch (kind) { case "one": return 1; } }',
    rule: "typescript(switch-exhaustiveness-check)",
  },
  {
    name: "handled promises",
    source: "export async function read() { return await Promise.resolve(1); }",
    rule: "",
  },
  {
    name: "test assertion allowance",
    source: "export function read(values: string[]) { return values.at(0)!; }",
    rule: "",
    test: true,
  },
])("checks adapter $name through the commit hook", ({ source, rule, test, fixes }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-lint-"));
  try {
    const file = `src/lib/adapters/example/read${test ? ".test" : ""}.ts`;
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync("tsconfig.cli.json", path.join(root, "tsconfig.cli.json"));
    fs.copyFileSync(".pre-commit-config.yaml", path.join(root, ".pre-commit-config.yaml"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(
      "src/lib/adapters/tsconfig.json",
      path.join(root, "src/lib/adapters/tsconfig.json"),
    );
    fs.writeFileSync(path.join(root, file), source);
    fs.writeFileSync(
      path.join(root, "src/lib/adapters/example/dependency.ts"),
      "export async function readRemote() { return 1; }",
    );
    const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const add = spawnSync("git", ["add", "--", file], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const result = spawnSync(
      path.resolve("node_modules/.bin/prek"),
      ["run", "oxlint-type-aware", "--files", file],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(rule ? 1 : 0);
    expect(fs.readFileSync(path.join(root, file), "utf8") !== source).toBe(fixes ?? false);
    expect(result.stdout + result.stderr).toContain(rule && !fixes ? rule : "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { scope: "adapter", file: "src/lib/adapters/example.ts" },
  { scope: "plugin", file: "nemoclaw/src/example.ts" },
])("runs repository checks after $scope fixes", ({ file }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lint-order-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.mkdirSync(path.join(root, "src/lib/adapters"), { recursive: true });
    fs.mkdirSync(path.join(root, "nemoclaw/src"), { recursive: true });
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync("tsconfig.cli.json", path.join(root, "tsconfig.cli.json"));
    fs.copyFileSync(
      "src/lib/adapters/tsconfig.json",
      path.join(root, "src/lib/adapters/tsconfig.json"),
    );
    fs.copyFileSync("nemoclaw/src/tsconfig.json", path.join(root, "nemoclaw/src/tsconfig.json"));
    fs.copyFileSync("nemoclaw/tsconfig.json", path.join(root, "nemoclaw/tsconfig.json"));
    fs.copyFileSync("nemoclaw/tsconfig.test.json", path.join(root, "nemoclaw/tsconfig.test.json"));
    const config = YAML.parse(fs.readFileSync(".pre-commit-config.yaml", "utf8")) as {
      repos: Array<{ repo: string; hooks: Array<{ id: string; entry?: string }> }>;
    };
    const hooks = config.repos
      .flatMap((repo) => repo.hooks)
      .filter(({ id }) => id === "oxlint-type-aware" || id === "repository-checks");
    const observer = hooks.find(({ id }) => id === "repository-checks")!;
    observer.entry = `node -e "require('node:fs').copyFileSync(process.argv[1], 'observed.ts')" ${file}`;
    config.repos = [{ repo: "local", hooks }];
    fs.writeFileSync(path.join(root, ".pre-commit-config.yaml"), YAML.stringify(config));
    const source = "type Result = string; export { Result };";
    fs.writeFileSync(path.join(root, file), source);
    const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const add = spawnSync("git", ["add", "--", file], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const result = spawnSync(path.resolve("node_modules/.bin/prek"), ["run", "--files", file], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const fixed = fs.readFileSync(path.join(root, file), "utf8");
    expect(fixed).not.toBe(source);
    expect(fs.readFileSync(path.join(root, "observed.ts"), "utf8")).toBe(fixed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
