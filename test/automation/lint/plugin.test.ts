// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  {
    name: "nullable defaults in production",
    file: "nemoclaw/src/example.ts",
    source: 'export function read(value: string | undefined) { return value || "fallback"; }',
    rule: "typescript(prefer-nullish-coalescing)",
  },
  {
    name: "optional access in production",
    file: "nemoclaw/src/example.ts",
    source:
      "export function read(value: { name: string } | undefined) { return value && value.name; }",
    rule: "typescript(prefer-optional-chain)",
  },
  {
    name: "incomplete switches in tests",
    file: "nemoclaw/src/example.test.ts",
    source: 'export function read(kind: "one" | "two") { switch (kind) { case "one": return 1; } }',
    rule: "typescript(switch-exhaustiveness-check)",
  },
  {
    name: "promises imported from other tests",
    file: "nemoclaw/src/example.test.ts",
    source:
      'import { readRemote } from "./dependency.test.js"; export function read() { readRemote(); }',
    rule: "typescript(no-floating-promises)",
  },
  {
    name: "floating promises in tests",
    file: "nemoclaw/src/example.test.ts",
    source: "export function read() { Promise.resolve(); }",
    rule: "typescript(no-floating-promises)",
  },
  {
    name: "type exports in production",
    file: "nemoclaw/src/example.ts",
    source: "type Result = string; export { Result };",
    rule: "typescript(consistent-type-exports)",
  },
  {
    name: "handled promises in production",
    file: "nemoclaw/src/example.ts",
    source: "export async function read() { return await Promise.resolve(1); }",
    rule: "",
  },
])("checks plugin $name through the commit hook", ({ file, source, rule }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-lint-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync(".pre-commit-config.yaml", path.join(root, ".pre-commit-config.yaml"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync("nemoclaw/src/tsconfig.json", path.join(root, "nemoclaw/src/tsconfig.json"));
    fs.copyFileSync("nemoclaw/tsconfig.json", path.join(root, "nemoclaw/tsconfig.json"));
    fs.copyFileSync("nemoclaw/tsconfig.test.json", path.join(root, "nemoclaw/tsconfig.test.json"));
    fs.writeFileSync(path.join(root, file), source);
    fs.writeFileSync(
      path.join(root, "nemoclaw/src/dependency.test.ts"),
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
    expect(result.stdout + result.stderr).toContain(rule);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
