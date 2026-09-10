// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  {
    name: "NaN comparisons in CLI code",
    file: "src/lib/example.ts",
    source: "export function read(value: number) { return value === NaN; }",
    diagnostic: "eslint(use-isnan)",
    exitCode: 1,
    args: [],
  },
  {
    name: "async promise executors in CLI code",
    file: "src/lib/example.ts",
    source: "export const value = new Promise(async (resolve) => { resolve(1); });",
    diagnostic: "eslint(no-async-promise-executor)",
    exitCode: 1,
    args: [],
  },
  {
    name: "debugger statements outside adapters",
    file: "scripts/example.ts",
    source: "export function read() { debugger; }",
    diagnostic: "eslint(no-debugger)",
    exitCode: 1,
    args: [],
  },
  {
    name: "unnecessary escapes in CLI code",
    file: "src/lib/example.ts",
    source: String.raw`export const value = /\!/;`,
    diagnostic: "eslint(no-useless-escape)",
    exitCode: 1,
    args: [],
  },
  {
    name: "necessary escapes in CLI code",
    file: "src/lib/example.ts",
    source: String.raw`export const value = /\./;`,
    diagnostic: "",
    exitCode: 0,
    args: [],
  },
  {
    name: "browser globals in CLI code",
    file: "src/lib/example.ts",
    source: "export const read = () => window.location.href;",
    diagnostic: "eslint(no-undef)",
    exitCode: 1,
    args: [],
  },
  {
    name: "browser globals in browser components",
    file: "docs/_components/Example.tsx",
    source: "export const read = () => window.location.href;",
    diagnostic: "",
    exitCode: 0,
    args: [],
  },
  {
    name: "obsolete suppressions",
    file: "src/lib/example.ts",
    source: "// eslint-disable-next-line no-debugger\nexport const value = 1;",
    diagnostic: "Unused eslint-disable directive",
    exitCode: 1,
    args: [],
  },
  {
    name: "used suppressions",
    file: "src/lib/example.ts",
    source: "export function read() {\n// eslint-disable-next-line no-debugger\ndebugger;\n}",
    diagnostic: "",
    exitCode: 0,
    args: [],
  },
  {
    name: "warning-only diagnostics",
    file: "src/lib/example.ts",
    source: 'console.log("example");',
    diagnostic: "eslint(no-console)",
    exitCode: 1,
    args: ["--warn", "no-console"],
  },
])("checks $name", ({ file, source, diagnostic, exitCode, args }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-correctness-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxlint.config.ts", path.join(root, "oxlint.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    const result = spawnSync(path.resolve("node_modules/.bin/oxlint"), [...args, file], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(exitCode);
    expect(result.stdout + result.stderr).toContain(diagnostic);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
