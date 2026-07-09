// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_PARITY_MANIFEST = "test/e2e/mock-parity.json";

export type MockParityEntry = {
  live: string;
  fast?: string[];
  liveOnlyReason?: string;
};

export type MockParityManifest = {
  version: 1;
  entries: MockParityEntry[];
};

const LIVE_TEST = /^test\/e2e\/live\/.+\.test\.ts$/u;
const FAST_TESTS = [
  /^src\/.+\.test\.ts$/u,
  /^nemoclaw\/src\/.+\.test\.ts$/u,
  /^test\/e2e\/support\/.+\.test\.ts$/u,
  /^test\/(?!e2e\/|package-contract\/).+\.test\.(?:js|ts)$/u,
] as const;

function isSafeRepoPath(file: string): boolean {
  return (
    file.length > 0 &&
    !path.posix.isAbsolute(file) &&
    !file.includes("\\") &&
    !file.split("/").includes("..")
  );
}

function isFastPrTest(file: string): boolean {
  return isSafeRepoPath(file) && FAST_TESTS.some((pattern) => pattern.test(file));
}

export function validateMockParity(options: {
  manifest: MockParityManifest;
  changedFiles: readonly string[];
  fileExists?: (file: string) => boolean;
}): string[] {
  const {
    manifest,
    changedFiles,
    fileExists = (file) => fs.existsSync(path.join(REPO_ROOT, file)),
  } = options;
  const errors: string[] = [];

  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    return ["mock parity manifest must have version 1 and an entries array"];
  }

  const entries = new Map<string, MockParityEntry>();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.live !== "string") {
      errors.push("mock parity entries must be objects with a live path");
      continue;
    }
    if (!isSafeRepoPath(entry.live) || !LIVE_TEST.test(entry.live)) {
      errors.push(`${entry.live}: live path must be a test/e2e/live/**/*.test.ts file`);
      continue;
    }
    if (entries.has(entry.live)) {
      errors.push(`${entry.live}: duplicate mock parity entry`);
      continue;
    }
    entries.set(entry.live, entry);

    if (
      entry.fast !== undefined &&
      (!Array.isArray(entry.fast) || entry.fast.some((file) => typeof file !== "string"))
    ) {
      errors.push(`${entry.live}: fast must be an array of test paths`);
      continue;
    }
    if (entry.liveOnlyReason !== undefined && typeof entry.liveOnlyReason !== "string") {
      errors.push(`${entry.live}: liveOnlyReason must be a string`);
      continue;
    }
    const fast = entry.fast ?? [];
    const liveOnlyReason = entry.liveOnlyReason?.trim() ?? "";
    if (fast.length > 0 && liveOnlyReason) {
      errors.push(`${entry.live}: choose fast tests or a live-only reason, not both`);
    } else if (fast.length === 0 && !liveOnlyReason) {
      errors.push(`${entry.live}: map at least one fast test or provide a live-only reason`);
    }

    if (!fileExists(entry.live)) errors.push(`${entry.live}: live test does not exist`);
    for (const fastFile of new Set(fast)) {
      if (!isFastPrTest(fastFile)) {
        errors.push(`${entry.live}: ${fastFile} is not collected by a fast PR test project`);
      } else if (!fileExists(fastFile)) {
        errors.push(`${entry.live}: mapped fast test does not exist: ${fastFile}`);
      }
    }
  }

  for (const liveFile of [...new Set(changedFiles)].filter((file) => LIVE_TEST.test(file))) {
    if (!entries.has(liveFile)) {
      errors.push(`${liveFile}: changed live E2E needs an entry in ${DEFAULT_PARITY_MANIFEST}`);
    }
  }

  return errors.sort();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function changedFiles(base: string, head: string): string[] {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function main(): void {
  const base = argument("--base");
  const head = argument("--head") ?? "HEAD";
  if (!base) throw new Error("usage: e2e-mock-parity.ts --base <git-ref> [--head <git-ref>]");

  const manifestPath = path.join(REPO_ROOT, DEFAULT_PARITY_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as MockParityManifest;
  const errors = validateMockParity({ manifest, changedFiles: changedFiles(base, head) });
  if (errors.length > 0) {
    console.error(
      ["E2E mock/live parity check failed:", ...errors.map((error) => `- ${error}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  console.log("E2E mock/live parity check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
