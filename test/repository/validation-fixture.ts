// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      ...args,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

export function writeFixture(root: string, file: string, contents: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

export function validationFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-validation-test-"));
  fixtureGit(root, "init", "--initial-branch=main");
  writeFixture(
    root,
    ".gitignore",
    "node_modules/\nnemoclaw/node_modules/\ndist/\nnemoclaw/dist/\nnemoclaw/runner-dist/\n",
  );
  writeFixture(root, "src/example.ts", "export const example = 1;\n");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-m", "test: fixture");
  fixtureGit(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

export function replaceInputBeforeRead(root: string, linked: boolean) {
  const file = path.join(root, "src/example.ts");
  if (linked) {
    fs.symlinkSync("example.ts", path.join(root, "src/alias.ts"));
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-m", "test: linked input");
  }
  const replace = vi.fn(() => {
    fs.renameSync(file, `${file}.previous`);
    writeFixture(root, "src/example.ts", "export const example = 1;\n");
  });
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = lstat(...args);
    if (args[0] === file && replace.mock.calls.length === 0) replace();
    return stat;
  });
  return replace;
}

export function changeInputDuringRead() {
  const change = vi.fn((descriptor: number) => fs.fchmodSync(descriptor, 0o600));
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = read(...args);
    if (typeof args[0] === "number" && change.mock.calls.length === 0) change(args[0]);
    return bytes;
  });
  return change;
}

export function observeInputReads(file: string) {
  const expected = fs.statSync(file);
  const observed = vi.fn();
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const stat = typeof args[0] === "number" ? fs.fstatSync(args[0]) : undefined;
    if (stat?.dev === expected.dev && stat.ino === expected.ino) observed();
    return read(...args);
  });
  return observed;
}
