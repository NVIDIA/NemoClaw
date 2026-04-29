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

import { run, parseStringArg } from "./shared.ts";

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

  // Create target label if needed
  run("gh", [
    "label", "create", to, "--repo", repo,
    "--description", "Release target", "--color", "1d76db",
  ]);

  const bumped: BumpedItem[] = [];

  // Bump open PRs
  const prOut = run("gh", [
    "pr", "list", "--repo", repo, "--label", from,
    "--state", "open", "--json", "number,title", "--limit", "100",
  ]);
  if (prOut) {
    try {
      const prs = JSON.parse(prOut) as Array<{ number: number; title: string }>;
      for (const pr of prs) {
        run("gh", [
          "pr", "edit", String(pr.number), "--repo", repo,
          "--remove-label", from, "--add-label", to,
        ]);
        bumped.push({ number: pr.number, title: pr.title, type: "pr" });
      }
    } catch { /* ignore */ }
  }

  // Bump open issues
  const issueOut = run("gh", [
    "issue", "list", "--repo", repo, "--label", from,
    "--state", "open", "--json", "number,title", "--limit", "100",
  ]);
  if (issueOut) {
    try {
      const issues = JSON.parse(issueOut) as Array<{ number: number; title: string }>;
      for (const issue of issues) {
        run("gh", [
          "issue", "edit", String(issue.number), "--repo", repo,
          "--remove-label", from, "--add-label", to,
        ]);
        bumped.push({ number: issue.number, title: issue.title, type: "issue" });
      }
    } catch { /* ignore */ }
  }

  const output: BumpOutput = { from, to, bumped };
  console.log(JSON.stringify(output, null, 2));
}

main();
