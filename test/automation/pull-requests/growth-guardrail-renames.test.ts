// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { testOnly } from "../../helpers/growth-guardrail-diff.ts";

it("retains source and destination comparisons when a moved test replaces a forwarder", ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(path.join(tmpdir(), "growth-rename-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      { cwd: directory, encoding: "utf8", stdio: "pipe" },
    );
  const source =
    "// The installed-state fixture retains its assertions across entry-point migration.\n".repeat(
      12,
    ) +
    [
      'import { expect, test } from "vitest";',
      'test("retains the installed state", () => {',
      "  expect(installation.state).toEqual({ installed: true, configured: true });",
      '  expect(installation.artifacts).toContain("configuration");',
      "  expect(installation.credentials).toEqual([]);",
      "});",
      "",
    ].join("\n");
  git("init", "--initial-branch=main");
  writeFileSync(path.join(directory, "legacy.test.ts"), source);
  writeFileSync(path.join(directory, "current.test.ts"), 'await import("./legacy.test.ts");\n');
  git("add", ".");
  git("commit", "-m", "test: create rename fixture");
  rmSync(path.join(directory, "legacy.test.ts"));
  writeFileSync(path.join(directory, "current.test.ts"), source);
  const expected = [
    { filename: "current.test.ts", status: "modified" },
    {
      filename: "current.test.ts",
      previous_filename: "legacy.test.ts",
      status: "renamed",
    },
  ];

  expect(testOnly.readChangedFiles("HEAD", undefined, directory)).toEqual(expected);
  writeFileSync(
    path.join(directory, "legacy.test.ts"),
    "// This replacement fixture must not inherit the moved test body's budget.\n".repeat(12) +
      'test("new behavior", () => { if (enabled) expect(enabled).toBe(true); });\n',
  );
  expect(testOnly.readChangedFiles("HEAD", undefined, directory)).toEqual([
    { filename: "current.test.ts", status: "modified" },
    { filename: "legacy.test.ts", status: "modified" },
  ]);
  rmSync(path.join(directory, "legacy.test.ts"));
  git("add", "-A");
  git("commit", "-m", "test: move fixture body");
  expect(testOnly.readChangedFiles("HEAD~1", "HEAD", directory)).toEqual(expected);
});
