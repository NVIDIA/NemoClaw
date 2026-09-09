// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate exact-range QA context for a release brief.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings handoff-summary.ts \
 *     --plan PATH --output PATH
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isRiskyFile } from "./shared.ts";

export interface HandoffInput {
  previousTag: string;
  previousTagCommit: string;
  targetVersion: string;
  candidateCommit: string;
  candidateSelection: "current-main" | "historical";
  historicalCandidateException: string;
}

export interface HandoffOutput extends HandoffInput {
  commitCount: number;
  riskyFileCount: number;
  riskyAreas: string[];
  suggestedTestFocus: string[];
}

type CommandRunner = (command: string, args: string[]) => string;

const SEMVER = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const INCOMPLETE = "TODO_RELEASE_BRIEF";

const AREA_LABELS: Record<string, RegExp[]> = {
  "Installer / bootstrap": [
    /^install\.sh$/,
    /^setup\.sh$/,
    /^brev-setup\.sh$/,
    /^scripts\/.*\.sh$/,
  ],
  "Onboarding / host glue": [/^bin\/lib\/onboard\.js$/, /^bin\/.*\.js$/, /^src\/lib\/onboard\//],
  "Sandbox / policy / SSRF": [
    /^nemoclaw\/src\/blueprint\//,
    /^nemoclaw-blueprint\//,
    /policy/i,
    /ssrf/i,
  ],
  "Workflow / enforcement": [/^\.github\/workflows\//, /\.prek\./],
  "Credentials / inference": [/credential/i, /inference/i],
};

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
  } catch (error) {
    const value = error as { stderr?: Buffer | string };
    const detail = value.stderr ? String(value.stderr).trim() : "";
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, detail].filter(Boolean).join("\n"),
    );
  }
}

function validateInput(input: HandoffInput): void {
  if (!SEMVER.test(input.previousTag)) throw new Error("previous tag must be vX.Y.Z");
  if (!SEMVER.test(input.targetVersion)) throw new Error("target version must be vX.Y.Z");
  if (!SHA.test(input.previousTagCommit)) {
    throw new Error("previous tag commit must be a lowercase 40-character Git SHA");
  }
  if (!SHA.test(input.candidateCommit)) {
    throw new Error("candidate commit must be a lowercase 40-character Git SHA");
  }
  if (input.candidateSelection === "current-main") {
    if (input.historicalCandidateException !== "None") {
      throw new Error("current-main input must not contain a historical candidate exception");
    }
  } else if (
    input.candidateSelection !== "historical" ||
    !/\S/u.test(input.historicalCandidateException) ||
    /[\u0000-\u001f\u007f]/u.test(input.historicalCandidateException)
  ) {
    throw new Error("historical input must contain a single-line exception reason");
  }
}

function suggestedFocus(areasHit: Set<string>, commitCount: number): string[] {
  const focus: string[] = [];
  if (areasHit.has("Installer / bootstrap")) focus.push("Fresh install and upgrade paths");
  if (areasHit.has("Onboarding / host glue")) {
    focus.push("Onboarding wizard and sandbox creation");
  }
  if (areasHit.has("Sandbox / policy / SSRF")) {
    focus.push("Policy enforcement, network egress, and SSRF protections");
  }
  if (areasHit.has("Workflow / enforcement")) {
    focus.push("CI checks, pre-commit hooks, and DCO declarations");
  }
  if (areasHit.has("Credentials / inference")) {
    focus.push("Credential storage and inference provider routing");
  }
  if (focus.length === 0 && commitCount > 0) {
    focus.push("General smoke test; no risky areas were detected");
  }
  return focus;
}

export function buildHandoffSummary(
  input: HandoffInput,
  command: CommandRunner = run,
): HandoffOutput {
  validateInput(input);

  const resolvedCandidate = command("git", ["rev-parse", `${input.candidateCommit}^{commit}`]);
  if (resolvedCandidate !== input.candidateCommit) {
    throw new Error(`candidate does not resolve to ${input.candidateCommit}`);
  }
  const mergeBase = command("git", ["merge-base", input.previousTagCommit, input.candidateCommit]);
  if (mergeBase !== input.previousTagCommit) {
    throw new Error("previous tag commit is not an ancestor of the candidate");
  }

  const range = `${input.previousTagCommit}..${input.candidateCommit}`;
  const commitCountText = command("git", ["rev-list", "--count", range]);
  if (!/^\d+$/u.test(commitCountText)) throw new Error("git returned an invalid commit count");
  const commitCount = Number(commitCountText);
  if (!Number.isSafeInteger(commitCount)) throw new Error("release range is too large");

  const changed = command("git", ["diff", "--name-only", range]);
  const changedFiles = changed
    ? changed
        .split("\n")
        .map((file) => file.trim())
        .filter(Boolean)
    : [];
  const riskyFilesTouched = changedFiles.filter(isRiskyFile);
  const areasHit = new Set<string>();
  for (const file of riskyFilesTouched) {
    for (const [area, patterns] of Object.entries(AREA_LABELS)) {
      if (patterns.some((pattern) => pattern.test(file))) areasHit.add(area);
    }
  }

  return {
    ...input,
    commitCount,
    riskyFileCount: riskyFilesTouched.length,
    riskyAreas: [...areasHit],
    suggestedTestFocus: suggestedFocus(areasHit, commitCount),
  };
}

function text(value: string): string {
  return value.replace(/([\\`*_[\]<>#])/g, "\\$1");
}

function code(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

function list(values: string[], empty: string): string[] {
  return values.length ? values.map((value) => `- ${text(value)}`) : [`- ${empty}`];
}

export function renderHandoffMarkdown(summary: HandoffOutput): string {
  const lines = [
    `# NemoClaw ${summary.targetVersion} release brief`,
    "",
    "## Release range",
    "",
    `- Previous release: ${code(summary.previousTag)} at ${code(summary.previousTagCommit)}`,
    `- Candidate: ${code(summary.candidateCommit)}`,
    `- Candidate selection: ${summary.candidateSelection}`,
    ...(summary.candidateSelection === "historical"
      ? [`- Historical candidate exception: ${text(summary.historicalCandidateException)}`]
      : []),
    `- Commits: ${summary.commitCount}`,
    `- Risky files detected: ${summary.riskyFileCount}`,
    "",
    "## QA context",
    "",
    "### Risky areas",
    "",
    ...list(summary.riskyAreas, "None detected."),
    "",
    "### Suggested test focus",
    "",
    ...list(summary.suggestedTestFocus, "No test focus was inferred."),
    "",
    "## Canonical release entry",
    "",
    `- Path: ${INCOMPLETE}`,
    "- Entry:",
    "",
    INCOMPLETE,
    "",
    "## Documentation coverage",
    "",
    `- Latest included cumulative docs PR: ${INCOMPLETE}`,
    `- Final PR commit and merge commit: ${INCOMPLETE}`,
    `- Final automated refresh coverage commit: ${INCOMPLETE}`,
    `- Later commits and merged PRs: ${INCOMPLETE}`,
    `- Changed paths: ${INCOMPLETE}`,
    `- Review and checks: ${INCOMPLETE}`,
    `- Open managed docs PRs: ${INCOMPLETE}`,
    `- Maintainer decision: ${INCOMPLETE}`,
    "",
    "## Base and managed image evidence",
    "",
    `- Base-image candidate: ${code(summary.candidateCommit)}`,
    `- Evidence: ${INCOMPLETE}`,
    "",
    "## General E2E decision",
    "",
    `- ${INCOMPLETE}: displayed run, requested runs, and maintainer choice.`,
    "",
    `Exceptions: ${INCOMPLETE}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv: string[]): { output: string; plan: string } {
  let output = "";
  let plan = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") {
      plan = argv[++index] ?? "";
      if (!plan || plan.startsWith("--")) throw new Error("--plan requires a path");
    } else if (argument === "--output") {
      output = argv[++index] ?? "";
      if (!output || output.startsWith("--")) throw new Error("--output requires a path");
    } else {
      throw new Error(`unknown argument: ${argument ?? "missing"}`);
    }
  }
  if (!plan || !output) throw new Error("usage: handoff-summary.ts --plan PATH --output PATH");
  return { output, plan };
}

function readPlan(planPath: string): HandoffInput {
  const value = JSON.parse(fs.readFileSync(path.resolve(planPath), "utf8")) as Record<
    string,
    unknown
  >;
  const expectedKeys = [
    "candidateCommit",
    "candidateSelection",
    "historicalCandidateException",
    "nextTag",
    "originMainCommit",
    "originMainHeadline",
    "previousTag",
    "previousTagCommit",
    "previousTagObject",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("release plan must contain exactly the nine supported fields");
  }
  if (typeof value.originMainHeadline !== "string" || !value.originMainHeadline) {
    throw new Error("release plan headline must be a nonempty string");
  }
  if (
    value.candidateSelection !== "current-main" &&
    value.candidateSelection !== "historical"
  ) {
    throw new Error("release plan candidate selection is invalid");
  }
  if (
    value.candidateSelection === "current-main" &&
    value.candidateCommit !== value.originMainCommit
  ) {
    throw new Error("current-main plan candidate must equal originMainCommit");
  }
  if (
    value.candidateSelection === "historical" &&
    value.candidateCommit === value.originMainCommit
  ) {
    throw new Error("historical plan candidate must differ from originMainCommit");
  }
  const input: HandoffInput = {
    previousTag: String(value.previousTag),
    previousTagCommit: String(value.previousTagCommit),
    targetVersion: String(value.nextTag),
    candidateCommit: String(value.candidateCommit),
    candidateSelection: value.candidateSelection,
    historicalCandidateException: String(value.historicalCandidateException),
  };
  validateInput(input);
  return input;
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const summary = buildHandoffSummary(readPlan(options.plan));
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, renderHandoffMarkdown(summary), { encoding: "utf8", flag: "wx" });
  console.log(`Release brief written: ${output}`);
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`handoff-summary: ${message}\n`);
    process.exitCode = 1;
  }
}
