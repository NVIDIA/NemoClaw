#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// pull_request_target content is fetched manually so no PR-controlled action,
// hook, submodule, LFS filter, or package setup can run. Every input that is
// interpolated into a git ref is validated against a strict allow-list before
// any git command runs, and commands execute via execFileSync (no shell), so a
// hostile branch/ref name cannot inject arguments. The base and head are bound
// to the immutable SHAs carried in the triggering event.
const TARGET_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TARGET_PR_PATTERN = /^[0-9]+$/u;
const TARGET_BASE_PATTERN = /^[A-Za-z0-9._/-]+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DEFAULT_TARGET_DIR = "/tmp/pr-review-advisor-target";

export class PrepareTargetPrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareTargetPrError";
  }
}

export type PrepareTargetPrInput = {
  targetRepo: string;
  targetPr: string;
  targetBase: string;
  prBaseSha?: string;
  expectedHeadSha?: string;
};

export type PrepareTargetPrOptions = {
  targetDir?: string;
  /** Runs a `git <args>` invocation and returns its trimmed stdout. Injectable for tests. */
  runGit?: (args: string[]) => string;
  /** Persists a `key=value` pair for later steps (defaults to appending GITHUB_ENV). */
  appendEnv?: (key: string, value: string) => void;
};

function fail(message: string): never {
  throw new PrepareTargetPrError(message);
}

export function validatePrepareTargetPrInput(input: PrepareTargetPrInput): void {
  if (!TARGET_REPO_PATTERN.test(input.targetRepo)) {
    fail("target_repo must match owner/repo with GitHub-safe characters");
  }
  if (!TARGET_PR_PATTERN.test(input.targetPr)) {
    fail("target_pr must be decimal digits");
  }
  const base = input.targetBase;
  if (
    base.length === 0 ||
    base.startsWith("-") ||
    base.startsWith("/") ||
    base.includes("..") ||
    base.includes(":") ||
    /\s/u.test(base) ||
    !TARGET_BASE_PATTERN.test(base)
  ) {
    fail("target_base must be a safe branch/ref token");
  }
  if (input.prBaseSha && !SHA_PATTERN.test(input.prBaseSha)) {
    fail("event base SHA must be 40 lowercase hexadecimal characters");
  }
  if (input.expectedHeadSha && !SHA_PATTERN.test(input.expectedHeadSha)) {
    fail("event head SHA must be 40 lowercase hexadecimal characters");
  }
}

/**
 * Fetch and check out a target PR's head into an isolated, hardened workspace,
 * verifying the fetched base/head against the immutable SHAs from the
 * triggering event. Mirrors the workflow's former inline shell exactly; the
 * hardening (`core.hooksPath=/dev/null`, `submodule.recurse=false`, no-tags,
 * no-recurse-submodules) is preserved so PR content cannot execute code.
 */
export function prepareTargetPr(
  input: PrepareTargetPrInput,
  options: PrepareTargetPrOptions = {},
): { workdir: string; prNumber: string } {
  validatePrepareTargetPrInput(input);

  const targetDir = options.targetDir ?? DEFAULT_TARGET_DIR;
  const runGit =
    options.runGit ??
    ((args: string[]): string =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim());
  const appendEnv =
    options.appendEnv ??
    ((key: string, value: string): void => {
      const target = process.env.GITHUB_ENV;
      if (!target) fail("GITHUB_ENV is not set");
      fs.appendFileSync(target, `${key}=${value}\n`);
    });
  const git = (...args: string[]): string => runGit(["-C", targetDir, ...args]);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  git("init");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "submodule.recurse", "false");
  git("remote", "add", "target", `https://github.com/${input.targetRepo}.git`);

  const baseFetch = input.prBaseSha ? input.prBaseSha : `refs/heads/${input.targetBase}`;
  git(
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "target",
    `${baseFetch}:refs/remotes/target/base`,
  );
  git(
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "target",
    `refs/pull/${input.targetPr}/head:refs/remotes/target/pr-${input.targetPr}`,
  );

  if (input.prBaseSha) {
    const fetchedBase = git("rev-parse", "refs/remotes/target/base");
    if (fetchedBase !== input.prBaseSha) {
      fail("Fetched base does not match the triggering PR base SHA");
    }
  }

  git(
    "-c",
    "submodule.recurse=false",
    "checkout",
    "--detach",
    `refs/remotes/target/pr-${input.targetPr}`,
  );
  const actualHead = git("rev-parse", "HEAD");
  if (input.expectedHeadSha && actualHead !== input.expectedHeadSha) {
    fail("Fetched pull ref does not match the triggering PR head SHA");
  }

  appendEnv("ADVISOR_WORKDIR", targetDir);
  appendEnv("PR_NUMBER", input.targetPr);
  return { workdir: targetDir, prNumber: input.targetPr };
}

function main(): void {
  try {
    prepareTargetPr({
      targetRepo: process.env.TARGET_REPO ?? "",
      targetPr: process.env.TARGET_PR ?? "",
      targetBase: process.env.TARGET_BASE ?? "",
      prBaseSha: process.env.PR_BASE_SHA || undefined,
      expectedHeadSha: process.env.EXPECTED_HEAD_SHA || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
