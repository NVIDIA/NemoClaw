// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";

import { cleanupArtifactDirectory } from "../../../.agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts";

const root = path.resolve(import.meta.dirname, "../../..");
const analyzer = path.join(
  root,
  ".agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts",
);
const temporaryDirectories: string[] = [];

async function fakeGithub(scenario: string): Promise<{
  directory: string;
  logPath: string;
  artifactPath: string | null;
  artifactSize: number;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "value-stream-test-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "gh.log");
  await writeFile(logPath, "");
  let artifactPath: string | null = null;
  let artifactSize = 25_000_001;
  switch (scenario) {
    case "artifact-cancel":
      artifactSize = 1;
      break;
    case "artifact-success": {
      const fixtureDirectory = path.join(directory, "fixture");
      await execa("mkdir", ["-p", fixtureDirectory]);
      await writeFile(
        path.join(fixtureDirectory, "sample.test.ts"),
        'import { expect, test } from "vitest"; test("sample", () => expect(1).toBe(1));\n',
      );
      await writeFile(
        path.join(fixtureDirectory, "vitest.config.mjs"),
        'export default { test: { include: ["sample.test.ts"] } };\n',
      );
      const blobPath = path.join(fixtureDirectory, "blob-sample.json");
      await execa(process.execPath, [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        fixtureDirectory,
        "--config",
        path.join(fixtureDirectory, "vitest.config.mjs"),
        "--reporter=blob",
        "--outputFile=" + blobPath,
      ]);
      artifactPath = path.join(directory, "artifact.zip");
      await execa("zip", ["-j", artifactPath, blobPath]);
      artifactSize = (await stat(artifactPath)).size;
      break;
    }
    default:
      break;
  }
  const executable = path.join(directory, "gh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(process.env.VALUE_STREAM_LOG, args + "\\n");
const scenario = process.env.VALUE_STREAM_SCENARIO;
const sha = "a".repeat(40);
const review = (state,time) => ({state,submittedAt:time,author:{login:"reviewer"},commit:{oid:sha}});
const reviews = scenario === "approval-restored" ? [review("APPROVED","2026-01-01T00:02:45Z"),review("CHANGES_REQUESTED","2026-01-01T00:03:00Z"),review("APPROVED","2026-01-01T00:03:15Z")] : scenario === "approval-revoked" ? [review("APPROVED","2026-01-01T00:02:45Z"),review("CHANGES_REQUESTED","2026-01-01T00:03:00Z")] : [];
const pull = {number:42,url:"https://example.test/pr/42",state:scenario.startsWith("approval-") ? "MERGED" : "OPEN",isDraft:false,createdAt:"2026-01-01T00:01:00Z",mergedAt:scenario.startsWith("approval-") ? "2026-01-01T00:04:00Z" : null,baseRefName:"main",headRefName:"topic",headRefOid:sha,commits:[{oid:sha,committedDate:"2026-01-01T00:00:00Z"}],reviews};
const run = (id) => ({id,event:"push",head_sha:sha,created_at:"2026-01-01T00:00:30Z",run_started_at:scenario === "queued" ? null : "2026-01-01T00:00:31Z",updated_at:"2026-01-01T00:03:00Z",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",name:"CI PR #42"});
let value;
if (args.startsWith("pr view")) value = pull;
else if (args.includes("required_status_checks")) value = scenario === "wrong-app" || scenario === "app-status-denied" ? {contexts:[],checks:[{context:"required-a",app_id:7}]} : scenario === "any-app" || scenario === "early-check" ? {contexts:[],checks:[{context:"required-a",app_id:-1}]} : scenario.startsWith("legacy-") ? {contexts:["legacy-required"],checks:[]} : {contexts:["required-a", "required-b"],checks:[]};
else if (args.includes("actions/runs?")) value = scenario === "fallback" ? [] : scenario === "truncated" ? [run(11),run(12)] : [run(11)];
else if (args.includes("/actions/runs/11/jobs")) value = {total_count:1,jobs:[{id:21,name:scenario.startsWith("artifact") ? "cli-test-shards (1)" : "job",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",created_at:"2026-01-01T00:00:31Z",started_at:scenario === "queued" ? null : "2026-01-01T00:00:32Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:02:00Z",runner_name:null,runner_group_name:null,labels:[],html_url:"",steps:[{number:1,name:"step",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",started_at:scenario === "queued" ? null : "2026-01-01T00:00:33Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:01:00Z"}]}]};
else if (args.includes("/actions/runs/12/jobs")) value = {total_count:0,jobs:[]};
else if (args.includes("/actions/runs/") && !args.includes("/jobs") && !args.includes("/artifacts")) { const id = Number(args.split("/actions/runs/")[1].split(" ")[0]); value={...run(id),run_attempt:1,html_url:""}; }
else if (args.includes("/artifacts?") && scenario === "artifact-failure") { console.error("Authorization: secret-token"); process.exit(1); }
else if (args.includes("/artifacts?")) value = {total_count:1,artifacts:[{id:31,name:"cli-blob-report-1",size_in_bytes:Number(process.env.VALUE_STREAM_ARTIFACT_SIZE),expired:false,workflow_run:{id:11,head_sha:sha},workflow_run_id:11,workflow_run_head_sha:sha}]};
else if (args.includes("/actions/artifacts/31/zip")) { if (scenario === "artifact-cancel") setInterval(() => {}, 1000); else { process.stdout.write(fs.readFileSync(process.env.VALUE_STREAM_ARTIFACT)); process.exit(0); } }
else if (args.includes("/check-runs?")) { const checks=scenario.startsWith("legacy-") ? [] : [{id:1,name:"required-a",status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:35Z",started_at:"2026-01-01T00:00:45Z",completed_at:scenario === "early-check" ? "2026-01-01T00:00:20Z" : "2026-01-01T00:02:30Z",html_url:"",app:{id:scenario === "wrong-app" ? 8 : 7,slug:"actions"}}]; if (scenario !== "incomplete" && scenario !== "wrong-app" && scenario !== "any-app" && scenario !== "app-status-denied" && scenario !== "early-check" && !scenario.startsWith("legacy-")) checks.push({...checks[0],id:2,name:"required-b",created_at:"2026-01-01T00:00:40Z",completed_at:"2026-01-01T00:02:40Z"}); value=checks; }
else if (args.includes("/status?")) {
  if (scenario === "app-status-denied") { console.error("Commit statuses forbidden"); process.exit(1); }
  const page = Number(new URL("https://example.test/?" + args.split("?")[1].split(" ")[0]).searchParams.get("page"));
  if (scenario === "legacy-paginated" && page === 1) value = Array.from({length:100},(_,index)=>({id:index,context:"other-"+index,state:"success",created_at:"2026-01-01T00:00:01Z",updated_at:"2026-01-01T00:00:02Z",target_url:""}));
  else if (scenario === "legacy-paginated" && page === 2) value = [{id:103,context:"legacy-required",state:"success",created_at:"2026-01-01T00:00:03Z",updated_at:"2026-01-01T00:00:20Z",target_url:""}];
  else value = [{id:3,context:"legacy-required",state:"success",created_at:"2026-01-01T00:00:04Z",updated_at:"2026-01-01T00:00:20Z",target_url:""}];
}
else { console.error("unexpected gh call: " + args); process.exit(2); }
process.stdout.write(JSON.stringify(value));
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { directory, logPath, artifactPath, artifactSize };
}

async function run(scenario: string, extra: string[] = []) {
  const fake = await fakeGithub(scenario);
  const cleanupRoot = null;
  const result = await execa(
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
        PATH: fake.directory + path.delimiter + process.env.PATH,
        TMPDIR: cleanupRoot ?? process.env.TMPDIR,
        VALUE_STREAM_SCENARIO: scenario,
        VALUE_STREAM_LOG: fake.logPath,
        VALUE_STREAM_ARTIFACT: fake.artifactPath ?? "",
        VALUE_STREAM_ARTIFACT_SIZE: String(fake.artifactSize),
      },
      reject: false,
    },
  );
  return Object.assign(result, { ghCalls: await readFile(fake.logPath, "utf8") });
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
    const fake = await fakeGithub("complete");
    const result = await execa(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", analyzer, "--number", "0"],
      {
        env: {
          ...process.env,
          PATH: fake.directory + path.delimiter + process.env.PATH,
          VALUE_STREAM_LOG: fake.logPath,
        },
        reject: false,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("number must be a positive integer");
    await expect(readFile(fake.logPath, "utf8")).resolves.toBe("");
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
    expect(result.ghCalls.match(/^pr view /gmu)).toHaveLength(1);
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

  test("accepts any provider for an unrestricted required check (#10542)", async () => {
    const report = JSON.parse((await run("any-app", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:30.000Z");
    expect(report.automation.checksConsidered).toBe(1);
  });

  test("settles automation from an earlier exact-commit check run (#10542)", async () => {
    const report = JSON.parse((await run("early-check", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
  });

  test("settles automation from an earlier exact-commit legacy status (#10542)", async () => {
    const report = JSON.parse((await run("legacy-status", ["--max-test-artifacts", "0"])).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
    expect(report.automation.firstCheckCreatedAt).toBe("2026-01-01T00:00:04.000Z");
  });

  test("skips legacy status permission when app-bound checks are sufficient (#10542)", async () => {
    const report = JSON.parse(
      (await run("app-status-denied", ["--max-test-artifacts", "0"])).stdout,
    );
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:30.000Z");
  });

  test("finds a required legacy status on the second bounded page (#10542)", async () => {
    const report = JSON.parse(
      (await run("legacy-paginated", ["--max-test-artifacts", "0"])).stdout,
    );
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
  });

  test("uses the restored final-head approval after a later change request (#10542)", async () => {
    const report = JSON.parse(
      (await run("approval-restored", ["--max-test-artifacts", "0"])).stdout,
    );
    expect(report.events.firstFinalHeadApproval).toBe("2026-01-01T00:03:15.000Z");
    expect(report.elapsed.approvalDelaySeconds).toBe(35);
    expect(report.elapsed.mergeLagAfterReadySeconds).toBe(45);
  });

  test("omits a final-head approval superseded by a change request (#10542)", async () => {
    const report = JSON.parse(
      (await run("approval-revoked", ["--max-test-artifacts", "0"])).stdout,
    );
    expect(report.events.firstFinalHeadApproval).toBeNull();
    expect(report.elapsed.approvalDelaySeconds).toBeNull();
  });

  test("reports accepted artifact timing from an isolated merge directory (#10542)", async () => {
    const result = await run("artifact-success");
    expect(result.exitCode, result.stderr).toBe(0);
    const testRun = JSON.parse(result.stdout).waterfall.runs[0].jobs[0].testRun;
    expect(testRun).toMatchObject({
      artifact: "cli-blob-report-1",
      tests: 1,
      timedTests: 1,
      files: 1,
    });
    expect(testRun.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(testRun.slowTests).toHaveLength(1);
  });

  test("removes the artifact directory when analysis is terminated (#10542)", async () => {
    const fake = await fakeGithub("artifact-cancel");
    const cancellationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-cancellation-"));
    temporaryDirectories.push(cancellationRoot);
    const processResult = execa(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        analyzer,
        "--workdir",
        root,
        "--number",
        "42",
      ],
      {
        env: {
          ...process.env,
          PATH: fake.directory + path.delimiter + process.env.PATH,
          TMPDIR: cancellationRoot,
          VALUE_STREAM_SCENARIO: "artifact-cancel",
          VALUE_STREAM_LOG: fake.logPath,
          VALUE_STREAM_ARTIFACT: "",
          VALUE_STREAM_ARTIFACT_SIZE: "1",
        },
        reject: false,
      },
    );
    await vi.waitUntil(
      async () => (await readFile(fake.logPath, "utf8")).includes("/actions/artifacts/31/zip"),
      { timeout: 10_000, interval: 20 },
    );
    processResult.kill("SIGTERM");
    const result = await processResult;
    expect(result.signal).toBe("SIGTERM");
    await expect(readdir(cancellationRoot)).resolves.toEqual([]);
  });

  test("reports retained artifact directory when cleanup fails (#10542)", async () => {
    const removeDirectory = vi.fn(async () => {
      throw new Error("cleanup denied");
    });
    await expect(cleanupArtifactDirectory("/tmp/retained-artifact", removeDirectory)).resolves.toBe(
      "Artifact temporary-directory cleanup failed. Remove /tmp/retained-artifact before retrying.",
    );
    expect(removeDirectory).toHaveBeenCalledWith("/tmp/retained-artifact");
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
