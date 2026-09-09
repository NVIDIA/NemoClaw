// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.join(import.meta.dirname, "../..");
export const planScriptPath = path.join(repositoryRoot, "scripts", "release-plan.mts");
const cutScriptPath = path.join(repositoryRoot, "scripts", "release-cut-tag.sh");
const temporaryRoots: string[] = [];

export type HistoricalReleaseFixture = {
  firstCommit: string;
  remote: string;
  root: string;
  work: string;
};

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "NODE_OPTIONS" && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_AUTHOR_EMAIL: "release-test@example.com",
    GIT_AUTHOR_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.com",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "tag.gpgSign",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_VALUE_1: "false",
    ...extra,
  };
}

export function run(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: environment(extraEnv) });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: environment() }).trim();
}

export function createFixture(): HistoricalReleaseFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-historical-release-"));
  temporaryRoots.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const signingKey = path.join(root, "release-signing-key");
  git(root, "init", "--bare", remote);
  execFileSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "release-test@example.com", "-f", signingKey],
    { cwd: root, env: environment() },
  );
  fs.mkdirSync(work);
  git(work, "init");
  git(work, "config", "user.name", "Release Test");
  git(work, "config", "user.email", "release-test@example.com");
  git(work, "config", "gpg.format", "ssh");
  git(work, "config", "user.signingkey", signingKey);
  fs.writeFileSync(path.join(work, "file.txt"), "initial\n");
  git(work, "add", "file.txt");
  git(work, "commit", "-m", "initial");
  git(work, "branch", "-M", "main");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "-u", "origin", "main");
  return { firstCommit: git(work, "rev-parse", "HEAD"), remote, root, work };
}

export function cleanupFixtures(): void {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
}

export function commit(fixture: HistoricalReleaseFixture, message: string): string {
  fs.appendFileSync(path.join(fixture.work, "file.txt"), `${message}\n`);
  git(fixture.work, "add", "file.txt");
  git(fixture.work, "commit", "-m", message);
  git(fixture.work, "push", "origin", "main");
  return git(fixture.work, "rev-parse", "HEAD");
}

export function pushTag(fixture: HistoricalReleaseFixture, tag: string, target: string): void {
  git(fixture.work, "-c", "tag.gpgSign=false", "tag", "-a", tag, target, "-m", tag);
  git(fixture.work, "push", "origin", `refs/tags/${tag}`);
}

export function planArguments(candidate: string, exception?: string, output?: string): string[] {
  const args = [
    "node",
    "--experimental-strip-types",
    "--no-warnings",
    planScriptPath,
    "--version",
    "v0.0.2",
    "--candidate",
    candidate,
  ];
  if (exception !== undefined) args.push("--exception", exception);
  if (output !== undefined) args.push("--output", output);
  return args;
}

export function createHistoricalPlan(
  fixture: HistoricalReleaseFixture,
  candidate: string,
  exception: string,
): { path: string; plan: Record<string, string> } {
  const planPath = path.join(fixture.root, "release", "plan.json");
  const result = run(fixture.work, planArguments(candidate, exception, planPath), {
    NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1",
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return {
    path: planPath,
    plan: JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, string>,
  };
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>#])/g, "\\$1");
}

export function releaseBrief(plan: Record<string, string>): string {
  return [
    `# NemoClaw ${plan.nextTag} release brief`,
    "",
    `- Candidate: \`${plan.candidateCommit}\``,
    `- Historical candidate exception: ${markdownText(plan.historicalCandidateException)}`,
    "",
    "## Canonical release entry",
    "",
    `Release entry exception: ${plan.historicalCandidateException}`,
    "",
    "## Documentation coverage",
    "",
    "- Latest included cumulative docs PR: None.",
    "- Final PR commit and merge commit: None.",
    `- Final automated refresh coverage commit: \`${plan.previousTagCommit}\``,
    "- Later commits and merged PRs: Recorded.",
    "- Changed paths: Recorded.",
    "- Review and checks: Recorded.",
    "- Open managed docs PRs: None.",
    "- Maintainer decision: Proceed with the candidate as shown.",
    "",
    "## Base and managed image evidence",
    "",
    `- Base-image candidate: \`${plan.candidateCommit}\``,
    "- Evidence: successful publication aggregate.",
    "",
    "## General E2E decision",
    "",
    "- Decision: proceed.",
    "",
    "Exceptions: None",
    "",
  ].join("\n");
}

export function writeBrief(fixture: HistoricalReleaseFixture, content: string): string {
  const messageFile = path.join(fixture.root, "release-brief.md");
  fs.writeFileSync(messageFile, content);
  return messageFile;
}

export function cutHistoricalPlan(
  fixture: HistoricalReleaseFixture,
  planPath: string,
  plan: Record<string, string>,
  messageFile: string,
): ReturnType<typeof spawnSync> {
  return run(
    fixture.work,
    [
      "bash",
      cutScriptPath,
      "--plan",
      planPath,
      "--message-file",
      messageFile,
      "--confirm",
      `CONFIRM RELEASE ${plan.nextTag} ${plan.candidateCommit}`,
    ],
    { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
  );
}

export function remoteCommit(fixture: HistoricalReleaseFixture, ref: string): string {
  return git(fixture.root, "--git-dir", fixture.remote, "rev-parse", `${ref}^{}`);
}

export function remoteTagText(fixture: HistoricalReleaseFixture, ref: string): string {
  const object = git(fixture.root, "--git-dir", fixture.remote, "rev-parse", ref);
  return git(fixture.root, "--git-dir", fixture.remote, "cat-file", "-p", object);
}
