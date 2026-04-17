// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Check progress for a version label: shipped vs still open.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/version-progress.ts <version> [--repo OWNER/REPO]
 */

import { run, parseStringArg } from "./shared.ts";

interface ProgressItem {
  number: number;
  title: string;
  url: string;
  type: "pr" | "issue";
  ageHours: number;
}

interface ProgressOutput {
  version: string;
  shipped: ProgressItem[];
  open: ProgressItem[];
  summary: string;
}

function queryItems(
  repo: string,
  kind: "pr" | "issue",
  version: string,
  state: string,
): ProgressItem[] {
  const cmd = kind === "pr" ? "pr" : "issue";
  const out = run("gh", [
    cmd, "list", "--repo", repo,
    "--label", version, "--state", state,
    "--json", "number,title,url,createdAt", "--limit", "100",
  ]);
  if (!out) return [];
  try {
    const now = Date.now();
    const items = JSON.parse(out) as Array<{ number: number; title: string; url: string; createdAt: string }>;
    return items.map((i) => ({
      number: i.number,
      title: i.title,
      url: i.url,
      type: kind,
      ageHours: Math.floor((now - new Date(i.createdAt).getTime()) / 3_600_000),
    }));
  } catch {
    return [];
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const version = args[0];
  if (!version) {
    console.error("Usage: version-progress.ts <version> [--repo OWNER/REPO]");
    process.exit(1);
  }

  const repo = parseStringArg(args, "--repo", "NVIDIA/NemoClaw");

  const shipped = [
    ...queryItems(repo, "pr", version, "merged"),
    ...queryItems(repo, "issue", version, "closed"),
  ];
  const open = [
    ...queryItems(repo, "pr", version, "open"),
    ...queryItems(repo, "issue", version, "open"),
  ];

  const total = shipped.length + open.length;
  const summary = total === 0
    ? `${version}: no items labeled`
    : `${version}: ${shipped.length}/${total} shipped (${open.length} open)`;

  const output: ProgressOutput = { version, shipped, open, summary };
  console.log(JSON.stringify(output, null, 2));
}

main();
