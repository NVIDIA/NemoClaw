// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate a QA handoff summary for the upcoming release tag.
 *
 * Lists commits since the last tag, identifies risky areas touched,
 * and suggests test focus areas. Output is JSON.
 *
 * Usage: node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/handoff-summary.ts [--repo OWNER/REPO]
 */

import { isRiskyFile, run } from "./shared.ts";

interface CommitInfo {
  sha: string;
  subject: string;
}

interface HandoffOutput {
  previousTag: string;
  targetVersion: string;
  commitCount: number;
  commits: CommitInfo[];
  riskyFilesTouched: string[];
  riskyAreas: string[];
  suggestedTestFocus: string[];
}

const AREA_LABELS: Record<string, RegExp[]> = {
  "Installer / bootstrap": [/^install\.sh$/, /^setup\.sh$/, /^brev-setup\.sh$/, /^scripts\/.*\.sh$/],
  "Onboarding / host glue": [/^bin\/lib\/onboard\.js$/, /^bin\/.*\.js$/],
  "Sandbox / policy / SSRF": [/^nemoclaw\/src\/blueprint\//, /^nemoclaw-blueprint\//, /policy/i, /ssrf/i],
  "Workflow / enforcement": [/^\.github\/workflows\//, /\.prek\./],
  "Credentials / inference": [/credential/i, /inference/i],
};

function getLatestTag(): string {
  const out = run("git", ["tag", "--sort=-v:refname"]);
  if (!out) return "v0.0.0";
  for (const line of out.split("\n")) {
    if (/^v\d+\.\d+\.\d+$/.test(line.trim())) return line.trim();
  }
  return "v0.0.0";
}

function bumpPatch(tag: string): string {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "v0.0.1";
  return `v${match[1]}.${match[2]}.${parseInt(match[3], 10) + 1}`;
}

function main(): void {
  run("git", ["fetch", "origin", "--tags", "--prune"]);

  const previousTag = getLatestTag();
  const targetVersion = bumpPatch(previousTag);

  // Commits since last tag
  const logOut = run("git", [
    "log", "--oneline", "--format=%h %s", `${previousTag}..origin/main`,
  ]);
  const commits: CommitInfo[] = [];
  if (logOut) {
    for (const line of logOut.split("\n")) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx > 0) {
        commits.push({
          sha: line.slice(0, spaceIdx),
          subject: line.slice(spaceIdx + 1),
        });
      }
    }
  }

  // Files changed since last tag
  const diffOut = run("git", [
    "diff", "--name-only", `${previousTag}..origin/main`,
  ]);
  const changedFiles = diffOut ? diffOut.split("\n").map((f) => f.trim()).filter(Boolean) : [];
  const riskyFilesTouched = changedFiles.filter(isRiskyFile);

  // Map risky files to area labels
  const areasHit = new Set<string>();
  for (const file of riskyFilesTouched) {
    for (const [area, patterns] of Object.entries(AREA_LABELS)) {
      if (patterns.some((re) => re.test(file))) {
        areasHit.add(area);
      }
    }
  }
  const riskyAreas = [...areasHit];

  // Suggest test focus based on areas
  const suggestedTestFocus: string[] = [];
  if (areasHit.has("Installer / bootstrap")) suggestedTestFocus.push("Fresh install and upgrade paths");
  if (areasHit.has("Onboarding / host glue")) suggestedTestFocus.push("Onboarding wizard, sandbox creation");
  if (areasHit.has("Sandbox / policy / SSRF")) suggestedTestFocus.push("Policy enforcement, network egress, SSRF protections");
  if (areasHit.has("Workflow / enforcement")) suggestedTestFocus.push("CI checks, pre-commit hooks, DCO signing");
  if (areasHit.has("Credentials / inference")) suggestedTestFocus.push("Credential storage, inference provider routing");
  if (suggestedTestFocus.length === 0 && commits.length > 0) suggestedTestFocus.push("General smoke test — no risky areas touched");

  const output: HandoffOutput = {
    previousTag,
    targetVersion,
    commitCount: commits.length,
    commits,
    riskyFilesTouched,
    riskyAreas,
    suggestedTestFocus,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
