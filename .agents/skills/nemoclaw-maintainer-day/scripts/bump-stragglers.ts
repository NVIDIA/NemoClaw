// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bump open items from one version label to another.
 *
 * Creates the target label if needed, then swaps labels on all open
 * PRs and issues carrying the source version.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/bump-stragglers.ts <from-version> <to-version> [--repo OWNER/REPO]
 */

import { execFileSync } from "node:child_process";

import { parseStringArg } from "./shared.ts";

interface BumpedItem {
  number: number;
  title: string;
  type: "pr" | "issue";
}

interface BumpOutput {
  from: string;
  to: string;
  bumped: BumpedItem[];
}

function main(): void {
  const args = process.argv.slice(2);
  const from = args[0];
  const to = args[1];
  if (!from || !to) {
    console.error("Usage: bump-stragglers.ts <from-version> <to-version> [--repo OWNER/REPO]");
    process.exit(1);
  }

  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  ensureReleaseLabel(repo, to);

  const bumped: BumpedItem[] = [];

  // Bump open PRs
  const prs = ghJsonArray<{ number: number; title: string }>([
    "pr",
    "list",
    "--repo",
    repo,
    "--label",
    from,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "100",
  ]);
  for (const pr of prs) {
    gh([
      "pr",
      "edit",
      String(pr.number),
      "--repo",
      repo,
      "--remove-label",
      from,
      "--add-label",
      to,
    ]);
    bumped.push({ number: pr.number, title: pr.title, type: "pr" });
  }

  // Bump open issues
  const issues = ghJsonArray<{ number: number; title: string }>([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    from,
    "--state",
    "open",
    "--json",
    "number,title",
    "--limit",
    "100",
  ]);
  for (const issue of issues) {
    gh([
      "issue",
      "edit",
      String(issue.number),
      "--repo",
      repo,
      "--remove-label",
      from,
      "--add-label",
      to,
    ]);
    bumped.push({ number: issue.number, title: issue.title, type: "issue" });
  }

  const output: BumpOutput = { from, to, bumped };
  console.log(JSON.stringify(output, null, 2));
}

function ensureReleaseLabel(repo: string, label: string): void {
  const labels = ghJsonArray<{ name: string }>([
    "label",
    "list",
    "--repo",
    repo,
    "--search",
    label,
    "--json",
    "name",
    "--limit",
    "100",
  ]);
  if (labels.some((entry) => entry.name === label)) return;

  gh([
    "label",
    "create",
    label,
    "--repo",
    repo,
    "--description",
    "Release target",
    "--color",
    "1d76db",
  ]);
}

function ghJsonArray<T>(args: string[]): T[] {
  const output = gh(args);
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`expected JSON array, got ${typeof parsed}`);
    }
    return parsed as T[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse gh JSON output for gh ${args.join(" ")}: ${reason}`);
  }
}

function gh(args: string[]): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const errorObject = typeof error === "object" && error !== null ? error : null;
    const stdout = readStringProperty(errorObject, "stdout")?.trim();
    const stderr = readStringProperty(errorObject, "stderr")?.trim();
    throw new Error([`gh ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n"));
  }
}

function readStringProperty(value: object | null, key: string): string | undefined {
  if (!value || Array.isArray(value)) return undefined;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

main();
