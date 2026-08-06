// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type Bump = "patch" | "minor" | "major";

type Options = {
  bump: Bump;
  candidateRecordedAt?: string;
  candidateRunId?: string;
  candidateSha?: string;
  output?: string;
  scheduledEdition?: string;
};

type RemoteTag = {
  tag: string;
  objectSha: string;
  peeledSha?: string;
};

type ReleaseAuthorization =
  | { type: "maintainer-confirmation" }
  | {
      type: "scheduled-workflow";
      repository: "NVIDIA/NemoClaw";
      plannerWorkflow: ".github/workflows/release-edition-close.yaml";
      editionDate: string;
      cutoffAt: string;
      candidateSource: {
        type: "github-actions-push-run";
        workflow: ".github/workflows/post-merge-agent-review.yaml";
        runId: string;
        recordedAt: string;
      };
    };

type ReleasePlan = {
  schemaVersion: 2;
  mode: "tag-only";
  status: "ready" | "no-changes";
  authorization: ReleaseAuthorization;
  previousTag: string;
  nextTag: string;
  bump: Bump;
  originRemote: string;
  originMainAtPlanning: string;
  candidateCommit: string;
  candidateHeadline: string;
  untaggedCommitCount: number;
  changelogEntry: string | null;
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
    if (options.allowFailure) return "";
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
  let candidateRecordedAt: string | undefined;
  let candidateRunId: string | undefined;
  let candidateSha: string | undefined;
  let output: string | undefined;
  let scheduledEdition: string | undefined;
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
    } else if (arg === "--scheduled-edition") {
      scheduledEdition = argv[++i];
    } else if (arg.startsWith("--scheduled-edition=")) {
      scheduledEdition = arg.slice("--scheduled-edition=".length);
    } else if (arg === "--candidate-sha") {
      candidateSha = argv[++i];
    } else if (arg.startsWith("--candidate-sha=")) {
      candidateSha = arg.slice("--candidate-sha=".length);
    } else if (arg === "--candidate-run-id") {
      candidateRunId = argv[++i];
    } else if (arg.startsWith("--candidate-run-id=")) {
      candidateRunId = arg.slice("--candidate-run-id=".length);
    } else if (arg === "--candidate-recorded-at") {
      candidateRecordedAt = argv[++i];
    } else if (arg.startsWith("--candidate-recorded-at=")) {
      candidateRecordedAt = arg.slice("--candidate-recorded-at=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (scheduledEdition !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledEdition)) {
    throw new Error(`Invalid --scheduled-edition value: ${scheduledEdition}`);
  }
  const candidateInputs = [candidateSha, candidateRunId, candidateRecordedAt];
  if (scheduledEdition && candidateInputs.some((value) => value === undefined)) {
    throw new Error(
      "Scheduled planning requires --candidate-sha, --candidate-run-id, and --candidate-recorded-at",
    );
  }
  if (!scheduledEdition && candidateInputs.some((value) => value !== undefined)) {
    throw new Error("Candidate source inputs require --scheduled-edition");
  }
  if (candidateSha !== undefined && !/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error(`Invalid --candidate-sha value: ${candidateSha}`);
  }
  if (candidateRunId !== undefined && !/^\d+$/.test(candidateRunId)) {
    throw new Error(`Invalid --candidate-run-id value: ${candidateRunId}`);
  }
  if (candidateRecordedAt !== undefined && Number.isNaN(Date.parse(candidateRecordedAt))) {
    throw new Error(`Invalid --candidate-recorded-at value: ${candidateRecordedAt}`);
  }
  if (candidateRecordedAt !== undefined) {
    candidateRecordedAt = new Date(candidateRecordedAt).toISOString();
  }
  return {
    bump,
    candidateRecordedAt,
    candidateRunId,
    candidateSha,
    output,
    scheduledEdition,
  };
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/release-plan.mts [--bump patch|minor|major] [--output PATH]
       tsx scripts/release-plan.mts --scheduled-edition YYYY-MM-DD \\
         --candidate-sha SHA --candidate-run-id ID --candidate-recorded-at ISO [--output PATH]

Creates a consistency-hashed tag-only release plan. A scheduled plan binds the
latest GitHub-recorded main push at or before 4:00 PM America/Los_Angeles.`);
}

function semverParts(tag: string): [number, number, number] {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) throw new Error(`Invalid semver tag: ${tag}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverDesc(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function bumpTag(tag: string, bump: Bump): string {
  const [major, minor, patch] = semverParts(tag);
  if (bump === "major") return `v${major + 1}.0.0`;
  if (bump === "minor") return `v${major}.${minor + 1}.0`;
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
  if (lines.length === 0) return null;
  const result: RemoteTag = { tag, objectSha: "" };
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    if (ref.endsWith("^{}")) result.peeledSha = sha;
    else result.objectSha = sha;
  }
  return result.objectSha ? result : null;
}

function zonedCutoff(editionDate: string): string {
  const [year, month, day] = editionDate.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.toISOString().slice(0, 10) !== editionDate) {
    throw new Error(`Invalid edition date: ${editionDate}`);
  }
  const desiredWallTime = Date.UTC(year, month - 1, day, 16, 0, 0);
  let instant = desiredWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const actualWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    instant += desiredWallTime - actualWallTime;
  }
  const cutoff = new Date(instant);
  if (Number.isNaN(cutoff.valueOf())) throw new Error(`Invalid edition date: ${editionDate}`);
  return cutoff.toISOString();
}

function findChangelogEntry(candidate: string, nextTag: string): string | null {
  const headingPattern = `^## ${nextTag.replaceAll(".", "\\.")}$`;
  const matches = run(
    "git",
    ["grep", "-n", "-E", headingPattern, candidate, "--", ":(glob)docs/changelog/*.mdx"],
    { allowFailure: true },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one direct changelog entry for ${nextTag}, found ${matches.length}`,
    );
  }
  return matches[0];
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

  if (run("git", ["status", "--short"]).trim()) {
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
  if (semverTags.length === 0) throw new Error("No remote semver tags found");

  const previousTag = semverTags[0];
  const nextTag = bumpTag(previousTag, options.bump);
  const followingTag = bumpTag(nextTag, "patch");
  if (readRemoteTag(nextTag)) throw new Error(`Remote tag already exists: ${nextTag}`);

  const originMainAtPlanning = run("git", ["rev-parse", "origin/main"]).trim();
  let authorization: ReleaseAuthorization = { type: "maintainer-confirmation" };
  let candidateCommit = originMainAtPlanning;
  if (options.scheduledEdition) {
    const cutoffAt = zonedCutoff(options.scheduledEdition);
    const candidateRecordedAt = options.candidateRecordedAt as string;
    if (Date.parse(candidateRecordedAt) > Date.parse(cutoffAt)) {
      throw new Error(
        `Candidate source time ${candidateRecordedAt} is after edition cutoff ${cutoffAt}`,
      );
    }
    candidateCommit = options.candidateSha as string;
    authorization = {
      type: "scheduled-workflow",
      repository: "NVIDIA/NemoClaw",
      plannerWorkflow: ".github/workflows/release-edition-close.yaml",
      editionDate: options.scheduledEdition,
      cutoffAt,
      candidateSource: {
        type: "github-actions-push-run",
        workflow: ".github/workflows/post-merge-agent-review.yaml",
        runId: options.candidateRunId as string,
        recordedAt: candidateRecordedAt,
      },
    };
  }

  run("git", ["cat-file", "-e", `${candidateCommit}^{commit}`]);
  try {
    run("git", ["merge-base", "--is-ancestor", candidateCommit, "origin/main"]);
  } catch {
    throw new Error(`Release candidate ${candidateCommit} is not reachable from origin/main`);
  }
  try {
    run("git", ["merge-base", "--is-ancestor", previousTag, candidateCommit]);
  } catch {
    throw new Error(`${previousTag} is not an ancestor of release candidate ${candidateCommit}`);
  }
  const untaggedCommitCount = Number(
    run("git", ["rev-list", "--count", `${previousTag}..${candidateCommit}`]).trim(),
  );
  const status = untaggedCommitCount === 0 ? "no-changes" : "ready";
  const changelogEntry = status === "ready" ? findChangelogEntry(candidateCommit, nextTag) : null;
  if (status === "ready" && changelogEntry === null) {
    throw new Error(
      `Candidate ${candidateCommit} is missing exactly one direct changelog entry for ${nextTag}`,
    );
  }

  const candidateHeadline = run("git", ["log", "--oneline", "-1", candidateCommit]).trim();
  const output = path.resolve(
    options.output ?? path.join(repoRoot, "..", `nemoclaw-release-${nextTag}`, "plan.json"),
  );
  const planPath = output;
  const operations =
    status === "no-changes"
      ? [
          "record that the edition contains no commits after the latest semver tag",
          "skip tag creation",
        ]
      : [
          `create signed annotated ${nextTag} tag at ${candidateCommit}`,
          `push ${nextTag}`,
          "invoke release-latest-tag directly after an automated token push",
          `have release-latest-tag carry open ${nextTag} items forward to ${followingTag}`,
          `have release-latest-tag delete released ${nextTag} label after carry-forward succeeds`,
          "draft release notes from live compare data",
        ];
  const planWithoutHash: Omit<ReleasePlan, "planHash"> = {
    schemaVersion: 2,
    mode: "tag-only",
    status,
    authorization,
    previousTag,
    nextTag,
    bump: options.bump,
    originRemote,
    originMainAtPlanning,
    candidateCommit,
    candidateHeadline,
    untaggedCommitCount,
    changelogEntry,
    compareRange: `${previousTag}...${nextTag}`,
    latestBefore: readRemoteTag("latest"),
    lkgBefore: readRemoteTag("lkg"),
    createdAt: new Date().toISOString(),
    planPath,
    confirmationPhrase: `CONFIRM RELEASE ${nextTag} ${candidateCommit}`,
    operations,
    forbiddenOperations: [
      "consult E2E state as tag authorization",
      "advance the candidate after the edition cutoff",
      "push latest from the tag-cut script",
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
  console.log(`Edition status: ${status}`);
  console.log(`Previous tag: ${previousTag}`);
  console.log(`Next tag: ${nextTag}`);
  console.log(`Planning-time origin/main: ${originMainAtPlanning}`);
  console.log(`Frozen candidate: ${candidateHeadline}`);
  if (authorization.type === "scheduled-workflow") {
    console.log(`Edition cutoff: ${authorization.cutoffAt}`);
  }
  console.log("Confirmation phrase:");
  console.log(plan.confirmationPhrase);
}

main();
