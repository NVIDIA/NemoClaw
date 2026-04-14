// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import moveMap from "./ts-migration/move-map.json";

type Options = {
  base: string;
  head: string;
};

type ChangedFile = {
  status: string;
  oldPath: string | null;
  newPath: string;
};

type GuardedPath = {
  filePath: string;
  canonical: string;
  kind: "migrated-runtime" | "removed-shim" | "migrated-test";
};

const RUNTIME_MOVES = moveMap.runtimeMoves as Record<string, string>;
const REMOVED_SHIM_MOVES: Record<string, string> = {
  "bin/lib/chat-filter.js": "src/lib/chat-filter.ts",
  "bin/lib/config-io.js": "src/lib/config-io.ts",
  "bin/lib/debug.js": "src/lib/debug.ts",
  "bin/lib/inference-config.js": "src/lib/inference-config.ts",
  "bin/lib/local-inference.js": "src/lib/local-inference.ts",
  "bin/lib/nim.js": "src/lib/nim.ts",
  "bin/lib/onboard-session.js": "src/lib/onboard-session.ts",
  "bin/lib/platform.js": "src/lib/platform.ts",
  "bin/lib/preflight.js": "src/lib/preflight.ts",
  "bin/lib/registry.js": "src/lib/registry.ts",
  "bin/lib/resolve-openshell.js": "src/lib/resolve-openshell.ts",
  "bin/lib/runtime-recovery.js": "src/lib/runtime-recovery.ts",
  "bin/lib/sandbox-build-context.js": "src/lib/sandbox-build-context.ts",
  "bin/lib/services.js": "src/lib/services.ts",
  "bin/lib/version.js": "src/lib/version.ts",
  "bin/lib/onboard.js": "src/lib/onboard.ts",
  "bin/lib/policies.js": "src/lib/policies.ts",
  "bin/lib/runner.js": "src/lib/runner.ts",
};

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
  console.log(`Usage: npm run ts-migration:guard -- --base origin/main [--head HEAD]\n\nFails when a PR edits migrated legacy JS paths or removed compatibility shims instead of the canonical TS files.`);
}

function runGit(args: string[]): string {
  return String(execFileSync("git", args, { encoding: "utf8" })).trim();
}

function getChangedFiles(base: string, head: string): ChangedFile[] {
  const output = runGit(["diff", "--name-status", `${base}...${head}`]);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", firstPath = "", secondPath = ""] = line.split("\t");
      const isRenameOrCopy = /^[RC]/.test(status);
      return {
        status,
        oldPath: isRenameOrCopy ? firstPath : null,
        newPath: isRenameOrCopy ? secondPath : firstPath,
      };
    })
    .filter((entry) => Boolean(entry.newPath));
}

function classifyGuardedPath(filePath: string): GuardedPath | null {
  if (filePath in REMOVED_SHIM_MOVES) {
    return {
      filePath,
      canonical: REMOVED_SHIM_MOVES[filePath],
      kind: "removed-shim",
    };
  }
  if (filePath in RUNTIME_MOVES) {
    return {
      filePath,
      canonical: RUNTIME_MOVES[filePath],
      kind: "migrated-runtime",
    };
  }
  if (/^test\/.*\.test\.js$/.test(filePath)) {
    return {
      filePath,
      canonical: filePath.replace(/\.js$/, ".ts"),
      kind: "migrated-test",
    };
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
  const legacyEdits = Array.from(
    new Map(
      changedFiles
        .filter((entry) => !entry.status.startsWith("D"))
        .flatMap((entry) => [entry.oldPath, entry.newPath])
        .filter((filePath): filePath is string => Boolean(filePath))
        .map((filePath) => [filePath, classifyGuardedPath(filePath)]),
    ).values(),
  ).filter((entry): entry is GuardedPath => entry !== null);

  if (legacyEdits.length === 0) {
    console.log("No edits to migrated legacy paths or removed compatibility shims detected.");
    return;
  }

  const migratedPaths = legacyEdits.filter((entry) => entry.kind !== "removed-shim");
  const removedShims = legacyEdits.filter((entry) => entry.kind === "removed-shim");

  console.error("Guarded legacy paths were edited in this PR.");
  console.error("");
  if (migratedPaths.length > 0) {
    console.error("Migrated legacy paths must be edited via their canonical TS files:");
    for (const entry of migratedPaths) {
      console.error(`  ${entry.filePath} -> ${entry.canonical}`);
    }
    console.error("");
  }
  if (removedShims.length > 0) {
    console.error("Removed compatibility shims must not be reintroduced or edited directly:");
    for (const entry of removedShims) {
      console.error(`  ${entry.filePath} -> ${entry.canonical}`);
    }
    console.error("");
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
