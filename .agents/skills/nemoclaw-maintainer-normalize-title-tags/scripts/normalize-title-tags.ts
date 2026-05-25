// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preview or apply cleanup for bracketed NemoClaw tags in GitHub issue and PR titles.
 *
 * Removes any bracket tag whose content is `nemoclaw`, case-insensitively,
 * anywhere in the title.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings \
 *     .agents/skills/nemoclaw-maintainer-normalize-title-tags/scripts/normalize-title-tags.ts \
 *     [--repo OWNER/REPO] [--state all|open|closed] [--apply]
 */

import { execFileSync } from "node:child_process";

type QueryState = "all" | "open" | "closed";
type ItemState = "open" | "closed";
type ItemType = "issue" | "pr";

interface GitHubIssueLike {
  number: number;
  title: string;
  state: ItemState;
  html_url: string;
  pull_request?: unknown;
}

interface TitleCleanup {
  matchedTags: string[];
  newTitle: string;
}

interface Match {
  number: number;
  type: ItemType;
  state: ItemState;
  url: string;
  matchedTags: string[];
  oldTitle: string;
  newTitle: string;
}

interface Options {
  repo: string;
  state: QueryState;
  apply: boolean;
}

const BRACKET_TAG_REGEX = /\[[^\]]+\]/g;

function usage(): string {
  return [
    "Usage:",
    "  node --experimental-strip-types --no-warnings \\",
    "    .agents/skills/nemoclaw-maintainer-normalize-title-tags/scripts/normalize-title-tags.ts \\",
    "    [--repo OWNER/REPO] [--state all|open|closed] [--apply]",
    "",
    "Defaults:",
    "  --repo NVIDIA/NemoClaw",
    "  --state all",
    "  dry-run mode unless --apply is provided",
  ].join("\n");
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ghJson(args: string[]): unknown {
  return JSON.parse(run("gh", args));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: "NVIDIA/NemoClaw",
    state: "all",
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--repo") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--repo requires OWNER/REPO");
      }
      options.repo = value;
      i += 1;
      continue;
    }

    if (arg === "--state") {
      const value = argv[i + 1] as QueryState | undefined;
      if (value !== "all" && value !== "open" && value !== "closed") {
        throw new Error("--state must be one of: all, open, closed");
      }
      options.state = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function isNemoclawTag(tag: string): boolean {
  return tag.slice(1, -1).trim().toLowerCase() === "nemoclaw";
}

function cleanupTitle(title: string): string {
  return title.replace(/\s{2,}/g, " ").trim();
}

function stripNemoclawTags(title: string): TitleCleanup {
  const matchedTags: string[] = [];

  const withoutTags = title.replace(BRACKET_TAG_REGEX, (tag) => {
    if (!isNemoclawTag(tag)) {
      return tag;
    }
    matchedTags.push(tag);
    return "";
  });

  return {
    matchedTags,
    newTitle: cleanupTitle(withoutTags),
  };
}

function listItems(repo: string, state: QueryState): GitHubIssueLike[] {
  const items: GitHubIssueLike[] = [];

  for (let page = 1; ; page += 1) {
    const response = ghJson([
      "api",
      `repos/${repo}/issues?state=${state}&per_page=100&page=${page}`,
    ]);

    if (!Array.isArray(response) || response.length === 0) {
      break;
    }

    for (const item of response) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.number === "number" &&
        typeof item.title === "string" &&
        (item.state === "open" || item.state === "closed") &&
        typeof item.html_url === "string"
      ) {
        items.push(item as GitHubIssueLike);
      }
    }
  }

  return items;
}

function collectMatches(options: Options): Match[] {
  const matches: Match[] = [];

  for (const item of listItems(options.repo, options.state)) {
    const cleaned = stripNemoclawTags(item.title);
    if (cleaned.matchedTags.length === 0 || cleaned.newTitle === item.title) {
      continue;
    }

    if (!cleaned.newTitle) {
      console.error(`Skipping #${item.number}: cleanup would produce an empty title.`);
      continue;
    }

    matches.push({
      number: item.number,
      type: item.pull_request ? "pr" : "issue",
      state: item.state,
      url: item.html_url,
      matchedTags: cleaned.matchedTags,
      oldTitle: item.title,
      newTitle: cleaned.newTitle,
    });
  }

  return matches.sort((a, b) => a.number - b.number);
}

function printSummary(options: Options, matches: Match[]): void {
  const tagCounts = new Map<string, number>();
  let issueCount = 0;
  let prCount = 0;
  let tagTotal = 0;

  for (const match of matches) {
    for (const tag of match.matchedTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      tagTotal += 1;
    }
    if (match.type === "issue") {
      issueCount += 1;
    } else {
      prCount += 1;
    }
  }

  console.log(`Mode: ${options.apply ? "apply" : "dry-run"}`);
  console.log(`Repo: ${options.repo}`);
  console.log(`State: ${options.state}`);
  console.log(`Title matches: ${matches.length} (${issueCount} issues, ${prCount} PRs)`);
  console.log(`Tags to remove: ${tagTotal}`);

  if (tagCounts.size > 0) {
    console.log("Tag counts:");
    for (const [tag, count] of tagCounts.entries()) {
      console.log(`  ${tag}: ${count}`);
    }
  }

  if (matches.length === 0) {
    console.log("No matching titles found.");
    return;
  }

  console.log("");
  for (const match of matches) {
    console.log(`#${match.number} [${match.type}] [${match.state}] ${match.url}`);
    console.log(`  tags: ${match.matchedTags.join(", ")}`);
    console.log(`  old: ${match.oldTitle}`);
    console.log(`  new: ${match.newTitle}`);
  }
}

function applyMatches(options: Options, matches: Match[]): void {
  for (const match of matches) {
    run("gh", [
      "api",
      "-X",
      "PATCH",
      `repos/${options.repo}/issues/${match.number}`,
      "-f",
      `title=${match.newTitle}`,
    ]);
    console.log(`UPDATED #${match.number}: ${match.oldTitle} -> ${match.newTitle}`);
  }
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const matches = collectMatches(options);
    printSummary(options, matches);

    if (!options.apply || matches.length === 0) {
      return;
    }

    console.log("");
    applyMatches(options, matches);

    console.log("\nVerifying...");
    const remaining = collectMatches({ ...options, apply: false });
    if (remaining.length > 0) {
      console.error(`Verification failed: ${remaining.length} matching titles remain.`);
      process.exit(1);
    }

    console.log("Verification passed: 0 matching titles remain.");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error(usage());
    process.exit(1);
  }
}

main();
