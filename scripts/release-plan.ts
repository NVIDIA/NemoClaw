// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type Bump = "patch" | "minor" | "major";

type Options = {
  bump: Bump;
  output?: string;
};

type RemoteTag = {
  tag: string;
  objectSha: string;
  peeledSha?: string;
};

type ReleasePlan = {
  schemaVersion: 1;
  mode: "tag-only";
  previousTag: string;
  nextTag: string;
  bump: Bump;
  originRemote: string;
  originMainCommit: string;
  originMainHeadline: string;
  compareRange: string;
  latestBefore: RemoteTag | null;
  lkgBefore: RemoteTag | null;
  createdAt: string;
  planPath: string;
  confirmationPhrase: string;
  operations: string[];
  forbiddenOperations: string[];
  planHash: string;
};

function run(command: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = e.stdout ? String(e.stdout).trim() : "";
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"),
    );
  }
}

function parseArgs(argv: string[]): Options {
  let bump: Bump = "patch";
  let output: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bump") {
      const value = argv[++i];
      if (value !== "patch" && value !== "minor" && value !== "major") {
        throw new Error(`Invalid --bump value: ${value}`);
      }
      bump = value;
    } else if (arg.startsWith("--bump=")) {
      const value = arg.slice("--bump=".length);
      if (value !== "patch" && value !== "minor" && value !== "major") {
        throw new Error(`Invalid --bump value: ${value}`);
      }
      bump = value;
    } else if (arg === "--output") {
      output = argv[++i];
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { bump, output };
}

function printHelp(): void {
  console.log(
    `Usage: tsx scripts/release-plan.ts [--bump patch|minor|major] [--output PATH]\n\nCreates a deterministic tag-only release plan for origin/main.`,
  );
}

function semverParts(tag: string): [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) {
    throw new Error(`Invalid semver tag: ${tag}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) {
      return pb[i] - pa[i];
    }
  }
  return 0;
}

function bumpTag(tag: string, bump: Bump): string {
  const [major, minor, patch] = semverParts(tag);
  if (bump === "major") {
    return `v${major + 1}.0.0`;
  }
  if (bump === "minor") {
    return `v${major}.${minor + 1}.0`;
  }
  return `v${major}.${minor}.${patch + 1}`;
}

function readRemoteSemverTags(): string[] {
  return Array.from(
    new Set(
      run("git", ["ls-remote", "--tags", "origin", "v*"])
        .split("\n")
        .map((line) => line.trim().split(/\s+/)[1] ?? "")
        .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
        .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)),
    ),
  ).sort(compareSemverDesc);
}

function readRemoteTag(tag: string): RemoteTag | null {
  const lines = run("git", ["ls-remote", "--tags", "origin", tag, `${tag}^{}`], {
    allowFailure: true,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const result: RemoteTag = { tag, objectSha: "" };
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    if (ref.endsWith("^{}")) {
      result.peeledSha = sha;
    } else {
      result.objectSha = sha;
    }
  }
  return result.objectSha ? result : null;
}

function stablePlanHash(planWithoutHash: Omit<ReleasePlan, "planHash">): string {
  return createHash("sha256")
    .update(JSON.stringify(planWithoutHash, null, 2))
    .digest("hex");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"]).trim();
  process.chdir(repoRoot);

  const status = run("git", ["status", "--short"]);
  if (status.trim()) {
    throw new Error("Release planning requires a clean worktree");
  }

  const originRemote = run("git", ["remote", "get-url", "origin"]).trim();
  if (
    process.env.NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL !== "1" &&
    !/NVIDIA\/NemoClaw(?:\.git)?$/.test(originRemote)
  ) {
    throw new Error(`Unexpected origin remote: ${originRemote}`);
  }

  run("git", ["fetch", "origin", "main", "--tags", "--force"]);

  const semverTags = readRemoteSemverTags();
  if (semverTags.length === 0) {
    throw new Error("No remote semver tags found");
  }

  const previousTag = semverTags[0];
  const nextTag = bumpTag(previousTag, options.bump);
  if (readRemoteTag(nextTag)) {
    throw new Error(`Remote tag already exists: ${nextTag}`);
  }

  const originMainCommit = run("git", ["rev-parse", "origin/main"]).trim();
  const originMainHeadline = run("git", ["log", "--oneline", "-1", "origin/main"]).trim();
  const output = path.resolve(
    options.output ?? path.join(repoRoot, "..", `nemoclaw-release-${nextTag}`, "plan.json"),
  );
  const planPath = output;

  const planWithoutHash: Omit<ReleasePlan, "planHash"> = {
    schemaVersion: 1,
    mode: "tag-only",
    previousTag,
    nextTag,
    bump: options.bump,
    originRemote,
    originMainCommit,
    originMainHeadline,
    compareRange: `${previousTag}...${nextTag}`,
    latestBefore: readRemoteTag("latest"),
    lkgBefore: readRemoteTag("lkg"),
    createdAt: new Date().toISOString(),
    planPath,
    confirmationPhrase: `CONFIRM RELEASE ${nextTag} ${originMainCommit}`,
    operations: [
      `create annotated ${nextTag} tag at ${originMainCommit}`,
      `push ${nextTag}`,
      "wait for release-latest-tag workflow to move latest",
      "draft release notes from live compare data",
    ],
    forbiddenOperations: [
      "push latest from the agent",
      "push or move lkg",
      "move existing remote semver tags",
      "delete tags",
      "commit version bumps",
      "open a release PR",
      "create a GitHub Discussion",
    ],
  };
  const plan: ReleasePlan = {
    ...planWithoutHash,
    planHash: stablePlanHash(planWithoutHash),
  };

  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`Release plan written: ${planPath}`);
  console.log(`Plan hash: ${plan.planHash}`);
  console.log(`Previous tag: ${previousTag}`);
  console.log(`Next tag: ${nextTag}`);
  console.log(`Target commit: ${originMainHeadline}`);
  console.log("Confirmation phrase:");
  console.log(plan.confirmationPhrase);
}

main();
