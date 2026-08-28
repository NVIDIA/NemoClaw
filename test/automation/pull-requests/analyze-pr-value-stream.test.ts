// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const analyzer = path.join(
  root,
  ".agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts",
);
const temporaryDirectories: string[] = [];

async function fakeGithub(scenario: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "value-stream-test-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "gh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
const scenario = process.env.VALUE_STREAM_SCENARIO;
const sha = "a".repeat(40);
const pull = {number:42,url:"https://example.test/pr/42",state:"OPEN",isDraft:false,createdAt:"2026-01-01T00:01:00Z",mergedAt:null,headRefName:"topic",headRefOid:sha,commits:[{oid:sha,committedDate:"2026-01-01T00:00:00Z"}],reviews:[]};
const run = (id) => ({id,event:"push",head_sha:sha,created_at:"2026-01-01T00:00:30Z",run_started_at:scenario === "queued" ? null : "2026-01-01T00:00:31Z",updated_at:"2026-01-01T00:03:00Z",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",name:"CI PR #42"});
let value;
if (args.startsWith("pr view") && args.includes("baseRefName")) value = {baseRefName:"main"};
else if (args.startsWith("pr view")) value = pull;
else if (args.includes("required_status_checks")) value = scenario === "wrong-app" ? {contexts:[],checks:[{context:"required-a",app_id:7}]} : {contexts:["required-a", "required-b"],checks:[]};
else if (args.includes("actions/runs?")) value = scenario === "fallback" ? [] : scenario === "truncated" ? [run(11),run(12)] : [run(11)];
else if (args.includes("/actions/runs/11/jobs")) value = {total_count:1,jobs:[{id:21,name:scenario.startsWith("artifact") ? "cli-test-shards (1)" : "job",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",created_at:"2026-01-01T00:00:31Z",started_at:scenario === "queued" ? null : "2026-01-01T00:00:32Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:02:00Z",runner_name:null,runner_group_name:null,labels:[],html_url:"",steps:[{number:1,name:"step",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",started_at:scenario === "queued" ? null : "2026-01-01T00:00:33Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:01:00Z"}]}]};
else if (args.includes("/actions/runs/12/jobs")) value = {total_count:0,jobs:[]};
else if (args.includes("/actions/runs/") && !args.includes("/jobs") && !args.includes("/artifacts")) { const id = Number(args.split("/actions/runs/")[1].split(" ")[0]); value={...run(id),run_attempt:1,html_url:""}; }
else if (args.includes("/artifacts?") && scenario === "artifact-failure") { console.error("Authorization: secret-token"); process.exit(1); }
else if (args.includes("/artifacts?")) value = {total_count:1,artifacts:[{id:31,name:"cli-blob-report-1",size_in_bytes:25000001,expired:false,workflow_run:{id:11,head_sha:sha},workflow_run_id:11,workflow_run_head_sha:sha}]};
else if (args.includes("/check-runs?")) { const checks=[{id:1,name:"required-a",status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:35Z",started_at:"2026-01-01T00:00:45Z",completed_at:"2026-01-01T00:02:30Z",html_url:"",app:{id:scenario === "wrong-app" ? 8 : 7,slug:"actions"}}]; if (scenario !== "incomplete" && scenario !== "wrong-app") checks.push({...checks[0],id:2,name:"required-b",created_at:"2026-01-01T00:00:40Z",completed_at:"2026-01-01T00:02:40Z"}); value=checks; }
else { console.error("unexpected gh call: " + args); process.exit(2); }
process.stdout.write(JSON.stringify(value));
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return directory;
}

async function run(scenario: string, extra: string[] = []) {
  const bin = await fakeGithub(scenario);
  return execa(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      analyzer,
      "--workdir",
      root,
      "--number",
      "42",
      ...extra,
    ],
    {
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        VALUE_STREAM_SCENARIO: scenario,
      },
      reject: false,
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pull request value-stream analysis", () => {
  test("rejects invalid bounded input before invoking GitHub (#10542)", async () => {
    const result = await execa(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", analyzer, "--number", "0"],
      { reject: false },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("number must be a positive integer");
  });

  test("returns a complete bounded report through mocked process boundaries (#10542)", async () => {
    const result = await run("complete", ["--max-test-artifacts", "0"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:40.000Z");
    expect(report.waterfall.runs).toHaveLength(1);
    expect(report.automation.checksConsidered).toBe(2);
    expect(report.automation.firstCheckCreatedAt).toBe("2026-01-01T00:00:35.000Z");
    expect(report.automation.triggerDelaySeconds).toBe(5);
  });

  test("uses commit timestamps when retained workflow runs are absent (#10542)", async () => {
    const report = JSON.parse((await run("fallback", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.firstBranchPush).toMatchObject({
      source: "first commit committedDate fallback",
      confidence: "low",
    });
    expect(report.events.latestRevisionObserved.source).toBe("head commit committedDate fallback");
  });

  test("keeps queued runs jobs and steps with nullable timing fields (#10542)", async () => {
    const report = JSON.parse((await run("queued", ["--max-test-artifacts", "0"])).stdout);
    const queuedRun = report.waterfall.runs[0];
    expect(queuedRun).toMatchObject({ startedAt: null, queueSeconds: null, durationSeconds: null });
    expect(queuedRun.jobs[0]).toMatchObject({
      startedAt: null,
      offsetSeconds: null,
      queueSeconds: null,
      durationSeconds: null,
    });
    expect(queuedRun.jobs[0].steps[0]).toMatchObject({
      startedAt: null,
      offsetSeconds: null,
      durationSeconds: null,
    });
  });

  test("does not settle automation when a required exact-head check is absent (#10542)", async () => {
    const report = JSON.parse((await run("incomplete", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.automationSettled).toBeNull();
    expect(report.caveats).toContain(
      "Automation is not settled because at least one configured required check is absent, pending, or unsuccessful on the exact head.",
    );
  });

  test("does not satisfy an app-bound required check with another GitHub App (#10542)", async () => {
    const report = JSON.parse((await run("wrong-app", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.automationSettled).toBeNull();
    expect(report.automation.checksConsidered).toBe(0);
  });

  test("reports bounded artifact rejection status without exposing diagnostics (#10542)", async () => {
    const report = JSON.parse((await run("artifact")).stdout);
    expect(report.waterfall.runs[0].jobs[0].testRun).toBeNull();
    expect(report.caveats).toContain(
      "Artifact timing was unavailable after a bounded processing attempt was rejected or exhausted.",
    );
  });

  test("reports bounded artifact inventory failure without leaking process diagnostics (#10542)", async () => {
    const report = JSON.parse((await run("artifact-failure")).stdout);
    expect(report.waterfall.runs[0].jobs[0].testRun).toBeNull();
    expect(report.caveats).toContain(
      "Artifact timing inventory was unavailable after the bounded GitHub read attempt failed.",
    );
    expect(JSON.stringify(report)).not.toContain("secret-token");
  });

  test("marks the waterfall truncated at the configured run bound (#10542)", async () => {
    const report = JSON.parse(
      (await run("truncated", ["--max-automation-runs", "1", "--max-test-artifacts", "0"])).stdout,
    );
    expect(report.waterfall).toMatchObject({
      runsAvailable: 2,
      runsIncluded: 1,
      runsTruncated: true,
    });
  });
});
