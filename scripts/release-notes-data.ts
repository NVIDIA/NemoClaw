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

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
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

function prNumbersFromCompare(compare: {
  commits?: Array<{ commit?: { message?: string } }>;
}): number[] {
  const numbers = new Set<number>();
  for (const commit of compare.commits ?? []) {
    const headline = commit.commit?.message?.split("\n")[0] ?? "";
    for (const match of headline.matchAll(/#(\d+)/g)) {
      numbers.add(Number(match[1]));
    }
  }
  return Array.from(numbers).sort((a, b) => a - b);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!options.plan) {
    throw new Error("--plan is required");
  }

  const planPath = path.resolve(options.plan);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const outputPath = path.resolve(
    options.output ?? path.join(path.dirname(planPath), "notes-data.json"),
  );
  const compareRange = `${plan.previousTag}...${plan.nextTag}`;

  const compare = JSON.parse(run("gh", ["api", `repos/NVIDIA/NemoClaw/compare/${compareRange}`]));
  const prNumbers = prNumbersFromCompare(compare);
  const pullRequests = prNumbers.map((number) =>
    JSON.parse(
      run("gh", [
        "pr",
        "view",
        String(number),
        "--repo",
        "NVIDIA/NemoClaw",
        "--json",
        "number,title,author,headRepositoryOwner,url,mergeCommit,labels,body,mergedAt",
      ]),
    ),
  );

  const data = {
    schemaVersion: 1,
    planPath,
    planHash: plan.planHash,
    previousTag: plan.previousTag,
    currentTag: plan.nextTag,
    targetCommit: plan.originMainCommit,
    compareRange,
    compare,
    prNumbers,
    pullRequests,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Release notes data written: ${outputPath}`);
}

main();
