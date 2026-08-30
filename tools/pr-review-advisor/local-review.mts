#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUSTED_IMPLEMENTATION = "tools/pr-review-advisor/local-review-implementation.mts";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function main(): void {
  if (process.argv.length !== 2) throw new Error("review:local does not accept options");
  const source = fs.realpathSync(process.cwd());
  const baseCommit = git(source, ["rev-parse", "--verify", "origin/main^{commit}"]);
  try {
    git(source, ["cat-file", "-e", baseCommit + ":" + TRUSTED_IMPLEMENTATION]);
  } catch {
    throw new Error(
      "origin/main does not contain the trusted local review implementation. This feature can run only after the bootstrap repair is merged; update origin/main and try again.",
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-bootstrap-"));
  const trustedCheckout = path.join(root, "trusted");
  try {
    fs.mkdirSync(trustedCheckout);
    const archive = path.join(root, "trusted.tar");
    execFileSync("git", ["archive", "--format=tar", "--output", archive, baseCommit], {
      cwd: source,
      stdio: "pipe",
    });
    execFileSync("tar", ["-xf", archive, "-C", trustedCheckout], { stdio: "pipe" });
    const dependencies = path.join(source, "node_modules");
    if (!fs.statSync(dependencies, { throwIfNoEntry: false })?.isDirectory())
      throw new Error("Run npm install before local review");
    fs.cpSync(dependencies, path.join(trustedCheckout, "node_modules"), { recursive: true });
    execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.join(trustedCheckout, TRUSTED_IMPLEMENTATION),
        source,
      ],
      { cwd: trustedCheckout, env: process.env, stdio: "inherit" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
