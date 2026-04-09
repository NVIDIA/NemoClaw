// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import moveMap from "./ts-migration/move-map.json";

type Options = {
  prs: number[];
  all: boolean;
  base: string;
  dryRun: boolean;
  updateBranch: boolean;
  comment: boolean;
};

const REPO_ROOT = process.cwd();
const RUNTIME_MOVES = moveMap.runtimeMoves as Record<string, string>;

function parseArgs(argv: string[]): Options {
  const prs: number[] = [];
  let all = false;
  let base = "origin/main";
  let dryRun = false;
  let updateBranch = false;
  let comment = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pr") {
      prs.push(Number.parseInt(argv[index + 1] || "", 10));
      index += 1;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--base") {
      base = argv[index + 1] || base;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--update-branch") {
      updateBranch = true;
      continue;
    }
    if (arg === "--no-comment") {
      comment = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!all && prs.length === 0) {
    throw new Error("Pass --all or one or more --pr <number> values.");
  }

  return { prs, all, base, dryRun, updateBranch, comment };
}

function printHelp() {
  console.log(
    `Usage: npm run ts-migration:bulk-fix-prs -- --all [--base origin/main] [--update-branch] [--dry-run]\n       npm run ts-migration:bulk-fix-prs -- --pr 123 [--pr 456] [--base origin/main] [--update-branch] [--dry-run]\n\nMaintainer helper that ports stale PR branches across the JS→TS migration stack.`,
  );
}

function run(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; quiet?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (!options.quiet) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return result;
}

function runCapture(command: string, args: string[]): string {
  return String(execFileSync(command, args, { cwd: REPO_ROOT, encoding: "utf8" })).trim();
}

function isCleanWorktree(): boolean {
  return runCapture("git", ["status", "--porcelain"]) === "";
}

function getCurrentBranch(): string {
  return runCapture("git", ["branch", "--show-current"]);
}

function listTargetPrs(options: Options): Array<Record<string, unknown>> {
  if (!options.all) {
    return options.prs.map((number) => ({ number }));
  }
  return JSON.parse(
    runCapture("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,headRefName,baseRefName,url,maintainerCanModify",
    ]),
  );
}

function getPrMetadata(number: number): Record<string, unknown> {
  return JSON.parse(
    runCapture("gh", [
      "pr",
      "view",
      String(number),
      "--json",
      "number,title,headRefName,baseRefName,url,maintainerCanModify,files",
    ]),
  );
}

function touchesLegacyPaths(files: Array<{ path: string }>): boolean {
  return files.some((file) => {
    if (file.path in RUNTIME_MOVES) {
      return true;
    }
    return /^test\/.*\.test\.js$/.test(file.path);
  });
}

function comment(pr: number, body: string) {
  run("gh", ["pr", "comment", String(pr), "--body", body], { allowFailure: true, quiet: true });
}

function validateBranch(): boolean {
  const commands = [
    ["npm", ["run", "build:cli"]],
    ["npm", ["run", "typecheck:cli"]],
    ["npm", ["run", "lint"]],
    ["npm", ["test"]],
  ] as const;
  for (const [command, args] of commands) {
    const result = run(command, args, { allowFailure: true });
    if (result.status !== 0) {
      return false;
    }
  }
  return true;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun && !isCleanWorktree()) {
    throw new Error("Worktree must be clean before running bulk PR fixes.");
  }

  const startingBranch = getCurrentBranch();
  const summary = {
    fixed: [] as number[],
    skipped: [] as string[],
    manual: [] as string[],
  };

  try {
    const targets = listTargetPrs(options)
      .map((entry) => Number(entry.number))
      .filter((value) => Number.isFinite(value));

    for (const prNumber of targets) {
      const metadata = getPrMetadata(prNumber);
      const baseRef = String(metadata.baseRefName || "");
      const files = (metadata.files as Array<{ path: string }>) || [];
      if (baseRef !== "main") {
        summary.skipped.push(`#${prNumber}: base is ${baseRef}, not main`);
        continue;
      }
      if (!touchesLegacyPaths(files)) {
        summary.skipped.push(`#${prNumber}: does not touch migrated legacy paths`);
        continue;
      }
      if (!metadata.maintainerCanModify) {
        const body = [
          "I couldn't auto-port this branch because maintainer edits are disabled.",
          "",
          "Please run:",
          `  npm run ts-migration:assist -- --base ${options.base} --write`,
          "  npm run build:cli",
          "  npm run typecheck:cli",
          "  npm run lint",
          "  npm test",
        ].join("\n");
        if (options.comment && !options.dryRun) {
          comment(prNumber, body);
        }
        summary.manual.push(`#${prNumber}: maintainerCanModify=false`);
        continue;
      }

      console.log(`=== Processing PR #${prNumber} ===`);
      if (!options.dryRun) {
        run("gh", ["pr", "checkout", String(prNumber)]);
      }

      const assistArgs = [
        "run",
        "ts-migration:assist",
        "--",
        "--base",
        options.base,
        options.dryRun ? "--dry-run" : "--write",
      ];
      run("npm", assistArgs);

      if (options.updateBranch) {
        if (!options.dryRun) {
          run("git", ["fetch", "origin", "main"]);
          const merge = run("git", ["merge", "--no-edit", "origin/main"], { allowFailure: true });
          if (merge.status !== 0) {
            run("git", ["merge", "--abort"], { allowFailure: true, quiet: true });
            summary.manual.push(`#${prNumber}: merge from origin/main needs manual resolution`);
            if (options.comment) {
              comment(
                prNumber,
                [
                  "I attempted to port this branch across the JS→TS migration and merge `origin/main`,",
                  "but the branch still needs manual conflict resolution.",
                  "",
                  `Suggested first step: npm run ts-migration:assist -- --base ${options.base} --write`,
                ].join("\n"),
              );
            }
            continue;
          }
        } else {
          console.log(`Would merge ${options.base} into PR #${prNumber}`);
        }
      }

      if (!options.dryRun) {
        if (!validateBranch()) {
          summary.manual.push(`#${prNumber}: validation failed after porting`);
          if (options.comment) {
            comment(
              prNumber,
              [
                "I ported this branch across the JS→TS migration, but validation is still failing.",
                "Please inspect the latest branch state and rerun:",
                "",
                "  npm run build:cli",
                "  npm run typecheck:cli",
                "  npm run lint",
                "  npm test",
              ].join("\n"),
            );
          }
          continue;
        }

        if (runCapture("git", ["status", "--porcelain"]) !== "") {
          run("git", ["add", "-A"]);
          const commit = run(
            "git",
            ["commit", "-m", "chore(ts-migration): port branch across TS migration"],
            { allowFailure: true },
          );
          if (commit.status !== 0) {
            summary.manual.push(`#${prNumber}: could not create fixup commit automatically`);
            continue;
          }
          run("git", ["push"]);
          if (options.comment) {
            comment(
              prNumber,
              [
                "I ported this branch across the mechanical JS→TS migration stack and pushed the result.",
                "",
                "Validation rerun:",
                "- npm run build:cli",
                "- npm run typecheck:cli",
                "- npm run lint",
                "- npm test",
              ].join("\n"),
            );
          }
        }
      }

      summary.fixed.push(prNumber);
    }
  } finally {
    run("git", ["checkout", startingBranch], { allowFailure: true, quiet: true });
  }

  console.log("=== Bulk-fix summary ===");
  console.log(
    `Fixed: ${summary.fixed.length ? summary.fixed.map((pr) => `#${pr}`).join(", ") : "none"}`,
  );
  console.log(`Skipped: ${summary.skipped.length ? summary.skipped.join("; ") : "none"}`);
  console.log(`Manual: ${summary.manual.length ? summary.manual.join("; ") : "none"}`);
}

main();
