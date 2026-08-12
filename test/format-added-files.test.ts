// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import process from "node:process";

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = new Set<string>();
const formatter = path.resolve("tools/lint/format-added-files.sh");

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe("added-file Oxfmt selection", () => {
  it("selects added and untracked source when origin main is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-added-format-"));
    roots.add(root);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "commit.gpgsign=false", "-C", root, ...args], {
        encoding: "utf8",
      });

    expect(git("init").status).toBe(0);
    expect(git("config", "user.name", "NemoClaw Test").status).toBe(0);
    expect(git("config", "user.email", "test@example.com").status).toBe(0);
    fs.writeFileSync(path.join(root, "existing.ts"), "export const existing = 1;\n");
    expect(git("add", "existing.ts").status).toBe(0);
    expect(git("commit", "-m", "test: create base").status).toBe(0);

    fs.writeFileSync(path.join(root, "existing.ts"), "export const existing = 2;\n");
    fs.writeFileSync(path.join(root, "added.ts"), "export const added = 1;\n");
    expect(git("add", "added.ts").status).toBe(0);
    fs.writeFileSync(path.join(root, "untracked.ts"), "export const untracked = 1;\n");
    fs.writeFileSync(path.join(root, "notes.md"), "# Notes\n");

    const bin = path.join(root, "bin");
    const log = path.join(root, "oxfmt-args.txt");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "npx"),
      '#!/bin/sh\nprintf "%s\\n" "$@" >"$OXFMT_ARGUMENT_LOG"\n',
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [formatter, "--check"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NEMOCLAW_FORMAT_BASE_REF: "refs/remotes/origin/main",
        OXFMT_ARGUMENT_LOG: log,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    const args = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(args).toEqual([
      "oxfmt",
      "--check",
      "--no-error-on-unmatched-pattern",
      "added.ts",
      "untracked.ts",
    ]);
    expect(args).not.toContain("existing.ts");
    expect(args).not.toContain("notes.md");
  });
});
