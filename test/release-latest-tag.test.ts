// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const latestScriptPath = path.join(
  repoRoot,
  "scripts",
  "release-latest-tag.sh",
);
const cutScriptPath = path.join(repoRoot, "scripts", "release-cut-tag.sh");
const waitLatestScriptPath = path.join(
  repoRoot,
  "scripts",
  "release-wait-latest.sh",
);
const planScriptPath = path.join(repoRoot, "scripts", "release-plan.ts");
const tsxPath = path.join(repoRoot, "node_modules", ".bin", "tsx");
const tempRoots: string[] = [];

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Release Test",
    GIT_AUTHOR_EMAIL: "release-test@example.com",
    GIT_COMMITTER_NAME: "Release Test",
    GIT_COMMITTER_EMAIL: "release-test@example.com",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "tag.gpgSign",
    GIT_CONFIG_VALUE_0: "false",
    ...extra,
  };
}

function run(cwd: string, args: string[]): string {
  return execFileSync(args[0], args.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: testEnv(),
  });
}

type Fixture = {
  root: string;
  work: string;
  remote: string;
  summary: string;
  firstCommit: string;
};

function createFixture(): Fixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-release-latest-"),
  );
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

function pushTag(
  fixture: Fixture,
  tag: string,
  target = "HEAD",
  annotated = true,
): void {
  const args = annotated
    ? ["git", "-c", "tag.gpgSign=false", "tag", "-a", tag, target, "-m", tag]
    : ["git", "-c", "tag.gpgSign=false", "tag", tag, target];
  run(fixture.work, args);
  run(fixture.work, ["git", "push", "origin", `refs/tags/${tag}`]);
}

function runReleaseLatest(
  fixture: Fixture,
  releaseTag: string,
): ReturnType<typeof spawnSync> {
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
  return run(fixture.root, [
    "git",
    "--git-dir",
    fixture.remote,
    "rev-parse",
    `${ref}^{}`,
  ]).trim();
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
    expect(fs.readFileSync(fixture.summary, "utf8")).toContain(
      "Not touched: `lkg`",
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
    expect(result.stderr).toContain(
      "is not reachable from refs/remotes/origin/main",
    );
  });

  it("plans, cuts, promotes, and verifies a release from immutable plan data", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit);
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");

    const planResult = runScript(
      fixture.work,
      [tsxPath, planScriptPath, "--bump", "patch", "--output", planPath],
      { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
    );

    expect(planResult.status).toBe(0);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    expect(plan.previousTag).toBe("v0.0.1");
    expect(plan.nextTag).toBe("v0.0.2");
    expect(plan.originMainCommit).toBe(releaseCommit);
    expect(plan.confirmationPhrase).toBe(
      `CONFIRM RELEASE v0.0.2 ${releaseCommit}`,
    );

    const cutResult = runScript(fixture.work, [
      "bash",
      cutScriptPath,
      "--plan",
      planPath,
      "--confirm",
      plan.confirmationPhrase,
    ]);

    expect(cutResult.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, "release", "cut-result.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      tag: "v0.0.2",
      targetCommit: releaseCommit,
      latestTouched: false,
      lkgTouched: false,
    });

    const latestResult = runReleaseLatest(fixture, "v0.0.2");
    expect(latestResult.status).toBe(0);

    const waitResult = runScript(fixture.work, [
      "bash",
      waitLatestScriptPath,
      "--plan",
      planPath,
      "--timeout-secs",
      "1",
      "--interval-secs",
      "1",
    ]);

    expect(waitResult.status).toBe(0);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.root, "release", "latest-result.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      tag: "v0.0.2",
      targetCommit: releaseCommit,
      latestPeeledCommit: releaseCommit,
      lkgPeeledCommitBefore: fixture.firstCommit,
      lkgPeeledCommitAfter: fixture.firstCommit,
    });
  });
});
