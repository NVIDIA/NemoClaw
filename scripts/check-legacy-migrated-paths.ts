// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import moveMap from "./ts-migration/move-map.json";

type Options = {
  base: string;
  head: string;
};

const RUNTIME_MOVES = moveMap.runtimeMoves as Record<string, string>;

function parseArgs(argv: string[]): Options {
  let base = "origin/main";
  let head = "HEAD";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      base = argv[index + 1] || base;
      index += 1;
      continue;
    }
    if (arg === "--head") {
      head = argv[index + 1] || head;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { base, head };
}

function printHelp() {
  console.log(`Usage: npm run ts-migration:guard -- --base origin/main [--head HEAD]\n\nFails when a PR edits legacy migrated JS paths instead of the canonical TS files.`);
}

function runGit(args: string[]): string {
  return String(execFileSync("git", args, { encoding: "utf8" })).trim();
}

function getChangedFiles(base: string, head: string): string[] {
  const output = runGit(["diff", "--name-only", `${base}...${head}`]);
  if (!output) {
    return [];
  }
  return output.split("\n").filter(Boolean);
}

function canonicalPathFor(filePath: string): string | null {
  if (filePath in RUNTIME_MOVES) {
    return RUNTIME_MOVES[filePath];
  }
  if (/^test\/.*\.test\.js$/.test(filePath)) {
    return filePath.replace(/\.js$/, ".ts");
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (process.env.NEMOCLAW_ALLOW_LEGACY_PATHS === "1") {
    console.log("Skipping legacy-path guard because NEMOCLAW_ALLOW_LEGACY_PATHS=1.");
    return;
  }

  const changedFiles = getChangedFiles(options.base, options.head);
  const legacyEdits = changedFiles
    .map((filePath) => ({ filePath, canonical: canonicalPathFor(filePath) }))
    .filter((entry) => entry.canonical !== null);

  if (legacyEdits.length === 0) {
    console.log("No edits to migrated legacy paths detected.");
    return;
  }

  console.error("Legacy migrated paths were edited in this PR.");
  console.error("");
  console.error("Edit the canonical TS files instead:");
  for (const entry of legacyEdits) {
    console.error(`  ${entry.filePath} -> ${entry.canonical}`);
  }
  console.error("");
  console.error("To port a stale branch automatically, run:");
  console.error(`  npm run ts-migration:assist -- --base ${options.base} --write`);
  console.error("");
  console.error("Then validate with:");
  console.error("  npm run build:cli");
  console.error("  npm run typecheck:cli");
  console.error("  npm run lint");
  console.error("  npm test");
  process.exit(1);
}

main();
