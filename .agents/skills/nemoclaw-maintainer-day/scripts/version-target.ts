// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compute the day's target version and find stragglers from older versions.
 *
 * Reads the latest semver tag from the local repo, bumps patch by 1, then
 * queries GitHub for open PRs/issues carrying version labels older than
 * the target. Output is JSON.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-target.ts [--repo OWNER/REPO]
 */

import { run, parseStringArg } from "./shared.ts";

interface Straggler {
  number: number;
  title: string;
  url: string;
  type: "pr" | "issue";
  versionLabel: string;
}

interface VersionTargetOutput {
  latestTag: string;
  targetVersion: string;
  stragglers: Straggler[];
}

function getLatestTag(): string {
  const out = run("git", [
    "tag", "--sort=-v:refname",
  ]);
  if (!out) return "v0.0.0";

  for (const line of out.split("\n")) {
    if (/^v\d+\.\d+\.\d+$/.test(line.trim())) {
      return line.trim();
    }
  }
  return "v0.0.0";
}

function bumpPatch(tag: string): string {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "v0.0.1";
  return `v${match[1]}.${match[2]}.${parseInt(match[3], 10) + 1}`;
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function findStragglers(repo: string, targetVersion: string): Straggler[] {
  const stragglers: Straggler[] = [];

  // Get all open PRs with version labels
  const prOut = run("gh", [
    "pr", "list", "--repo", repo, "--state", "open",
    "--json", "number,title,url,labels", "--limit", "200",
  ]);
  if (prOut) {
    try {
      const prs = JSON.parse(prOut) as Array<{
        number: number; title: string; url: string;
        labels: Array<{ name: string }>;
      }>;
      for (const pr of prs) {
        for (const label of pr.labels) {
          // Only flag labels older than the target — not the target itself
          // and not future versions (e.g. v0.0.11 is not a straggler)
          if (/^v\d+\.\d+\.\d+$/.test(label.name) && compareSemver(label.name, targetVersion) < 0) {
            stragglers.push({
              number: pr.number,
              title: pr.title,
              url: pr.url,
              type: "pr",
              versionLabel: label.name,
            });
          }
        }
      }
    } catch (err: unknown) {
      process.stderr.write(`[version-target] Failed to parse PR list: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // Get all open issues with version labels
  const issueOut = run("gh", [
    "issue", "list", "--repo", repo, "--state", "open",
    "--json", "number,title,url,labels", "--limit", "200",
  ]);
  if (issueOut) {
    try {
      const issues = JSON.parse(issueOut) as Array<{
        number: number; title: string; url: string;
        labels: Array<{ name: string }>;
      }>;
      for (const issue of issues) {
        for (const label of issue.labels) {
          if (/^v\d+\.\d+\.\d+$/.test(label.name) && compareSemver(label.name, targetVersion) < 0) {
            stragglers.push({
              number: issue.number,
              title: issue.title,
              url: issue.url,
              type: "issue",
              versionLabel: label.name,
            });
          }
        }
      }
    } catch (err: unknown) {
      process.stderr.write(`[version-target] Failed to parse issue list: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  return stragglers;
}

function main(): void {
  const args = process.argv.slice(2);
  // --repo controls gh queries; git tags always come from the local checkout
  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  run("git", ["fetch", "origin", "--tags", "--prune"]);

  const latestTag = getLatestTag();
  const targetVersion = bumpPatch(latestTag);
  const stragglers = findStragglers(repo, targetVersion);

  const output: VersionTargetOutput = { latestTag, targetVersion, stragglers };
  console.log(JSON.stringify(output, null, 2));
}

main();
