// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCanonicalNemoClawRemote } from "../scripts/release/remote.mts";

const repoRoot = path.join(import.meta.dirname, "..");
const latestScriptPath = path.join(repoRoot, "scripts", "release-latest-tag.sh");
const cutScriptPath = path.join(repoRoot, "scripts", "release-cut-tag.sh");
const waitLatestScriptPath = path.join(repoRoot, "scripts", "release-wait-latest.sh");
const planScriptPath = path.join(repoRoot, "scripts", "release-plan.mts");
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

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rewritePlanOrigin(planPath: string, originRemote: string): void {
  const { planHash: _planHash, ...plan } = readJson(planPath);
  const updated = { ...plan, originRemote };
  const nextPlan = {
    ...updated,
    planHash: createHash("sha256")
      .update(JSON.stringify(updated, null, 2))
      .digest("hex"),
  };
  fs.writeFileSync(planPath, `${JSON.stringify(nextPlan, null, 2)}\n`, "utf8");
}

function installReleaseGateStubs(
  fixture: Fixture,
  qualification: "failed-unwaived" | "missing" | "success" | "waived" | "waived-invalid",
  originRemote: string,
  waiverEvidenceJson?: string,
): string {
  const binDir = path.join(fixture.root, `release-gate-bin-${qualification}`);
  fs.mkdirSync(binDir);
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(
    path.join(binDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-} \${3:-}" == "remote get-url origin" ]]; then
  printf '%s\n' ${shellQuote(originRemote)}
  exit 0
fi
if [[ "\${1:-} \${2:-}" == "fetch origin" ]]; then
  exit 0
fi
exec ${shellQuote(realGit)} "$@"
`,
  );
  const waiverDownload =
    qualification === "waived"
      ? waiverEvidenceJson === undefined
        ? `destination="\${!#}"
candidate="$(${shellQuote(realGit)} rev-parse origin/main)"
cat >"\${destination}/waiver.json" <<JSON
{"schemaVersion":1,"kind":"nemoclaw-release-qualification-waiver-v1","candidateSha":"\${candidate}","workflowRunId":123,"workflowRunAttempt":1,"actor":"release-admin","triggeringActor":"release-admin","reason":"Brev credential expired","jobs":[{"id":"staging-brev-launchable","result":"failure"}]}
JSON`
        : `destination="\${!#}"
printf '%s\n' ${shellQuote(waiverEvidenceJson)} >"\${destination}/waiver.json"`
      : "exit 1";
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'/actions/workflows/e2e.yaml/runs?'*)
    ${qualification === "missing" ? ":" : `printf '%s\\t%s\\t%s\\t%s\\n' 123 https://github.com/NVIDIA/NemoClaw/actions/runs/123 ${qualification.startsWith("waived") || qualification === "failed-unwaived" ? "failure" : "success"} 1`}
    ;;
  *'/actions/runs/123/jobs?'*)
    printf '%s\\t%s\\t%s\\n' completed ${qualification === "waived-invalid" ? "failure" : "success"} https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/456
    ;;
  'run download 123 --repo NVIDIA/NemoClaw --name release-qualification-waiver-123-1 --dir '*)
    ${waiverDownload}
    ;;
  *) exit 2 ;;
esac
`,
  );
  fs.chmodSync(path.join(binDir, "git"), 0o755);
  fs.chmodSync(path.join(binDir, "gh"), 0o755);
  return binDir;
}

type WaiverEvidence = {
  schemaVersion: number;
  kind: string;
  candidateSha: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  actor: string;
  triggeringActor: string;
  reason: string;
  jobs: Array<{ id: string; result: string }>;
};

function validWaiverEvidence(candidateSha: string): WaiverEvidence {
  return {
    schemaVersion: 1,
    kind: "nemoclaw-release-qualification-waiver-v1",
    candidateSha,
    workflowRunId: 123,
    workflowRunAttempt: 1,
    actor: "release-admin",
    triggeringActor: "release-admin",
    reason: "Brev credential expired",
    jobs: [{ id: "staging-brev-launchable", result: "failure" }],
  };
}

const INVALID_WAIVER_EVIDENCE_CASES: Array<
  [string, (evidence: WaiverEvidence) => Record<string, unknown>]
> = [
  ["schema version", (evidence) => ({ ...evidence, schemaVersion: 2 })],
  ["kind", (evidence) => ({ ...evidence, kind: "untrusted-waiver" })],
  ["candidate commit", (evidence) => ({ ...evidence, candidateSha: "0".repeat(40) })],
  ["workflow run ID", (evidence) => ({ ...evidence, workflowRunId: 124 })],
  ["workflow run attempt", (evidence) => ({ ...evidence, workflowRunAttempt: 2 })],
  ["dispatch actor", (evidence) => ({ ...evidence, actor: "-invalid" })],
  ["triggering actor", (evidence) => ({ ...evidence, triggeringActor: "invalid-" })],
  ["reason", (evidence) => ({ ...evidence, reason: "short" })],
  ["jobs type", (evidence) => ({ ...evidence, jobs: "not-an-array" })],
  ["empty jobs", (evidence) => ({ ...evidence, jobs: [] })],
  [
    "duplicate job IDs",
    (evidence) => ({
      ...evidence,
      jobs: [evidence.jobs[0], { ...evidence.jobs[0], result: "success" }],
    }),
  ],
  [
    "job ID",
    (evidence) => ({ ...evidence, jobs: [{ id: "Invalid Job", result: "failure" }] }),
  ],
  [
    "job result",
    (evidence) => ({
      ...evidence,
      jobs: [{ id: "staging-brev-launchable", result: "cancelled" }],
    }),
  ],
  [
    "failed-job presence",
    (evidence) => ({
      ...evidence,
      jobs: [{ id: "staging-brev-launchable", result: "success" }],
    }),
  ],
];

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
  expect(plan.operations).toContain(`create signed annotated v0.0.2 tag at ${releaseCommit}`);
  const carryForward = "have release-latest-tag workflow carry open v0.0.2 items forward to v0.0.3";
  const deleteReleased =
    "have release-latest-tag workflow delete released v0.0.2 label after carry-forward succeeds";
  const carryForwardIndex = plan.operations.indexOf(carryForward);
  const deleteReleasedIndex = plan.operations.indexOf(deleteReleased);
  expect(carryForwardIndex).toBeGreaterThanOrEqual(0);
  expect(deleteReleasedIndex).toBeGreaterThan(carryForwardIndex);
  expect(plan.confirmationPhrase).toBe(`CONFIRM RELEASE v0.0.2 ${releaseCommit}`);
  return { plan, result };
}

function cutFromPlan(
  fixture: Fixture,
  planPath: string,
  confirmationPhrase: string,
): ReturnType<typeof spawnSync> {
  return runScript(
    fixture.work,
    ["bash", cutScriptPath, "--plan", planPath, "--confirm", confirmationPhrase],
    { NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1" },
  );
}

function preflightFromPlan(fixture: Fixture, planPath: string): ReturnType<typeof spawnSync> {
  return runScript(fixture.work, ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"], {
    NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1",
  });
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
  it.each([
    "git@github.com:NVIDIA/NemoClaw",
    "git@github.com:NVIDIA/NemoClaw.git",
    "https://github.com/NVIDIA/NemoClaw",
    "https://contributor@github.com/NVIDIA/NemoClaw.git",
    "ssh://git@github.com/NVIDIA/NemoClaw.git",
  ])("recognizes canonical NemoClaw origin form %s", (remote) => {
    expect(isCanonicalNemoClawRemote(remote)).toBe(true);
  });

  it.each([
    "/tmp/NVIDIA/NemoClaw",
    "https://example.com/NVIDIA/NemoClaw.git",
    "https://github.com/NVIDIA/another-repo.git",
  ])("rejects noncanonical NemoClaw origin form %s", (remote) => {
    expect(isCanonicalNemoClawRemote(remote)).toBe(false);
  });

  it("advertises that release cuts create signed annotated tags", () => {
    const result = runScript(repoRoot, ["bash", cutScriptPath, "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("signed annotated semver tag");
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

  it("plans, cuts, promotes, and verifies a release from immutable plan data", () => {
    const fixture = createFixture();
    pushTag(fixture, "lkg", fixture.firstCommit);
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);

    const preflightResult = preflightFromPlan(fixture, planPath);

    expect(preflightResult.status).toBe(0);
    expect(preflightResult.stdout).toContain("signing preflight passed for v0.0.2");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
    expect(
      run(fixture.work, ["git", "tag", "--list", "nemoclaw-release-signing-preflight-*"]),
    ).toBe("");
    expect(
      run(fixture.work, [
        "git",
        "ls-remote",
        "--tags",
        "origin",
        "v0.0.2",
        "nemoclaw-release-signing-preflight-*",
      ]),
    ).toBe("");

    const cutResult = cutFromPlan(fixture, planPath, plan.confirmationPhrase);

    expect(cutResult.status).toBe(0);
    expect(remoteCommit(fixture, "refs/tags/v0.0.2")).toBe(releaseCommit);
    const releaseTagObject = remoteObject(fixture, "refs/tags/v0.0.2");
    expect(
      run(fixture.root, ["git", "--git-dir", fixture.remote, "cat-file", "-p", releaseTagObject]),
    ).toContain("-----BEGIN SSH SIGNATURE-----");
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
      semverTagObject: releaseTagObject,
      latestTagObject: releaseTagObject,
      latestPeeledCommit: releaseCommit,
      lkgPeeledCommitBefore: fixture.firstCommit,
      lkgPeeledCommitAfter: fixture.firstCommit,
    });
  });

  it("rejects signing preflight when the configured signer is unavailable", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    run(fixture.work, ["git", "config", "gpg.format", "openpgp"]);
    run(fixture.work, [
      "git",
      "config",
      "gpg.program",
      path.join(fixture.root, "missing-release-signer"),
    ]);
    run(fixture.work, ["git", "config", "user.signingkey", "missing-release-key"]);

    const preflightResult = preflightFromPlan(fixture, planPath);

    expect(preflightResult.status).not.toBe(0);
    expect(preflightResult.stderr).toContain("missing-release-signer");
    expect(localTagObject(fixture, "v0.0.2")).toBe("");
    expect(
      run(fixture.work, ["git", "tag", "--list", "nemoclaw-release-signing-preflight-*"]),
    ).toBe("");
  });

  it("requires exact-commit Release qualification before signing preflight", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const originRemote = "git@github.com:NVIDIA/NemoClaw";
    rewritePlanOrigin(planPath, originRemote);
    const binDir = installReleaseGateStubs(fixture, "success", originRemote);

    const result = runScript(
      fixture.work,
      ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`verified Release qualification for ${releaseCommit}`);
    expect(result.stdout).toContain(
      "qualification evidence: https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/456",
    );
  });

  it("accepts a failed workflow with successful qualification and trusted failed-job waiver evidence", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const originRemote = "git@github.com:NVIDIA/NemoClaw";
    rewritePlanOrigin(planPath, originRemote);
    const binDir = installReleaseGateStubs(fixture, "waived", originRemote);

    const result = runScript(
      fixture.work,
      ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`verified Release qualification for ${releaseCommit}`);
    expect(result.stdout).toContain(
      "workflow evidence: https://github.com/NVIDIA/NemoClaw/actions/runs/123 (conclusion: failure)",
    );
  });

  it.each(INVALID_WAIVER_EVIDENCE_CASES)(
    "rejects a failed workflow whose waiver artifact has an invalid %s",
    (_field, invalidEvidence) => {
      const fixture = createFixture();
      pushTag(fixture, "v0.0.1", fixture.firstCommit);
      const releaseCommit = commit(fixture, "planned release commit");
      const planPath = path.join(fixture.root, "release", "plan.json");
      createPlan(fixture, planPath, releaseCommit);
      const originRemote = "git@github.com:NVIDIA/NemoClaw";
      rewritePlanOrigin(planPath, originRemote);
      const evidence = invalidEvidence(validWaiverEvidence(releaseCommit));
      const binDir = installReleaseGateStubs(
        fixture,
        "waived",
        originRemote,
        JSON.stringify(evidence),
      );

      const result = runScript(
        fixture.work,
        ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `No completed successful Release qualification check exists for candidate commit ${releaseCommit}`,
      );
    },
  );

  it("rejects a failed workflow run when Release qualification also fails", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const originRemote = "git@github.com:NVIDIA/NemoClaw";
    rewritePlanOrigin(planPath, originRemote);
    const binDir = installReleaseGateStubs(fixture, "waived-invalid", originRemote);

    const result = runScript(
      fixture.work,
      ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `No completed successful Release qualification check exists for candidate commit ${releaseCommit}`,
    );
  });

  it("rejects a failed unwaived workflow when Release qualification succeeds", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const originRemote = "git@github.com:NVIDIA/NemoClaw";
    rewritePlanOrigin(planPath, originRemote);
    const binDir = installReleaseGateStubs(fixture, "failed-unwaived", originRemote);

    const result = runScript(
      fixture.work,
      ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `No completed successful Release qualification check exists for candidate commit ${releaseCommit}`,
    );
  });

  it.each(["git@github.com:NVIDIA/NemoClaw", "https://contributor@github.com/NVIDIA/NemoClaw.git"])(
    "rejects signing preflight without exact-commit qualification for %s",
    (originRemote) => {
      const fixture = createFixture();
      pushTag(fixture, "v0.0.1", fixture.firstCommit);
      const releaseCommit = commit(fixture, "planned release commit");
      const planPath = path.join(fixture.root, "release", "plan.json");
      createPlan(fixture, planPath, releaseCommit);
      rewritePlanOrigin(planPath, originRemote);
      const binDir = installReleaseGateStubs(fixture, "missing", originRemote);

      const result = runScript(
        fixture.work,
        ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
        { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `No completed successful Release qualification check exists for candidate commit ${releaseCommit}`,
      );
      expect(localTagObject(fixture, "v0.0.2")).toBe("");
    },
  );

  it("does not let the noncanonical test override bypass a canonical remote", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    createPlan(fixture, planPath, releaseCommit);
    const originRemote = "https://contributor@github.com/NVIDIA/NemoClaw.git";
    rewritePlanOrigin(planPath, originRemote);
    const binDir = installReleaseGateStubs(fixture, "missing", originRemote);

    const result = runScript(
      fixture.work,
      ["bash", cutScriptPath, "--plan", planPath, "--preflight-only"],
      {
        NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `No completed successful Release qualification check exists for candidate commit ${releaseCommit}`,
    );
    expect(result.stdout).not.toContain("skipped GitHub qualification");
  });

  it("rejects a distinct latest tag object even when it peels to the release commit", () => {
    const fixture = createFixture();
    pushTag(fixture, "v0.0.1", fixture.firstCommit);
    const releaseCommit = commit(fixture, "planned release commit");
    const planPath = path.join(fixture.root, "release", "plan.json");
    const { plan } = createPlan(fixture, planPath, releaseCommit);
    expect(cutFromPlan(fixture, planPath, plan.confirmationPhrase).status).toBe(0);
    pushTag(fixture, "latest", releaseCommit);

    const waitResult = waitForLatest(fixture, planPath);

    expect(waitResult.status).not.toBe(0);
    expect(waitResult.stderr).toContain("latest tag object");
    expect(waitResult.stderr).toContain("does not match v0.0.2 object");
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
        path.join(repoRoot, "scripts", "release-notes-data.mts"),
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
        path.join(repoRoot, "scripts", "release-notes-data.mts"),
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
