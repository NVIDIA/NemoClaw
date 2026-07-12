// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const latestScriptPath = path.join(repoRoot, "scripts", "release-latest-tag.sh");
const cutScriptPath = path.join(repoRoot, "scripts", "release-cut-tag.sh");
const waitLatestScriptPath = path.join(repoRoot, "scripts", "release-wait-latest.sh");
const planScriptPath = path.join(repoRoot, "scripts", "release-plan.ts");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const tempRoots: string[] = [];

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
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
    if (options.allowFailure) {
      return "";
    }
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

  run(root, ["git", "init", "--bare", remote]);
  fs.mkdirSync(work);
  run(work, ["git", "init"]);
  run(work, ["git", "config", "user.name", "Release Test"]);
  run(work, ["git", "config", "user.email", "release-test@example.com"]);
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

function runReleaseLatest(fixture: Fixture, releaseTag: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [latestScriptPath], {
    cwd: fixture.work,
    encoding: "utf8",
    env: testEnv({
      RELEASE_TAG: releaseTag,
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

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createPlan(
  fixture: Fixture,
  planPath: string,
  releaseCommit: string,
): { plan: any; result: ReturnType<typeof spawnSync> } {
  const result = runScript(
    fixture.work,
    [tsxPath, planScriptPath, "--bump", "patch", "--output", planPath],
    { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
  );

  expect(result.status).toBe(0);
  const plan = readJson(planPath);
  expect(plan.previousTag).toBe("v0.0.1");
  expect(plan.nextTag).toBe("v0.0.2");
  expect(plan.originMainCommit).toBe(releaseCommit);
  expect(plan.confirmationPhrase).toBe(`CONFIRM RELEASE v0.0.2 ${releaseCommit}`);
  return { plan, result };
}

function cutFromPlan(
  fixture: Fixture,
  planPath: string,
  confirmationPhrase: string,
): ReturnType<typeof spawnSync> {
  return runScript(fixture.work, [
    "bash",
    cutScriptPath,
    "--plan",
    planPath,
    "--confirm",
    confirmationPhrase,
  ]);
}

function waitForLatest(fixture: Fixture, planPath: string): ReturnType<typeof spawnSync> {
  return runScript(fixture.work, [
    "bash",
    waitLatestScriptPath,
    "--plan",
    planPath,
    "--timeout-secs",
    "1",
    "--interval-secs",
    "1",
  ]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("release-latest-tag.sh", () => {
  it("promotes latest to the newest annotated semver tag without touching lkg", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit);
    const releaseCommit = commit(fixture, "release commit");
    pushTag(fixture, "v0.0.1");

    const result = runReleaseLatest(fixture, "v0.0.1");

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(releaseCommit);
    expect(remoteCommit(fixture, "refs/tags/lkg")).toBe(fixture.firstCommit);
    expect(fs.readFileSync(fixture.summary, "utf8")).toContain("Not touched: `lkg`");
  });

  it("configures a bot identity when promoting latest on a runner without git identity", () => {
    const fixture = createFixture();
    const releaseCommit = commit(fixture, "release commit");
    pushTag(fixture, "v0.0.1");
    run(fixture.work, ["git", "config", "--unset", "user.name"]);
    run(fixture.work, ["git", "config", "--unset", "user.email"]);

    const result = runReleaseLatestWithoutIdentity(fixture, "v0.0.1");

    expect(result.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/latest")).toBe(releaseCommit);
    expect(run(fixture.work, ["git", "config", "--local", "user.name"]).trim()).toBe(
      "github-actions[bot]",
    );
    expect(run(fixture.work, ["git", "config", "--local", "user.email"]).trim()).toBe(
      "41898282+github-actions[bot]@users.noreply.github.com",
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

  it("plans, cuts, promotes, and verifies a release from immutable plan data", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit);
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);

    const cutResult = cutFromPlan(fixture, planPath, plan.confirmationPhrase);

    expect(cutResult.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    expect(readJson(path.join(fixture.root, "release", "cut-result.json"))).toMatchObject({
      tag: "v0.0.2",
      targetCommit: releaseCommit,
      latestTouched: false,
      lkgTouched: false,
    });

    const latestResult = runReleaseLatest(fixture, "v0.0.2");
    expect(latestResult.status).toBe(0);

    const waitResult = waitForLatest(fixture, planPath);

    expect(waitResult.status).toBe(0);
    expect(readJson(path.join(fixture.root, "release", "latest-result.json"))).toMatchObject({
      tag: "v0.0.2",
      targetCommit: releaseCommit,
      latestPeeledCommit: releaseCommit,
      lkgPeeledCommitBefore: fixture.firstCommit,
      lkgPeeledCommitAfter: fixture.firstCommit,
    });
  });

  it("rejects a tampered release plan before cutting the tag", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    const tampered = { ...plan, forbiddenOperations: [] };
    fs.writeFileSync(planPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    const cutResult = cutFromPlan(fixture, planPath, plan.confirmationPhrase);

    expect(cutResult.status).not.toBe(0);
    expect(cutResult.stderr).toContain("planHash mismatch");
  });

  it("verifies unchanged lightweight lkg tags", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit, false);
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    expect(plan.lkgBefore).toMatchObject({
      objectSha: fixture.firstCommit,
      tag: "lkg",
    });
    expect(plan.lkgBefore.peeledSha).toBeUndefined();
    expect(cutFromPlan(fixture, planPath, plan.confirmationPhrase).status).toBe(0);
    expect(runReleaseLatest(fixture, "v0.0.2").status).toBe(0);

    const waitResult = waitForLatest(fixture, planPath);

    expect(waitResult.status).toBe(0);
    expect(readJson(path.join(fixture.root, "release", "latest-result.json"))).toMatchObject({
      tag: "v0.0.2",
      targetCommit: releaseCommit,
      lkgPeeledCommitBefore: fixture.firstCommit,
      lkgPeeledCommitAfter: fixture.firstCommit,
    });
  });

  it("detects lkg creation after a plan captured lkg as absent", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    expect(plan.lkgBefore).toBeNull();
    expect(cutFromPlan(fixture, planPath, plan.confirmationPhrase).status).toBe(0);
    expect(runReleaseLatest(fixture, "v0.0.2").status).toBe(0);
    pushTag(fixture, "lkg", fixture.firstCommit);

    const waitResult = waitForLatest(fixture, planPath);

    expect(waitResult.status).not.toBe(0);
    expect(waitResult.stderr).toContain("lkg was created after the release plan was generated");
  });

  it("extracts only squash-merge PR numbers from release notes compare commits", () => {
    const fixture = createFixture();
    const binDir = path.join(fixture.root, "bin");
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  printf '%s\n' '{"commits":[{"commit":{"message":"fix: use issue ref (#123) (#456)"}},{"commit":{"message":"docs: closes #789 (#987)"}},{"commit":{"message":"Merge pull request #654 from branch"}}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"number":%s,"title":"pr %s"}\n' "$3" "$3"
  exit 0
fi
exit 2
`,
      "utf8",
    );
    fs.chmodSync(ghPath, 0o755);
    const planPath = path.join(fixture.root, "release", "plan.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mode: "tag-only",
          previousTag: "v0.0.1",
          nextTag: "v0.0.2",
          originMainCommit: "0123456789abcdef0123456789abcdef01234567",
          planHash: "a".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const outputPath = path.join(fixture.root, "release", "notes-data.json");

    const result = runScript(
      fixture.work,
      [
        tsxPath,
        path.join(repoRoot, "scripts", "release-notes-data.ts"),
        "--plan",
        planPath,
        "--output",
        outputPath,
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.status).toBe(0);
    const data = readJson(outputPath);
    expect(data).toMatchObject({ status: "ok", prNumbers: [456, 654, 987] });
    expect(data.pullRequests).toEqual([
      { number: 456, title: "pr 456" },
      { number: 654, title: "pr 654" },
      { number: 987, title: "pr 987" },
    ]);
  });

  it("marks release notes data as partial when a PR metadata lookup fails", () => {
    const fixture = createFixture();
    const binDir = path.join(fixture.root, "bin");
    fs.mkdirSync(binDir);
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  printf '%s\n' '{"commits":[{"commit":{"message":"feat: one (#1)"}},{"commit":{"message":"fix: two (#2)"}}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "1" ]; then
  printf '%s\n' '{"number":1,"title":"one"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "2" ]; then
  echo 'missing PR' >&2
  exit 1
fi
exit 2
`,
      "utf8",
    );
    fs.chmodSync(ghPath, 0o755);
    const planPath = path.join(fixture.root, "release", "plan.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mode: "tag-only",
          previousTag: "v0.0.1",
          nextTag: "v0.0.2",
          originMainCommit: "0123456789abcdef0123456789abcdef01234567",
          planHash: "a".repeat(64),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const outputPath = path.join(fixture.root, "release", "notes-data.json");

    const result = runScript(
      fixture.work,
      [
        tsxPath,
        path.join(repoRoot, "scripts", "release-notes-data.ts"),
        "--plan",
        planPath,
        "--output",
        outputPath,
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.status).toBe(0);
    const data = readJson(outputPath);
    expect(data).toMatchObject({ status: "partial", prNumbers: [1, 2] });
    expect(data.pullRequests).toEqual([{ number: 1, title: "one" }]);
    expect(data.pullRequestWarnings[0]).toMatchObject({ number: 2 });
  });
});
