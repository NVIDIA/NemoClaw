// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([
  {
    name: "unchanged adapters",
    file: "src/lib/adapters/read.ts",
    tracked: true,
    explicit: false,
    expected: 1,
  },
  {
    name: "explicit existing adapters",
    file: "src/lib/adapters/read.ts",
    tracked: true,
    explicit: true,
    expected: 1,
  },
  {
    name: "new files outside adapters",
    file: "src/lib/new.ts",
    tracked: false,
    explicit: false,
    expected: 1,
  },
  {
    name: "existing files outside adapters",
    file: "src/lib/legacy.ts",
    tracked: true,
    explicit: true,
    expected: 0,
  },
])("enforces formatting for $name", ({ file, tracked, explicit, expected }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-format-"));
  try {
    fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    fs.mkdirSync(path.join(root, "tools/lint"), { recursive: true });
    fs.copyFileSync("oxfmt.config.ts", path.join(root, "oxfmt.config.ts"));
    fs.copyFileSync("oxc.ignore-patterns.ts", path.join(root, "oxc.ignore-patterns.ts"));
    fs.copyFileSync(
      "tools/lint/format-added-files.sh",
      path.join(root, "tools/lint/format-added-files.sh"),
    );
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "--quiet");
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const unformatted = "export const value={a:1,b:'two'}\n";
    fs.writeFileSync(path.join(root, file), unformatted);
    git("add", "--", tracked ? file : ".gitignore");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    );
    const run = (mode: string) =>
      spawnSync("bash", ["tools/lint/format-added-files.sh", mode, ...(explicit ? [file] : [])], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_FORMAT_BASE_REF: "HEAD" },
      });
    const check = run("--check");
    expect(check.status, check.stderr).toBe(expected);
    expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(unformatted);
    const write = run("--write");
    expect(write.status, write.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(
      expected ? 'export const value = { a: 1, b: "two" };\n' : unformatted,
    );
    const formatted = run("--check");
    expect(formatted.status, formatted.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
