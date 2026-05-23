// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

export function getChangedFiles(base: string, head: string): string[] {
  const stdout = gitOutput(
    [
      ["diff", "--name-only", `${base}...${head}`],
      ["diff", "--name-only", `${base}..${head}`],
    ],
    10 * 1024 * 1024,
  );
  if (stdout === undefined) {
    throw new Error(`failed to diff ${base}..${head}; ensure both refs are fetched`);
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

export function getDiff(base: string, head: string, maxChars: number): string {
  const stdout = gitOutput(
    [
      ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}...${head}`],
      ["diff", "--find-renames", "--find-copies", "--unified=80", `${base}..${head}`],
    ],
    20 * 1024 * 1024,
  );
  return stdout === undefined ? "" : truncate(stdout, maxChars);
}

export function getDiffStat(base: string, head: string): string {
  return gitOutput(
    [
      ["diff", "--stat", `${base}...${head}`],
      ["diff", "--stat", `${base}..${head}`],
    ],
    1024 * 1024,
  )?.trim() || "<diff stat unavailable>";
}

export function getCommits(base: string, head: string): string[] {
  return (gitOutput([["log", "--oneline", `${base}..${head}`]], 1024 * 1024) || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export function getHeadSha(head: string): string {
  return execFileSync("git", ["rev-parse", head], { encoding: "utf8" }).trim();
}

export function gitOutput(commands: string[][], maxBuffer: number): string | undefined {
  for (const command of commands) {
    try {
      return execFileSync("git", command, { encoding: "utf8", maxBuffer });
    } catch {
      // Try the next form. Some checkouts do not have a merge base locally.
    }
  }
  return undefined;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n<diff truncated at ${maxChars} characters>`;
}
