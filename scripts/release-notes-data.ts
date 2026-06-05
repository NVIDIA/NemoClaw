// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type Options = {
  plan?: string;
  output?: string;
};

type ReleasePlan = {
  schemaVersion: 1;
  mode: "tag-only";
  previousTag: string;
  nextTag: string;
  originMainCommit: string;
  planHash: string;
};

type PullRequestWarning = {
  number: number;
  message: string;
};

const RELEASE_NOTES_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: RELEASE_NOTES_COMMAND_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") {
      options.plan = argv[++i];
    } else if (arg.startsWith("--plan=")) {
      options.plan = arg.slice("--plan=".length);
    } else if (arg === "--output") {
      options.output = argv[++i];
    } else if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log("Usage: tsx scripts/release-notes-data.ts --plan PATH [--output PATH]");
}

function validatePlan(value: unknown): ReleasePlan {
  if (!value || typeof value !== "object") {
    throw new Error("Release plan must be an object");
  }
  const plan = value as Record<string, unknown>;
  const semver = /^v\d+\.\d+\.\d+$/;
  const sha = /^[0-9a-f]{40}$/;
  const hash = /^[0-9a-f]{64}$/;
  if (plan.schemaVersion !== 1) {
    throw new Error("Release plan schemaVersion must be 1");
  }
  if (plan.mode !== "tag-only") {
    throw new Error("Release plan mode must be tag-only");
  }
  if (typeof plan.previousTag !== "string" || !semver.test(plan.previousTag)) {
    throw new Error("Release plan previousTag must be a semver tag");
  }
  if (typeof plan.nextTag !== "string" || !semver.test(plan.nextTag)) {
    throw new Error("Release plan nextTag must be a semver tag");
  }
  if (typeof plan.originMainCommit !== "string" || !sha.test(plan.originMainCommit)) {
    throw new Error("Release plan originMainCommit must be a full SHA");
  }
  if (typeof plan.planHash !== "string" || !hash.test(plan.planHash)) {
    throw new Error("Release plan planHash must be a sha256 hex string");
  }
  return plan as ReleasePlan;
}

function prNumbersFromCompare(compare: {
  commits?: Array<{ commit?: { message?: string } }>;
}): number[] {
  const numbers = new Set<number>();
  for (const commit of compare.commits ?? []) {
    const headline = commit.commit?.message?.split("\n")[0] ?? "";
    const squashMatch = /\(#(\d+)\)\s*$/.exec(headline);
    if (squashMatch) {
      numbers.add(Number(squashMatch[1]));
      continue;
    }

    const mergeMatch = /^Merge pull request #(\d+)\b/.exec(headline);
    if (mergeMatch) {
      numbers.add(Number(mergeMatch[1]));
    }
  }
  return Array.from(numbers).sort((a, b) => a - b);
}

function readPullRequest(number: number, warnings: PullRequestWarning[]): unknown | null {
  try {
    return JSON.parse(
      run("gh", [
        "pr",
        "view",
        String(number),
        "--repo",
        "NVIDIA/NemoClaw",
        "--json",
        "number,title,author,headRepositoryOwner,url,mergeCommit,labels,body,mergedAt",
      ]),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({ number, message });
    console.warn(`release-notes-data: warning: failed to fetch PR #${number}: ${message}`);
    return null;
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.plan) {
    throw new Error("--plan is required");
  }

  const planPath = path.resolve(options.plan);
  const plan = validatePlan(JSON.parse(readFileSync(planPath, "utf8")));
  const outputPath = path.resolve(
    options.output ?? path.join(path.dirname(planPath), "notes-data.json"),
  );
  const compareRange = `${plan.previousTag}...${plan.nextTag}`;

  const compare = JSON.parse(run("gh", ["api", `repos/NVIDIA/NemoClaw/compare/${compareRange}`]));
  const prNumbers = prNumbersFromCompare(compare);
  const pullRequestWarnings: PullRequestWarning[] = [];
  const pullRequests = prNumbers
    .map((number) => readPullRequest(number, pullRequestWarnings))
    .filter((pr): pr is NonNullable<typeof pr> => pr !== null);

  const data = {
    schemaVersion: 1,
    status: pullRequestWarnings.length > 0 ? "partial" : "ok",
    planPath,
    planHash: plan.planHash,
    previousTag: plan.previousTag,
    currentTag: plan.nextTag,
    targetCommit: plan.originMainCommit,
    compareRange,
    compare,
    prNumbers,
    pullRequests,
    pullRequestWarnings,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Release notes data written: ${outputPath}`);
}

main();
