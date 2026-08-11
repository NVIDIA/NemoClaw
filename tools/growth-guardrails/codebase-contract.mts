// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { countLines } from "../../scripts/check-test-file-size-budget.mts";
import { evaluateAddedJavaScriptFiles } from "./check-pr.mts";
import type { PullRequestFile } from "./pr-blob-client.mts";
import {
  evaluateConditionalViolations,
  isTestFilePath,
  type ConditionalChange,
} from "./test-conditionals.mts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ONBOARD_ENTRYPOINT = "src/lib/onboard.ts";

type LocalChange = PullRequestFile & { readonly status: string };

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function mergeBase(): string {
  return git(["merge-base", "origin/main", "HEAD"]).trim();
}

function collectChanges(): LocalChange[] {

  // `git diff <base>` compares the merge base with tracked working-tree content.
  // Add untracked files separately.
  const tokens = git(["diff", "--name-status", "-z", "--find-renames", mergeBase(), "--"])
    .split("\0")
    .filter(Boolean);
  const changes: LocalChange[] = [];
  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index++];
    const renamed = code.startsWith("R") || code.startsWith("C");
    const previous = renamed ? tokens[index++] : null;
    const filename = tokens[index++];
    changes.push({
      filename,
      previous_filename: previous,
      status: code.startsWith("A")
        ? "added"
        : code.startsWith("D")
          ? "removed"
          : renamed
            ? "renamed"
            : "modified",
    });
  }
  const known = new Set(changes.map(({ filename }) => filename));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((file) => file && !known.has(file));
  return [...changes, ...untracked.map((filename) => ({ filename, status: "added" }))];
}

function readBaseFile(base: string, file: string): string | null {
  try {
    return git(["show", `${base}:${file}`]);
  } catch {
    return null;
  }
}

function readCurrentFile(file: string): string | null {
  const absolute = path.join(REPO_ROOT, file);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

export function evaluateCurrentJavaScriptContract(): string[] {
  return evaluateAddedJavaScriptFiles(collectChanges());
}

export function evaluateCurrentOnboardContract(): string[] {
  const base = readBaseFile(mergeBase(), ONBOARD_ENTRYPOINT) ?? "";
  const current = readCurrentFile(ONBOARD_ENTRYPOINT) ?? "";
  const growth = countLines(current) - countLines(base);
  return growth > 0 ? [`${ONBOARD_ENTRYPOINT}: grew by ${growth} line(s)`] : [];
}

export function evaluateCurrentTestConditionalContract(): string[] {
  const base = mergeBase();
  const changes: ConditionalChange[] = [];
  const baseBlobs = new Map<string, string | null>();
  const headBlobs = new Map<string, string | null>();
  for (const file of collectChanges()) {
    if (!isTestFilePath(file.filename) && !isTestFilePath(file.previous_filename ?? "")) continue;
    const basePath = isTestFilePath(file.previous_filename ?? "")
      ? (file.previous_filename as string)
      : file.filename;
    const headPath =
      file.status === "removed" || !isTestFilePath(file.filename) ? null : file.filename;
    changes.push({ basePath, headPath, displayName: file.filename });
    baseBlobs.set(basePath, readBaseFile(base, basePath));
    if (headPath !== null) headBlobs.set(headPath, readCurrentFile(headPath));
  }
  return evaluateConditionalViolations(changes, baseBlobs, headBlobs).details;
}
