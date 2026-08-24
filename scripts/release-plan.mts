// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isCanonicalNemoClawRemote, isLocalReleaseFixtureRemote } from "./release/remote.mts";

const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

type Options = {
  version: string;
  output?: string;
  candidate?: string;
  exception?: string;
};

type ReleasePlan = {
  previousTag: string;
  previousTagObject: string;
  previousTagCommit: string;
  nextTag: string;
  originMainCommit: string;
  originMainHeadline: string;
  candidateCommit: string;
  candidateSelection: "current-main" | "historical";
  historicalCandidateException: string;
};

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const commandError = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = commandError.stdout ? String(commandError.stdout).trim() : "";
    const stderr = commandError.stderr ? String(commandError.stderr).trim() : "";
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"),
    );
  }
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires ${option === "--output" ? "a path" : "a value"}`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  let version = "";
  let output: string | undefined;
  let candidate: string | undefined;
  let exception: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = readValue(argv, index, "--version");
      index += 1;
    } else if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
    } else if (arg === "--output") {
      output = readValue(argv, index, "--output");
      index += 1;
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
      if (!output) throw new Error("--output requires a value");
    } else if (arg === "--candidate") {
      candidate = readValue(argv, index, "--candidate");
      index += 1;
    } else if (arg.startsWith("--candidate=")) {
      candidate = arg.slice("--candidate=".length);
    } else if (arg === "--exception") {
      exception = readValue(argv, index, "--exception");
      index += 1;
    } else if (arg.startsWith("--exception=")) {
      exception = arg.slice("--exception=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!SEMVER_TAG.test(version)) {
    throw new Error("--version must be an exact vX.Y.Z tag");
  }
  if (candidate !== undefined && !FULL_SHA.test(candidate)) {
    throw new Error("--candidate must be a full lowercase 40-character Git SHA");
  }
  if (candidate !== undefined && !exception?.trim()) {
    throw new Error("--exception requires a nonblank plain-language reason with --candidate");
  }
  if (exception !== undefined && /[\u0000-\u001f\u007f]/u.test(exception)) {
    throw new Error("--exception must be a single-line plain-language reason");
  }
  if (candidate === undefined && exception !== undefined) {
    throw new Error("--exception is only valid with a historical --candidate");
  }
  return { version, output, candidate, exception: exception?.trim() };
}

function printHelp(): void {
  console.log(
    "Usage: tsx scripts/release-plan.mts --version vX.Y.Z [--output PATH] [--candidate FULL_SHA --exception REASON]\n\nCaptures origin/main by default. A historical candidate requires an explicit exception reason.",
  );
}

function semverParts(tag: string): [bigint, bigint, bigint] {
  const match = SEMVER_TAG.exec(tag);
  if (!match) {
    throw new Error(`Invalid semver tag: ${tag}`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareSemverDescending(left: string, right: string): number {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function readRemoteSemverTags(): Array<{ name: string; object?: string; commit?: string }> {
  const tags = new Map<string, { object?: string; commit?: string }>();
  for (const line of run("git", ["ls-remote", "--tags", "origin", "refs/tags/v*"]).split("\n")) {
    const [object, ref = ""] = line.trim().split(/\s+/);
    const match = /^refs\/tags\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(\^\{\})?$/.exec(
      ref,
    );
    if (!match || !object) continue;
    const entry = tags.get(match[1]) ?? {};
    if (match[2]) entry.commit = object;
    else entry.object = object;
    tags.set(match[1], entry);
  }
  return [...tags]
    .sort(([left], [right]) => compareSemverDescending(left, right))
    .map(([name, entry]) => ({ name, object: entry.object, commit: entry.commit }));
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"]).trim();
  process.chdir(repoRoot);

  const fetchUrlOutput = run("git", ["remote", "get-url", "--all", "origin"]).trim();
  const pushUrlOutput = run("git", ["remote", "get-url", "--push", "--all", "origin"]).trim();
  if (!fetchUrlOutput) {
    throw new Error("origin has no fetch URL");
  }
  if (!pushUrlOutput) {
    throw new Error("origin has no push URL");
  }
  const fetchUrls = fetchUrlOutput.split("\n");
  const pushUrls = pushUrlOutput.split("\n");
  const allCanonical = [...fetchUrls, ...pushUrls].every(isCanonicalNemoClawRemote);
  const oneMatchingUrl =
    fetchUrls.length === 1 && pushUrls.length === 1 && fetchUrls[0] === pushUrls[0];
  if (
    !allCanonical &&
    !(
      process.env.NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL === "1" &&
      oneMatchingUrl &&
      isLocalReleaseFixtureRemote(fetchUrls[0]!)
    )
  ) {
    if (oneMatchingUrl) {
      throw new Error(`Unexpected origin remote: ${fetchUrls[0]}`);
    }
    throw new Error("Unexpected origin fetch or push URL");
  }

  run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);

  const semverTags = readRemoteSemverTags();
  if (semverTags.length === 0) {
    throw new Error("No remote semver tags found");
  }

  const previousTag = semverTags[0].name;
  const previousTagObject = semverTags[0].object;
  const previousTagCommit = semverTags[0].commit;
  if (!previousTagObject || !previousTagCommit) {
    throw new Error(`Latest remote release tag must be annotated: ${previousTag}`);
  }
  if (semverTags.some(({ name }) => name === options.version)) {
    throw new Error(`Remote tag already exists: ${options.version}`);
  }
  if (compareSemverDescending(options.version, previousTag) >= 0) {
    throw new Error(`Release tag ${options.version} must be newer than ${previousTag}`);
  }

  const originMainCommit = run("git", ["rev-parse", "origin/main"]).trim();
  const originMainHeadline = run("git", ["log", "--oneline", "-1", "origin/main"]).trim();
  const candidateCommit = options.candidate
    ? run("git", ["rev-parse", "--verify", `${options.candidate}^{commit}`]).trim()
    : originMainCommit;
  if (options.candidate && candidateCommit !== options.candidate) {
    throw new Error(`Candidate does not resolve to the exact commit ${options.candidate}`);
  }
  if (options.candidate && candidateCommit === originMainCommit) {
    throw new Error("--candidate identifies current origin/main; omit --candidate and --exception");
  }
  try {
    run("git", ["merge-base", "--is-ancestor", previousTagCommit, candidateCommit]);
  } catch {
    throw new Error(`Candidate commit ${candidateCommit} does not follow previous release ${previousTag}`);
  }
  try {
    run("git", ["merge-base", "--is-ancestor", candidateCommit, originMainCommit]);
  } catch {
    throw new Error(`Candidate commit is not reachable from origin/main: ${candidateCommit}`);
  }
  const candidateHeadline = run("git", ["log", "--oneline", "-1", candidateCommit]).trim();
  const candidateSelection = options.candidate ? "historical" : "current-main";
  const output = path.resolve(
    options.output ?? path.join(repoRoot, "..", `nemoclaw-release-${options.version}`, "plan.json"),
  );
  const plan: ReleasePlan = {
    previousTag,
    previousTagObject,
    previousTagCommit,
    nextTag: options.version,
    originMainCommit,
    originMainHeadline,
    candidateCommit,
    candidateSelection,
    historicalCandidateException: options.exception ?? "None",
  };

  mkdirSync(path.dirname(output), { recursive: true });
  try {
    writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Release plan already exists: ${output}. Reuse it or choose a new --output path; it was not overwritten.`,
      );
    }
    throw error;
  }

  console.log(`Release plan written: ${output}`);
  console.log(`Previous tag: ${previousTag}`);
  console.log(`Previous tag object: ${previousTagObject}`);
  console.log(`Previous tag commit: ${previousTagCommit}`);
  console.log(`Next tag: ${options.version}`);
  console.log(`Candidate commit: ${candidateHeadline}`);
  console.log(`Candidate selection: ${candidateSelection}`);
  if (options.exception) console.log(`Historical candidate exception: ${options.exception}`);
  console.log("Confirmation phrase:");
  console.log(`CONFIRM RELEASE ${options.version} ${candidateCommit}`);
}

main();
