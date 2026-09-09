// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isCanonicalNemoClawRemote,
  isLocalReleaseFixtureRemote,
} from "../../../scripts/release/remote.mts";

const repoRoot = path.join(import.meta.dirname, "../../..");
const latestScriptPath = path.join(repoRoot, "scripts", "release-latest-tag.sh");
const cutScriptPath = path.join(repoRoot, "scripts", "release-cut-tag.sh");
const planScriptPath = path.join(repoRoot, "scripts", "release-plan.mts");
const tempRoots: string[] = [];

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== "NODE_OPTIONS" && value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnv({
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release-test@example.com",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.com",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "tag.gpgSign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    ...extra,
  });
}

function run(cwd: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: testEnv(),
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

type Fixture = {
  root: string;
  work: string;
  remote: string;
  summary: string;
  firstCommit: string;
};

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-latest-"));
  tempRoots.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const summary = path.join(root, "summary.md");
  const signingKey = path.join(root, "release-signing-key");

  run(root, ["git", "init", "--bare", remote]);
  run(root, [
    "ssh-keygen",
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "release-test@example.com",
    "-f",
    signingKey,
  ]);
  fs.mkdirSync(work);
  run(work, ["git", "init"]);
  run(work, ["git", "config", "user.name", "Release Test"]);
  run(work, ["git", "config", "user.email", "release-test@example.com"]);
  run(work, ["git", "config", "gpg.format", "ssh"]);
  run(work, ["git", "config", "user.signingkey", signingKey]);
  fs.writeFileSync(path.join(work, "file.txt"), "initial\n");
  run(work, ["git", "add", "file.txt"]);
  run(work, ["git", "commit", "-m", "initial"]);
  run(work, ["git", "branch", "-M", "main"]);
  run(work, ["git", "remote", "add", "origin", remote]);
  run(work, ["git", "push", "-u", "origin", "main"]);
  const firstCommit = run(work, ["git", "rev-parse", "HEAD"]).trim();

  return { root, work, remote, summary, firstCommit };
}

function commit(fixture: Fixture, text: string): string {
  fs.appendFileSync(path.join(fixture.work, "file.txt"), `${text}\n`);
  run(fixture.work, ["git", "add", "file.txt"]);
  run(fixture.work, ["git", "commit", "-m", text]);
  run(fixture.work, ["git", "push", "origin", "main"]);
  return run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
}

function pushTag(fixture: Fixture, tag: string, target = "HEAD", annotated = true): void {
  const args = annotated
    ? ["git", "-c", "tag.gpgSign=false", "tag", "-a", tag, target, "-m", tag]
    : ["git", "-c", "tag.gpgSign=false", "tag", tag, target];
  run(fixture.work, args);
  run(fixture.work, ["git", "push", "origin", `refs/tags/${tag}`]);
}

function localTagObject(fixture: Fixture, tag: string): string {
  return run(fixture.work, ["git", "rev-parse", `refs/tags/${tag}`], {
    allowFailure: true,
  }).trim();
}

function runReleaseLatest(
  fixture: Fixture,
  releaseTag: string,
  expectedReleaseTagObject = localTagObject(fixture, releaseTag) || "0".repeat(40),
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [latestScriptPath], {
    cwd: fixture.work,
    encoding: "utf8",
    env: testEnv({
      RELEASE_TAG: releaseTag,
      EXPECTED_RELEASE_TAG_OBJECT: expectedReleaseTagObject,
      REMOTE_NAME: "origin",
      GITHUB_STEP_SUMMARY: fixture.summary,
    }),
  });
}

function runReleaseLatestWithoutIdentity(
  fixture: Fixture,
  releaseTag: string,
): ReturnType<typeof spawnSync> {
  const home = path.join(fixture.root, "empty-home");
  const xdgConfigHome = path.join(fixture.root, "empty-xdg-config");
  fs.mkdirSync(home);
  fs.mkdirSync(xdgConfigHome);
  const env = baseEnv({
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "user.useConfigOnly",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "tag.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "commit.gpgSign",
    GIT_CONFIG_VALUE_2: "false",
    GITHUB_STEP_SUMMARY: fixture.summary,
    HOME: home,
    RELEASE_TAG: releaseTag,
    EXPECTED_RELEASE_TAG_OBJECT: localTagObject(fixture, releaseTag),
    REMOTE_NAME: "origin",
    XDG_CONFIG_HOME: xdgConfigHome,
  });
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;

  return spawnSync("bash", [latestScriptPath], {
    cwd: fixture.work,
    encoding: "utf8",
    env,
  });
}

function runScript(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    env: testEnv(extraEnv),
  });
}

function remoteCommit(fixture: Fixture, ref: string): string {
  return run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", `${ref}^{}`]).trim();
}

function remoteObject(fixture: Fixture, ref: string): string {
  return run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", ref]).trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function createPlan(
  fixture: Fixture,
  planPath: string,
  releaseCommit: string,
  version = "v0.0.2",
): { plan: Record<string, string>; result: ReturnType<typeof spawnSync> } {
  const result = runScript(
    fixture.work,
    [
      "node", "--experimental-strip-types", "--no-warnings", planScriptPath,
      "--version", version, "--output", planPath,
    ],
    { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
  );

  expect(result.status).toBe(0);
  const plan = readJson(planPath) as Record<string, string>;
  expect(plan).toMatchObject({
    previousTag: "v0.0.1",
    previousTagObject: remoteObject(fixture, "refs/tags/v0.0.1"),
    previousTagCommit: remoteCommit(fixture, "refs/tags/v0.0.1"),
    nextTag: version,
    originMainCommit: releaseCommit,
    candidateCommit: releaseCommit, candidateSelection: "current-main",
    historicalCandidateException: "None",
  });
  expect(plan.originMainHeadline).toMatch(/^[0-9a-f]+ planned release commit$/u);
  expect(Object.keys(plan).sort()).toEqual([
    "candidateCommit", "candidateSelection", "historicalCandidateException", "nextTag",
    "originMainCommit", "originMainHeadline", "previousTag", "previousTagCommit",
    "previousTagObject",
  ]);
  return { plan, result };
}

function confirmationFor(plan: Record<string, string>): string {
  return `CONFIRM RELEASE ${plan.nextTag} ${plan.candidateCommit}`;
}

function completeBrief(plan: Record<string, string>): string {
  const candidate = plan.candidateCommit ?? plan.originMainCommit;
  return [
    `# NemoClaw ${plan.nextTag} release brief`,
    "",
    `- Candidate: \`${candidate}\``,
    ...(plan.candidateSelection === "historical"
      ? [`- Historical candidate exception: ${plan.historicalCandidateException}`]
      : []),
    "",
    "## Canonical release entry",
    "",
    `## ${plan.nextTag}`,
    "",
    "- Release detail.",
    "",
    "## Documentation coverage",
    "",
    "- Latest included cumulative docs PR: #100.",
    `- Final PR commit and merge commit: \`${candidate}\``,
    `- Final automated refresh coverage commit: \`${candidate}\``,
    "- Later commits and merged PRs: Only the docs PR merge.",
    "- Changed paths: Allowed documentation paths only.",
    "- Review and checks: Approved and successful.",
    "- Open managed docs PRs: None.",
    "- Maintainer decision: Proceed with the candidate as shown.",
    "",
    "## Base and managed image evidence",
    "",
    `- Base-image candidate: \`${candidate}\``,
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

function writeBrief(fixture: Fixture, content?: string): string {
  const messageFile = path.join(fixture.root, "release-brief.md");
  const candidate = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
  fs.writeFileSync(
    messageFile,
    content ??
      completeBrief({
        nextTag: "v0.0.2",
        originMainCommit: candidate,
        candidateCommit: candidate,
        candidateSelection: "current-main",
        historicalCandidateException: "None",
      }),
    "utf8",
  );
  return messageFile;
}

function cutFromPlan(
  fixture: Fixture,
  planPath: string,
  confirmation: string,
  messageFile?: string,
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  const selectedMessageFile =
    messageFile ?? writeBrief(fixture, completeBrief(readJson(planPath) as Record<string, string>));
  return runScript(
    fixture.work,
    [
      "bash",
      cutScriptPath,
      "--plan",
      planPath,
      "--message-file",
      selectedMessageFile,
      "--confirm",
      confirmation,
    ],
    { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1", ...extraEnv },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("release-latest-tag.sh", () => {
  it.each(["https://github.com/NVIDIA/NemoClaw", "https://github.com/NVIDIA/NemoClaw.git"])(
    "recognizes canonical NemoClaw origin form %s",
    (remote) => {
      expect(isCanonicalNemoClawRemote(remote)).toBe(true);
    },
  );

  it.each([
    "/tmp/NVIDIA/NemoClaw",
    "git@github.com:NVIDIA/NemoClaw.git",
    "ssh://git@github.com/NVIDIA/NemoClaw.git",
    "https://contributor@github.com/NVIDIA/NemoClaw.git",
    "https://example.com/NVIDIA/NemoClaw.git",
    "https://github.com/NVIDIA/another-repo.git",
  ])("rejects noncanonical NemoClaw origin form %s", (remote) => {
    expect(isCanonicalNemoClawRemote(remote)).toBe(false);
  });

  it("limits the test override to local filesystem remotes", () => {
    expect(isLocalReleaseFixtureRemote("/tmp/nemoclaw-release/remote.git")).toBe(true);
    expect(isLocalReleaseFixtureRemote("file:///tmp/nemoclaw-release/remote.git")).toBe(true);
    expect(isLocalReleaseFixtureRemote("file://release-host/tmp/nemoclaw-release/remote.git")).toBe(
      false,
    );
    expect(isLocalReleaseFixtureRemote("https://github.com/NVIDIA/another-repo.git")).toBe(false);
  });

  it("requires an exact version when it creates a release plan", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const planPath = path.join(fixture.root, "release", "plan.json");

    const missing = runScript(
      fixture.work,
      ["node", "--experimental-strip-types", "--no-warnings", planScriptPath, "--output", planPath],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );
    const derived = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--bump",
        "patch",
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );
    const leadingZero = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.01.0",
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );
    const missingOutput = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.0.2",
        "--output",
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("--version must be an exact vX.Y.Z tag");
    expect(derived.status).not.toBe(0);
    expect(derived.stderr).toContain("Unknown argument: --bump");
    expect(leadingZero.status).not.toBe(0);
    expect(leadingZero.stderr).toContain("--version must be an exact vX.Y.Z tag");
    expect(missingOutput.status).not.toBe(0);
    expect(missingOutput.stderr).toContain("--output requires a path");
  });

  it("rejects a split origin before fetching or writing a release plan", () => {
    const fixture = createFixture();
    const planPath = path.join(fixture.root, "release", "plan.json");
    run(fixture.work, [
      "git",
      "remote",
      "set-url",
      "origin",
      "https://github.com/NVIDIA/NemoClaw.git",
    ]);
    run(fixture.work, ["git", "config", "remote.origin.pushurl", fixture.remote]);

    const result = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.0.2",
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected origin fetch or push URL");
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it("does not let the fixture override authorize a network remote", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const networkRemote = "https://github.com/NVIDIA/another-repo.git";
    run(fixture.work, ["git", "remote", "set-url", "origin", networkRemote]);
    const rejectedPlanPath = path.join(fixture.root, "release", "network-plan.json");

    const planResult = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.0.2",
        "--output",
        rejectedPlanPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );
    const cutResult = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(planResult.status).not.toBe(0);
    expect(planResult.stderr).toContain(`Unexpected origin remote: ${networkRemote}`);
    expect(fs.existsSync(rejectedPlanPath)).toBe(false);
    expect(cutResult.status).not.toBe(0);
    expect(cutResult.stderr).toContain(`Unexpected origin remote: ${networkRemote}`);
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("advertises the signed release brief requirement", () => {
    const result = runScript(repoRoot, ["bash", cutScriptPath, "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("signed annotated semver tag");
    expect(result.stdout).toContain("--message-file release-brief.md");
  });

  it("does not overwrite an existing release plan", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const original = fs.readFileSync(planPath, "utf8");

    const result = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.0.2",
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Release plan already exists");
    expect(result.stderr).toContain("it was not overwritten");
    expect(fs.readFileSync(planPath, "utf8")).toBe(original);
  });

  it("does not pair a replanned candidate with the earlier release brief", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const firstCandidate = commit(fixture, "planned release commit");
    const firstPlanPath = path.join(fixture.root, "release-1", "plan.json");
    const { plan: firstPlan } = createPlan(fixture, firstPlanPath, firstCandidate);
    const firstBrief = writeBrief(fixture, completeBrief(firstPlan));
    const secondCandidate = commit(fixture, "planned release commit");
    const secondPlanPath = path.join(fixture.root, "release-2", "plan.json");
    const { plan: secondPlan } = createPlan(fixture, secondPlanPath, secondCandidate);

    const result = cutFromPlan(fixture, secondPlanPath, confirmationFor(secondPlan), firstBrief);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate does not match planned commit");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it.each([["base image", "Base-image candidate", "plan-bound base-image candidate"]])(
    "does not accept %s evidence copied from an earlier candidate",
    (_kind, field, error) => {
      const fixture = createFixture();
      pushTag(fixture, "v0.0.1", fixture.firstCommit);
      const earlierCandidate = commit(fixture, "earlier release candidate");
      const releaseCommit = commit(fixture, "planned release commit");
      const planPath = path.join(fixture.root, "release", "plan.json");
      const { plan } = createPlan(fixture, planPath, releaseCommit);
      const staleBrief = completeBrief(plan).replace(
        `- ${field}: \`${releaseCommit}\``,
        `- ${field}: \`${earlierCandidate}\``,
      );

      const result = cutFromPlan(
        fixture,
        planPath,
        confirmationFor(plan),
        writeBrief(fixture, staleBrief),
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
      expect(localTagObject(fixture, "v0.0.2")).toBe("");
    },
  );

  it("orders canonical semver components without numeric precision loss", () => {
    const fixture = createFixture();
    const previousTag = "v9007199254740992.0.0";
    const nextTag = "v9007199254740993.0.0";
    pushTag(fixture, previousTag, fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const result = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        nextTag,
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );
    const plan = readJson(planPath) as Record<string, string>;

    expect(result.status).toBe(0);
    expect(plan.previousTag).toBe(previousTag);
    expect(plan.nextTag).toBe(nextTag);
    const cut = cutFromPlan(fixture, planPath, confirmationFor(plan));
    expect(cut.status).toBe(0);
    expect(remoteCommit(fixture, `refs/tags/${nextTag}`)).toBe(releaseCommit);
  });

  it("promotes latest to the newest annotated semver tag without touching lkg", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit);
    const releaseCommit = commit(fixture, "release commit");
    pushTag(fixture, "v0.0.1");

    const result = runReleaseLatest(fixture, "v0.0.1");

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(releaseCommit);
    expect(remoteObject(fixture, "refs/tags/latest")).toBe(
      remoteObject(fixture, "refs/tags/v0.0.1"),
    );
    expect(remoteCommit(fixture, "refs/tags/lkg")).toBe(fixture.firstCommit);
    expect(fs.readFileSync(fixture.summary, "utf8")).toContain("Not touched: `lkg`");
  });

  it("promotes the existing tag object without requiring a runner git identity", () => {
    const fixture = createFixture();
    const releaseCommit = commit(fixture, "release commit");
    pushTag(fixture, "v0.0.1");
    run(fixture.work, ["git", "config", "--unset", "user.name"]);
    run(fixture.work, ["git", "config", "--unset", "user.email"]);

    const result = runReleaseLatestWithoutIdentity(fixture, "v0.0.1");

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(releaseCommit);
    expect(remoteObject(fixture, "refs/tags/latest")).toBe(
      remoteObject(fixture, "refs/tags/v0.0.1"),
    );
    expect(
      run(fixture.work, ["git", "config", "--local", "user.name"], { allowFailure: true }),
    ).toBe("");
    expect(
      run(fixture.work, ["git", "config", "--local", "user.email"], { allowFailure: true }),
    ).toBe("");
  });

  it("rejects a release tag object that differs from the GitHub-verified object", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1");

    const result = runReleaseLatest(fixture, "v0.0.1", "f".repeat(40));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match GitHub-verified object");
    expect(
      runScript(fixture.root, [
        "git",
        "--git-dir",
        fixture.remote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/tags/latest",
      ]).status,
    ).not.toBe(0);
  });

  it("does not overwrite a concurrent remote latest update", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    expect(runReleaseLatest(fixture, "v0.0.1").status).toBe(0);
    const releaseCommit = commit(fixture, "next release commit");
    pushTag(fixture, "v0.0.2", releaseCommit);
    pushTag(fixture, "concurrent-latest", fixture.firstCommit);
    const concurrentObject = remoteObject(fixture, "refs/tags/concurrent-latest");
    const hookPath = path.join(fixture.work, ".git", "hooks", "pre-push");
    fs.writeFileSync(
      hookPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `git --git-dir=${shellQuote(fixture.remote)} update-ref refs/tags/latest ${concurrentObject}`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(hookPath, 0o755);

    const result = runReleaseLatest(fixture, "v0.0.2");

    expect(result.status).not.toBe(0);
    expect(remoteObject(fixture, "refs/tags/latest")).toBe(concurrentObject);
    expect(remoteObject(fixture, "refs/tags/latest")).not.toBe(
      remoteObject(fixture, "refs/tags/v0.0.2"),
    );
  });

  it("rejects non-semver tags", () => {
    const fixture = createFixture();

    const result = runReleaseLatest(fixture, "latest");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to promote non-semver tag");
  });

  it("rejects lightweight semver tags", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", "HEAD", false);

    const result = runReleaseLatest(fixture, "v0.0.1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release tags must be annotated");
  });

  it("rejects an older semver tag when a newer semver tag exists", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1");
    commit(fixture, "newer release commit");
    pushTag(fixture, "v0.0.2");

    const result = runReleaseLatest(fixture, "v0.0.1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("latest remote semver tag is v0.0.2");
  });

  it("rejects a higher semver tag on an older main commit so latest cannot move backward", () => {
    const fixture = createFixture();
    const olderCommit = fixture.firstCommit;
    const newerCommit = commit(fixture, "newer already released commit");
    pushTag(fixture, "v0.0.1", newerCommit);
    expect(runReleaseLatest(fixture, "v0.0.1").status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(newerCommit);
    pushTag(fixture, "v0.0.2", olderCommit);

    const result = runReleaseLatest(fixture, "v0.0.2");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to move latest backward");
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(newerCommit);
  });

  it("rejects a higher semver tag on an older main commit even when latest is missing", () => {
    const fixture = createFixture();
    const olderCommit = fixture.firstCommit;
    const newerCommit = commit(fixture, "newer already released commit");
    pushTag(fixture, "v0.0.1", newerCommit);
    pushTag(fixture, "v0.0.2", olderCommit);

    const result = runReleaseLatest(fixture, "v0.0.2");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("previous release v0.0.1");
    expect(
      runScript(fixture.root, [
        "git",
        "--git-dir",
        fixture.remote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/tags/latest",
      ]).status,
    ).not.toBe(0);
  });

  it("rejects a semver tag whose commit is not reachable from main", () => {
    const fixture = createFixture();
    run(fixture.work, ["git", "checkout", "--orphan", "release-orphan"]);
    fs.writeFileSync(path.join(fixture.work, "file.txt"), "orphan\n");
    run(fixture.work, ["git", "add", "file.txt"]);
    run(fixture.work, ["git", "commit", "-m", "orphan release"]);
    pushTag(fixture, "v0.0.1");
    run(fixture.work, ["git", "checkout", "main"]);

    const result = runReleaseLatest(fixture, "v0.0.1");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is not reachable from refs/remotes/origin/main");
  });

  it("signs the release brief verbatim and pushes only the tag without hooks or gh", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const brief = completeBrief(plan)
      .replace("- Decision: proceed.", "- Decision: proceed with recorded exception.")
      .replace(
        "Exceptions: None",
        "Exceptions: The accepted full run tested the preceding commit.",
      );
    const messageFile = writeBrief(fixture, brief);
    const hookPath = path.join(fixture.work, ".git", "hooks", "pre-push");
    fs.writeFileSync(hookPath, "#!/usr/bin/env bash\nexit 97\n", "utf8");
    fs.chmodSync(hookPath, 0o755);
    const mockBin = path.join(fixture.root, "mock-bin");
    const ghMarker = path.join(fixture.root, "gh-called");
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "gh"),
      `#!/usr/bin/env bash\ntouch ${shellQuote(ghMarker)}\nexit 88\n`,
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "gh"), 0o755);

    const cutResult = cutFromPlan(fixture, planPath, confirmationFor(plan), messageFile, {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(cutResult.status).toBe(0);
    expect(fs.existsSync(ghMarker)).toBe(false);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    const tagObject = remoteObject(fixture, "refs/tags/v0.0.2");
    expect(cutResult.stdout).toContain(`pushed signed v0.0.2 object ${tagObject}`);
    const rawTag = run(fixture.root, [
      "git",
      "--git-dir",
      fixture.remote,
      "cat-file",
      "-p",
      tagObject,
    ]);
    expect(rawTag).toContain("-----BEGIN SSH SIGNATURE-----");
    const messageStart = rawTag.indexOf("\n\n") + 2;
    const signatureStart = rawTag.indexOf("-----BEGIN SSH SIGNATURE-----", messageStart);
    expect(rawTag.slice(messageStart, signatureStart)).toBe(brief);
  });

  it("signs the validated brief snapshot when the source file changes before tagging", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const brief = completeBrief(plan);
    const messageFile = writeBrief(fixture, brief);
    const mockBin = path.join(fixture.root, "mock-bin");
    const mutationMarker = path.join(fixture.root, "brief-mutated");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        `if [[ "$1" == "fetch" && ! -e ${shellQuote(mutationMarker)} ]]; then`,
        `  printf '%s\\n' 'changed after validation' > ${shellQuote(messageFile)}`,
        `  touch ${shellQuote(mutationMarker)}`,
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), messageFile, {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(messageFile, "utf8")).toBe("changed after validation\n");
    const tagObject = remoteObject(fixture, "refs/tags/v0.0.2");
    const rawTag = run(fixture.root, [
      "git",
      "--git-dir",
      fixture.remote,
      "cat-file",
      "-p",
      tagObject,
    ]);
    const messageStart = rawTag.indexOf("\n\n") + 2;
    const signatureStart = rawTag.indexOf("-----BEGIN SSH SIGNATURE-----", messageStart);
    expect(rawTag.slice(messageStart, signatureStart)).toBe(brief);
  });

  it("fails before pushing when the configured signer is unavailable", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    run(fixture.work, ["git", "config", "gpg.format", "openpgp"]);
    run(fixture.work, [
      "git",
      "config",
      "gpg.program",
      path.join(fixture.root, "missing-release-signer"),
    ]);
    run(fixture.work, ["git", "config", "user.signingkey", "missing-release-key"]);

    const cutResult = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(cutResult.status).not.toBe(0);
    expect(cutResult.stderr).toContain("missing-release-signer");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("accepts a matching remote tag when push transport reports failure", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const mockBin = path.join(fixture.root, "mock-bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        'if [[ "$1" == "push" ]]; then',
        `  ${shellQuote(realGit)} "$@" || exit $?`,
        "  exit 73",
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), writeBrief(fixture), {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("push reported failure, but remote v0.0.2 matches");
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
  });

  it("removes the local tag after a failed push confirms remote absence", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const hookPath = path.join(fixture.remote, "hooks", "pre-receive");
    fs.writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        "while read -r old new ref; do",
        '  test "$ref" != "refs/tags/v0.0.2" || exit 1',
        "done",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(hookPath, 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("remote tag is absent; removed the local tag");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("keeps a concurrently replaced local tag after a failed push", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const hookPath = path.join(fixture.remote, "hooks", "pre-receive");
    fs.writeFileSync(
      hookPath,
      [
        "#!/bin/sh",
        "while read -r old new ref; do",
        '  test "$ref" != "refs/tags/v0.0.2" || exit 1',
        "done",
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(hookPath, 0o755);
    const mockBin = path.join(fixture.root, "mock-bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        'if [[ "$1" == "push" ]]; then',
        `  ${shellQuote(realGit)} "$@"`,
        "  status=$?",
        `  ${shellQuote(realGit)} update-ref refs/tags/v0.0.2 ${shellQuote(fixture.firstCommit)}`,
        "  exit $status",
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), writeBrief(fixture), {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("local tag could not be removed");
    expect(result.stderr).toContain("do not rerun the cutter");
    expect(localTagObject(fixture, "v0.0.2")).toBe(fixture.firstCommit);
  });

  it("keeps the local tag when remote read-back fails after publication", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const mockBin = path.join(fixture.root, "mock-bin");
    const pushMarker = path.join(fixture.root, "push-finished");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        'if [[ "$1" == "push" ]]; then',
        `  ${shellQuote(realGit)} "$@"`,
        "  status=$?",
        `  touch ${shellQuote(pushMarker)}`,
        "  exit $status",
        "fi",
        `if [[ -f ${shellQuote(pushMarker)} && "$1" == "ls-remote" && "\${4:-}" == "refs/tags/v0.0.2" ]]; then`,
        "  exit 66",
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), writeBrief(fixture), {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("kept the local tag");
    expect(result.stderr).toContain("do not rerun the cutter");
    expect(localTagObject(fixture, "v0.0.2")).not.toBe("");
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
  });

  it("keeps the local tag when a failed push finds different remote data", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const mockBin = path.join(fixture.root, "mock-bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        'if [[ "$1" == "push" ]]; then',
        `  object="$(${shellQuote(realGit)} --git-dir=${shellQuote(fixture.remote)} rev-parse refs/tags/v0.0.1)"`,
        `  ${shellQuote(realGit)} --git-dir=${shellQuote(fixture.remote)} update-ref refs/tags/v0.0.2 "$object"`,
        "  exit 73",
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), writeBrief(fixture), {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("different data; kept the local tag");
    expect(result.stderr).toContain("do not rerun the cutter");
    expect(localTagObject(fixture, "v0.0.2")).not.toBe("");
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(fixture.firstCommit);
  });

  it("ignores unrelated local-only semver tags", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    run(fixture.work, ["git", "tag", "v9.9.9", releaseCommit]);
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    expect(
      runScript(fixture.root, [
        "git",
        "--git-dir",
        fixture.remote,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/tags/v9.9.9",
      ]).status,
    ).not.toBe(0);
  });

  it.each(["release-cut-tag.sh", path.join("release", "remote.mts")])(
    "rejects canonical release writes when scripts/%s differs from origin/main",
    (changedScript) => {
      const fixture = createFixture();
      pushTag(fixture, "v0.0.1", fixture.firstCommit);
      const fixtureScriptDirectory = path.join(fixture.work, "scripts");
      const fixtureRemoteDirectory = path.join(fixtureScriptDirectory, "release");
      const fixtureCutScript = path.join(fixtureScriptDirectory, "release-cut-tag.sh");
      fs.mkdirSync(fixtureRemoteDirectory, { recursive: true });
      fs.copyFileSync(cutScriptPath, fixtureCutScript);
      fs.copyFileSync(
        path.join(repoRoot, "scripts", "release", "remote.mts"),
        path.join(fixtureRemoteDirectory, "remote.mts"),
      );
      run(fixture.work, ["git", "add", "scripts"]);
      const releaseCommit = commit(fixture, "planned release commit");
      const planPath = path.join(fixture.root, "release", "plan.json");
      const { plan } = createPlan(fixture, planPath, releaseCommit);
      const driftComment = changedScript.endsWith(".mts") ? "// local drift" : "# local drift";
      fs.appendFileSync(path.join(fixtureScriptDirectory, changedScript), `\n${driftComment}\n`);
      const mockBin = path.join(fixture.root, "mock-bin");
      const realGit = execFileSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).trim();
      fs.mkdirSync(mockBin);
      fs.writeFileSync(
        path.join(mockBin, "git"),
        [
          "#!/usr/bin/env bash",
          "set -u",
          'if [[ "$1" == "remote" && "$2" == "get-url" ]]; then',
          "  printf '%s\\n' 'https://github.com/NVIDIA/NemoClaw.git'",
          "  exit 0",
          "fi",
          `exec ${shellQuote(realGit)} "$@"`,
          "",
        ].join("\n"),
        "utf8",
      );
      fs.chmodSync(path.join(mockBin, "git"), 0o755);

      const result = runScript(
        fixture.work,
        [
          "bash",
          fixtureCutScript,
          "--plan",
          planPath,
          "--message-file",
          writeBrief(fixture, completeBrief(plan)),
          "--confirm",
          confirmationFor(plan),
        ],
        { PATH: `${mockBin}:${process.env.PATH ?? ""}` },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Release cutter files differ from refreshed origin/main");
      expect(localTagObject(fixture, "v0.0.2")).toBe("");
    },
  );

  it("rejects a noncanonical release remote without the fixture override", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);

    const result = runScript(fixture.work, [
      "bash",
      cutScriptPath,
      "--plan",
      planPath,
      "--message-file",
      writeBrief(fixture),
      "--confirm",
      confirmationFor(plan),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Unexpected origin remote: ${fixture.remote}`);
  });

  it("rejects a noncanonical push URL even when the fetch URL is canonical", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    run(fixture.work, [
      "git",
      "remote",
      "set-url",
      "origin",
      "https://github.com/NVIDIA/NemoClaw.git",
    ]);
    run(fixture.work, ["git", "config", "remote.origin.pushurl", fixture.remote]);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unexpected origin fetch or push URL");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("rejects partial remote tag output when ls-remote exits nonzero", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const mockBin = path.join(fixture.root, "mock-bin");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const previousTagObject = remoteObject(fixture, "refs/tags/v0.0.1");
    fs.mkdirSync(mockBin);
    fs.writeFileSync(
      path.join(mockBin, "git"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        'if [[ "$1" == "ls-remote" && "$2" == "--tags" && "${4:-}" == "refs/tags/v*" ]]; then',
        `  printf '%s\\trefs/tags/v0.0.1\\n' ${shellQuote(previousTagObject)}`,
        `  printf '%s\\trefs/tags/v0.0.1^{}\\n' ${shellQuote(fixture.firstCommit)}`,
        "  exit 74",
        "fi",
        `exec ${shellQuote(realGit)} "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(path.join(mockBin, "git"), 0o755);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), writeBrief(fixture), {
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not read remote semver tags");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("derives confirmation from the plan tag and commit", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);

    const result = cutFromPlan(fixture, planPath, `CONFIRM RELEASE v0.0.3 ${releaseCommit}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Confirmation phrase does not match release tag and commit");
    expect(localTagObject(fixture, plan.nextTag)).toBe("");
  });

  it("requires a nonempty release brief", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const emptyBrief = writeBrief(fixture, "");

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), emptyBrief);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Message file is empty");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it.each([
    [
      "unfinished prompts",
      (brief: string) => brief.replace("Exceptions: None", "Exceptions: TODO_RELEASE_BRIEF"),
      "still contains unresolved prompts",
    ],
    [
      "another version",
      (brief: string) => brief.replace(/^# NemoClaw.*$/mu, "# NemoClaw v0.0.3 release brief"),
      "heading does not match planned tag",
    ],
    [
      "another candidate",
      (brief: string) => brief.replace(/^- Candidate:.*$/mu, `- Candidate: \`${"f".repeat(40)}\``),
      "candidate does not match",
    ],
    [
      "no documentation proceed decision",
      (brief: string) =>
        brief.replace(
          "- Maintainer decision: Proceed with the candidate as shown.",
          "- Maintainer decision: Stop tagging.",
        ),
      "documentation proceed decision",
    ],
    [
      "no exception record",
      (brief: string) => brief.replace("Exceptions: None", "Exceptions removed"),
      "exactly one resolved Exceptions line",
    ],
    [
      "an empty exception record",
      (brief: string) => brief.replace("Exceptions: None", "Exceptions: "),
      "exactly one resolved Exceptions line",
    ],
    [
      "duplicate exception records",
      (brief: string) =>
        brief.replace("Exceptions: None", "Exceptions: None\nExceptions: Duplicate"),
      "exactly one resolved Exceptions line",
    ],
    [
      "content after the exception record",
      (brief: string) => brief.replace("Exceptions: None", "Exceptions: None\n\nTrailing content"),
      "exactly one resolved Exceptions line",
    ],
  ])("rejects a release brief with %s", (_case, mutate, expectedError) => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const invalid = mutate(completeBrief(plan));
    const messageFile = writeBrief(fixture, invalid);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan), messageFile);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(expectedError);
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("keeps a candidate valid when main advances and the worktree has unrelated changes", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    fs.writeFileSync(path.join(fixture.work, "uncommitted.txt"), "unrelated local work\n");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const laterCommit = commit(fixture, "later main commit");

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    expect(remoteCommit(fixture, "refs/heads/main")).toBe(laterCommit);
  });

  it("rejects a candidate that is no longer reachable from origin/main", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    run(fixture.root, [
      "git",
      "--git-dir",
      fixture.remote,
      "update-ref",
      "refs/heads/main",
      fixture.firstCommit,
    ]);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Candidate commit is not reachable from origin/main");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("rejects a candidate that does not follow the previous release", () => {
    const fixture = createFixture();
    const tree = run(fixture.work, ["git", "rev-parse", "HEAD^{tree}"]).trim();
    const orphanRelease = run(fixture.work, [
      "git",
      "commit-tree",
      tree,
      "-m",
      "orphan previous release",
    ]).trim();
    pushTag(fixture, "v0.0.1", orphanRelease);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");

    const result = runScript(
      fixture.work,
      [
        "node",
        "--experimental-strip-types",
        "--no-warnings",
        planScriptPath,
        "--version",
        "v0.0.2",
        "--output",
        planPath,
      ],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not follow previous release v0.0.1");
    expect(fs.existsSync(planPath)).toBe(false);
  });

  it("rejects replacement of the previous tag object at the same peeled commit", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    run(fixture.work, ["git", "tag", "--delete", "v0.0.1"]);
    run(fixture.work, [
      "git",
      "-c",
      "tag.gpgSign=false",
      "tag",
      "-a",
      "v0.0.1",
      fixture.firstCommit,
      "-m",
      "replacement tag object",
    ]);
    run(fixture.work, ["git", "push", "--force", "origin", "refs/tags/v0.0.1"]);
    const replacementObject = remoteObject(fixture, "refs/tags/v0.0.1");
    expect(replacementObject).not.toBe(plan.previousTagObject);
    expect(remoteCommit(fixture, "refs/tags/v0.0.1")).toBe(plan.previousTagCommit);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Remote v0.0.1 object changed from ${plan.previousTagObject} to ${replacementObject}`,
    );
    expect(result.stderr).toContain("protected-tag remediation");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
  });

  it("rejects a plan when an intervening semver tag appears", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit, "v0.0.4");
    pushTag(fixture, "v0.0.2", releaseCommit);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "A semver tag appeared after planning: highest tag changed from v0.0.1 to v0.0.2",
    );
    expect(localTagObject(fixture, "v0.0.4")).toBe("");
  });

  it("rejects a requested tag that appears remotely after planning", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    pushTag(fixture, "v0.0.2", releaseCommit);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Remote tag already exists: v0.0.2");
  });

  it("rejects an existing local requested tag before signing", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    run(fixture.work, ["git", "tag", "v0.0.2", releaseCommit]);

    const result = cutFromPlan(fixture, planPath, confirmationFor(plan));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Local tag v0.0.2 already exists");
    expect(result.stderr).toContain("do not rerun the cutter");
  });
});
