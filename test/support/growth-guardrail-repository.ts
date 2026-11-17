// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { e2eAssertionBudget } from "../helpers/e2e-assertion-budget";

export const RETAINED_TEST = "test/retained.test.ts";
export const BUDGET = "ci/e2e-assertion-budget.json";
export const POLICY = "ci/e2e-assertion-growth-exceptions.json";

export class GrowthRepository {
  readonly directory = mkdtempSync(path.join(os.tmpdir(), "growth-diff-"));
  readonly origin = path.join(this.directory, "origin");
  readonly checkout = path.join(this.directory, "checkout");
  readonly ancestor: string;

  constructor() {
    mkdirSync(this.origin);
    this.git(this.origin, "init", "--initial-branch=main");
    this.write(RETAINED_TEST, "if (true) {}\n");
    this.write(BUDGET, e2eAssertionBudget(2));
    this.write(POLICY, JSON.stringify({ schemaVersion: 1, exceptions: [] }));
    this.ancestor = this.commit("common ancestor");
    this.git(this.origin, "branch", "candidate");
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Growth Fixture",
        "-c",
        "user.email=growth@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  write(file: string, content: string): void {
    const target = path.join(this.origin, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  commit(message: string): string {
    this.git(this.origin, "add", ".");
    this.git(this.origin, "commit", "--allow-empty", "-m", message);
    return this.git(this.origin, "rev-parse", "HEAD");
  }

  appendHistory(count: number): string {
    const parent = this.git(this.origin, "rev-parse", "HEAD");
    const commits = Array.from({ length: count }, (_, index) =>
      [
        "commit refs/heads/main",
        `mark :${index + 1}`,
        "committer Growth Fixture <growth@example.invalid> 1700000000 +0000",
        "data 7",
        "history",
        `from ${index === 0 ? parent : `:${index}`}`,
        "",
      ].join("\n"),
    ).join("\n");
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: this.origin,
      input: `${commits}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return this.git(this.origin, "rev-parse", "HEAD");
  }

  reduceBase(): string {
    this.write(RETAINED_TEST, "// base removed a conditional\n");
    this.write(BUDGET, e2eAssertionBudget(1));
    return this.commit("base-only ratchet reduction");
  }

  startCandidate(): void {
    this.git(this.origin, "checkout", "candidate");
  }

  cloneBase(depth: "full" | "shallow" = "full"): void {
    this.git(this.origin, "update-ref", "refs/pull/1/head", "candidate");
    this.git(
      this.directory,
      "clone",
      "--no-local",
      "--branch",
      "main",
      ...(depth === "shallow" ? ["--depth=1"] : []),
      pathToFileURL(this.origin).href,
      this.checkout,
    );
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
