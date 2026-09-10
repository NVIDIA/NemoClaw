// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  { file: "src/lib/adapters/read.ts", expected: 1 },
  { file: "src/lib/legacy.ts", expected: 1 },
  { file: "scripts/legacy.js", expected: 1 },
  { file: "nemoclaw/src/read.test.ts", expected: 1 },
  { file: ".dsh/tools/example/index.ts", expected: 1 },
  { file: "src/lib/messaging/applier/build/read.mts", expected: 1 },
  { file: "dist/read.js", expected: 0 },
  { file: "nemoclaw/runner-dist/read.js", expected: 0 },
])("formats $file without Git history", ({ file, expected }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-source-format-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxfmt.config.ts", path.join(root, "oxfmt.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync("package.json", path.join(root, "package.json"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const unformatted = "export const value={a:1,b:'two'}\n";
    fs.writeFileSync(path.join(root, file), unformatted);
    const run = (script: string) =>
      spawnSync("npm", ["run", script], { cwd: root, encoding: "utf8" });
    const check = run("format:check");
    expect(check.status, check.stdout + check.stderr).toBe(expected);
    expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(unformatted);
    const write = run("format");
    expect(write.status, write.stdout + write.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(
      expected ? 'export const value = { a: 1, b: "two" };\n' : unformatted,
    );
    const formatted = run("format:check");
    expect(formatted.status, formatted.stdout + formatted.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("formats existing source through the commit hook without a comparison ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-format-hook-"));
  try {
    const file = "src/lib/legacy.ts";
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.copyFileSync("oxfmt.config.ts", path.join(root, "oxfmt.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync(".pre-commit-config.yaml", path.join(root, ".pre-commit-config.yaml"));
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "export const value={a:1,b:'two'}\n");
    const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const add = spawnSync("git", ["add", "--", file], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const result = spawnSync(
      path.resolve("node_modules/.bin/prek"),
      ["run", "oxfmt", "--files", file],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    const check = spawnSync(path.resolve("node_modules/.bin/oxfmt"), ["--check", file], {
      cwd: root,
      encoding: "utf8",
    });
    expect(check.status, check.stdout + check.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
