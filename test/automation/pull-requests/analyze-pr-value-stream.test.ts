// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";

import { cleanupArtifactDirectory } from "../../../.agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/analyze-pr-value-stream.mts";
import {
  cleanupLifetimeStaging,
  publishStagedDirectory,
  reclaimStalePublicationLock,
  validateChromeTrace,
} from "../../../.agents/skills/nemoclaw-maintainer-analyze-pr-value-stream/scripts/export-pr-lifetime-trace.mts";

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
const laterSha = "b".repeat(40);
const responseCommits = [{oid:sha,authoredDate:"2026-01-01T00:00:00Z",committedDate:"2026-01-01T00:00:00Z",messageHeadline:"change"},{oid:laterSha,authoredDate:"2026-01-01T00:00:10Z",committedDate:"2026-01-01T00:01:30Z",messageHeadline:"response"}];
const pull = {number:42,url:"https://example.test/pr/42",state:scenario.startsWith("approval-") ? "MERGED" : "OPEN",isDraft:false,createdAt:"2026-01-01T00:01:00Z",updatedAt:"2026-01-01T00:04:00Z",mergedAt:scenario.startsWith("approval-") ? "2026-01-01T00:04:00Z" : null,author:{login:"author"},assignees:[],baseRefName:"main",headRefName:"topic",headRefOid:scenario === "feedback-response" ? laterSha : sha,commits:scenario === "feedback-response" ? responseCommits : [responseCommits[0]],reviews};
const run = (id) => ({id,event:"push",head_sha:sha,created_at:"2026-01-01T00:00:30Z",run_started_at:scenario === "queued" ? null : "2026-01-01T00:00:31Z",updated_at:"2026-01-01T00:03:00Z",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",name:"CI PR #42"});
let value;
if (args.startsWith("pr view")) { const calls=fs.readFileSync(process.env.VALUE_STREAM_LOG,"utf8").match(/^pr view /gmu).length; value = (scenario === "head-race" && calls > 1) || (scenario === "final-head-race" && calls > 1) ? {...pull,headRefOid:"b".repeat(40)} : pull; }
else if (args.includes("required_status_checks")) value = scenario === "wrong-app" || scenario === "app-status-denied" ? {contexts:[],checks:[{context:"required-a",app_id:7}]} : scenario === "any-app" || scenario === "early-check" ? {contexts:[],checks:[{context:"required-a",app_id:-1}]} : scenario.startsWith("legacy-") ? {contexts:["legacy-required"],checks:[]} : {contexts:["required-a", "required-b"],checks:[]};
else if (args.includes("issues/42/timeline")) value = [{id:41,event:"assigned",created_at:"2026-01-01T00:01:05Z",actor:"author",commit_id:null,label:null,requested_reviewer:null,requested_team:null,rename:null},{id:44,event:"review_requested",created_at:"2026-01-01T00:01:15Z",actor:"author",commit_id:null,label:null,requested_reviewer:"reviewer",requested_team:null,rename:null},{id:46,event:"review_requested",created_at:"2026-01-01T00:01:25Z",actor:"author",commit_id:null,label:null,requested_reviewer:null,requested_team:"maintainers",rename:null},{id:45,event:"review_request_removed",created_at:"2026-01-01T00:01:45Z",actor:"author",commit_id:null,label:null,requested_reviewer:"reviewer",requested_team:null,rename:null},{id:47,event:"review_request_removed",created_at:"2026-01-01T00:01:55Z",actor:"author",commit_id:null,label:null,requested_reviewer:null,requested_team:"maintainers",rename:null}];
else if (args.includes("issues/42/comments")) value = [{id:42,created_at:"2026-01-01T00:01:10Z",updated_at:"2026-01-01T00:01:10Z",user:"reviewer",html_url:""}];
else if (args.includes("pulls/42/comments")) value = [{id:43,created_at:"2026-01-01T00:01:20Z",updated_at:"2026-01-01T00:01:20Z",user:"reviewer",path:"src/example.ts",line:1,commit_id:sha,html_url:"",in_reply_to_id:null}];
else if (args.includes("actions/runs?")) value = scenario === "fallback" ? [] : scenario === "truncated" ? [run(11),run(12)] : [run(11)];
else if (args.includes("/actions/runs/11/jobs")) value = {total_count:1,jobs:[{id:21,name:scenario.startsWith("artifact") ? "cli-test-shards (1)" : "job",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",created_at:"2026-01-01T00:00:31Z",started_at:scenario === "queued" ? null : "2026-01-01T00:00:32Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:02:00Z",runner_name:null,runner_group_name:null,labels:[],html_url:"",steps:[{number:1,name:"step",status:scenario === "queued" ? "queued" : "completed",conclusion:scenario === "queued" ? null : "success",started_at:scenario === "queued" ? null : "2026-01-01T00:00:33Z",completed_at:scenario === "queued" ? null : "2026-01-01T00:01:00Z"}]}]};
else if (args.includes("/actions/runs/12/jobs")) value = {total_count:0,jobs:[]};
else if (args.includes("/actions/runs/") && !args.includes("/jobs") && !args.includes("/artifacts")) { const id = Number(args.split("/actions/runs/")[1].split(" ")[0]); value={...run(id),run_attempt:1,html_url:""}; }
else if (args.includes("/artifacts?") && scenario === "artifact-failure") { console.error("Authorization: secret-token"); process.exit(1); }
else if (args.includes("/artifacts?")) value = {total_count:1,artifacts:[{id:31,name:"cli-blob-report-1",size_in_bytes:Number(process.env.VALUE_STREAM_ARTIFACT_SIZE),expired:false,workflow_run:{id:11,head_sha:sha},workflow_run_id:11,workflow_run_head_sha:sha}]};
else if (args.includes("/actions/artifacts/31/zip")) { if (scenario === "artifact-cancel") setInterval(() => {}, 1000); else { process.stdout.write(fs.readFileSync(process.env.VALUE_STREAM_ARTIFACT)); process.exit(0); } }
else if (args.includes("/check-runs?")) { const checks=scenario.startsWith("legacy-") ? [] : [{id:1,name:"required-a",status:"completed",conclusion:"success",created_at:"2026-01-01T00:00:35Z",started_at:"2026-01-01T00:00:45Z",completed_at:scenario === "early-check" ? "2026-01-01T00:00:20Z" : "2026-01-01T00:02:30Z",html_url:"",app:{id:scenario === "wrong-app" ? 8 : 7,slug:"actions"}}]; if (scenario === "duplicate-checks" && args.includes("filter=all")) checks.push({...checks[0],id:3,created_at:"2026-01-01T00:00:30Z"}); if (scenario !== "incomplete" && scenario !== "wrong-app" && scenario !== "any-app" && scenario !== "app-status-denied" && scenario !== "early-check" && !scenario.startsWith("legacy-")) checks.push({...checks[0],id:2,name:"required-b",created_at:"2026-01-01T00:00:40Z",completed_at:"2026-01-01T00:02:40Z"}); value=checks; }
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
      fake.directory,
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
  return Object.assign(result, {
    directory: fake.directory,
    ghCalls: await readFile(fake.logPath, "utf8"),
  });
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
    const result = await run("complete");
    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:40.000Z");
    expect(report.waterfall.runs).toHaveLength(1);
    expect(report.automation.checksConsidered).toBe(2);
    expect(report.automation.firstCheckCreatedAt).toBe("2026-01-01T00:00:35.000Z");
    expect(report.automation.triggerDelaySeconds).toBe(5);
    expect(report.lifetime).toMatchObject({
      revisions: 1,
      workflowRuns: 1,
      jobs: 1,
      truncated: false,
    });
    const summaryPath = path.resolve(result.directory, report.lifetime.summary);
    const tracePath = path.resolve(result.directory, report.lifetime.trace);
    const manifestPath = path.resolve(result.directory, report.lifetime.manifest);
    expect(JSON.parse(await readFile(summaryPath, "utf8"))).toEqual(report);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    expect(trace.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Pull request opened for review", ph: "i" }),
        expect.objectContaining({
          name: "Waiting for latest revision",
          cat: "pr.readiness",
          ph: "X",
        }),
        expect.objectContaining({
          name: "Current revision ordinal",
          cat: "pr.counter",
          ph: "C",
          args: { value: 1 },
        }),
        expect.objectContaining({
          name: "Open review requests",
          cat: "pr.counter",
          ph: "C",
          args: { value: 1 },
        }),
        expect.objectContaining({ name: "job", cat: "ci.queue", ph: "X" }),
        expect.objectContaining({ name: "job", cat: "ci.execution", ph: "X" }),
        expect.objectContaining({ name: "step", cat: "ci.step", ph: "X" }),
        expect.objectContaining({ name: "Inline feedback added", cat: "review.feedback" }),
        expect.objectContaining({
          name: "Review requested: user:reviewer",
          cat: "review.request",
          ph: "X",
          dur: 30_000_000,
          args: expect.objectContaining({ terminalState: "removed" }),
        }),
        expect.objectContaining({
          name: "Revision 1 current",
          cat: "pr.revision-epoch",
          ph: "X",
          args: expect.objectContaining({ ordinal: 1, current: true }),
        }),
      ]),
    );
    expect(
      trace.traceEvents.every(
        (event: { ts?: number; dur?: number }) =>
          (event.ts === undefined || Number.isSafeInteger(event.ts)) &&
          (event.dur === undefined || (Number.isSafeInteger(event.dur) && event.dur >= 0)),
      ),
    ).toBe(true);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      repository: "NVIDIA/NemoClaw",
      pullRequest: 42,
      headSha: "a".repeat(40),
      completeness: { workflowRuns: "complete", jobs: "complete", lifecycle: "complete" },
    });
  });

  test("removes lifetime artifacts when the pull request head changes (#10542)", async () => {
    const result = await run("head-race");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pull request head changed during lifetime analysis");
    await expect(
      stat(path.join(result.directory, ".nemoclaw-maintainer/pr-value-stream/pr-42")),
    ).rejects.toThrow();
  });

  test("does not replace artifacts when the head changes before publication (#10542)", async () => {
    const result = await run("final-head-race");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pull request head changed during lifetime analysis");
    await expect(
      stat(path.join(result.directory, ".nemoclaw-maintainer/pr-value-stream/pr-42")),
    ).rejects.toThrow();
  });

  test("uses commit timestamps when retained workflow runs are absent (#10542)", async () => {
    const report = JSON.parse((await run("fallback")).stdout);
    expect(report.events.firstBranchPush).toMatchObject({
      source: "first commit committedDate fallback",
      confidence: "low",
    });
    expect(report.events.latestRevisionObserved.source).toBe("head commit committedDate fallback");
  });

  test("links feedback to the next author change (#10542)", async () => {
    const result = await run("feedback-response");
    const report = JSON.parse(result.stdout);
    const trace = JSON.parse(
      await readFile(path.resolve(result.directory, report.lifetime.trace), "utf8"),
    );
    expect(trace.traceEvents).toContainEqual(
      expect.objectContaining({
        name: "Feedback to next author change",
        cat: "author.response",
        ts: Date.parse("2026-01-01T00:01:20Z") * 1_000,
        dur: 10_000_000,
        args: expect.objectContaining({ feedbackId: 43, nextCommit: "b".repeat(40) }),
      }),
    );
  });

  test("keeps queued runs jobs and steps with nullable timing fields (#10542)", async () => {
    const report = JSON.parse((await run("queued")).stdout);
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

  test("retains every external check attempt with the same name (#10542)", async () => {
    const result = await run("duplicate-checks");
    const report = JSON.parse(result.stdout);
    expect(report.lifetime.externalChecks).toBe(3);
    const trace = JSON.parse(
      await readFile(path.join(result.directory, report.lifetime.trace), "utf8"),
    );
    expect(
      trace.traceEvents.filter(
        (event: { cat?: string; name?: string }) =>
          event.cat === "ci.external-check" && event.name === "required-a",
      ),
    ).toHaveLength(2);
  });

  test("does not settle automation when a required exact-head check is absent (#10542)", async () => {
    const report = JSON.parse((await run("incomplete")).stdout);
    expect(report.events.automationSettled).toBeNull();
    expect(report.caveats).toContain(
      "Automation is not settled because at least one configured required check is absent, pending, or unsuccessful on the exact head.",
    );
  });

  test("does not satisfy an app-bound required check with another GitHub App (#10542)", async () => {
    const report = JSON.parse((await run("wrong-app")).stdout);
    expect(report.events.automationSettled).toBeNull();
    expect(report.automation.checksConsidered).toBe(0);
  });

  test("accepts any provider for an unrestricted required check (#10542)", async () => {
    const report = JSON.parse((await run("any-app")).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:30.000Z");
    expect(report.automation.checksConsidered).toBe(1);
  });

  test("settles automation from an earlier exact-commit check run (#10542)", async () => {
    const report = JSON.parse((await run("early-check")).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
  });

  test("settles automation from an earlier exact-commit legacy status (#10542)", async () => {
    const report = JSON.parse((await run("legacy-status")).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
    expect(report.automation.firstCheckCreatedAt).toBe("2026-01-01T00:00:04.000Z");
  });

  test("skips legacy status permission when app-bound checks are sufficient (#10542)", async () => {
    const report = JSON.parse((await run("app-status-denied")).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:02:30.000Z");
  });

  test("finds a required legacy status on the second bounded page (#10542)", async () => {
    const report = JSON.parse((await run("legacy-paginated")).stdout);
    expect(report.events.automationSettled).toBe("2026-01-01T00:00:20.000Z");
  });

  test("uses the restored final-head approval after a later change request (#10542)", async () => {
    const report = JSON.parse((await run("approval-restored")).stdout);
    expect(report.events.firstFinalHeadApproval).toBe("2026-01-01T00:03:15.000Z");
    expect(report.elapsed.approvalDelaySeconds).toBe(35);
    expect(report.elapsed.mergeLagAfterReadySeconds).toBe(45);
  });

  test("omits a final-head approval superseded by a change request (#10542)", async () => {
    const report = JSON.parse((await run("approval-revoked")).stdout);
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

  test("publishes each concurrent lifetime artifact set without mixing files (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-publish-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const first = path.join(publicationRoot, "first");
    const second = path.join(publicationRoot, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all(
      [first, second].flatMap((directory, index) =>
        ["summary.json", "trace.json", "manifest.json"].map((file) =>
          writeFile(path.join(directory, file), String(index)),
        ),
      ),
    );
    await Promise.all([
      publishStagedDirectory({ staging: first, destination, lock: destination + ".lock" }),
      publishStagedDirectory({ staging: second, destination, lock: destination + ".lock" }),
    ]);
    const manifest = await readFile(path.join(destination, "manifest.json"), "utf8");
    await expect(readFile(path.join(destination, "summary.json"), "utf8")).resolves.toBe(manifest);
    await expect(readFile(path.join(destination, "trace.json"), "utf8")).resolves.toBe(manifest);
    expect(
      (await readdir(publicationRoot)).filter((entry) => entry.includes(".lock.candidate-")),
    ).toEqual([]);
  });

  test("restores a completed lifetime artifact set when staged publication fails (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-restore-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    await mkdir(destination);
    await Promise.all(
      ["summary.json", "trace.json", "manifest.json"].map((file) =>
        writeFile(path.join(destination, file), "complete"),
      ),
    );
    await expect(
      publishStagedDirectory({
        staging: path.join(publicationRoot, "missing-staging"),
        destination,
        lock: destination + ".lock",
      }),
    ).rejects.toThrow();
    await expect(readFile(path.join(destination, "summary.json"), "utf8")).resolves.toBe(
      "complete",
    );
    await expect(readFile(path.join(destination, "trace.json"), "utf8")).resolves.toBe("complete");
    await expect(readFile(path.join(destination, "manifest.json"), "utf8")).resolves.toBe(
      "complete",
    );
  });

  test("restores an interrupted backup when replacement publication fails (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-recover-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const backup = path.join(publicationRoot, ".pr-42-staging-interrupted-previous");
    const staging = path.join(publicationRoot, "missing-replacement");
    await mkdir(backup);
    await writeFile(path.join(backup, "manifest.json"), "prior");
    await expect(
      publishStagedDirectory({ staging, destination, lock: destination + ".lock" }),
    ).rejects.toThrow();
    await expect(readFile(path.join(destination, "manifest.json"), "utf8")).resolves.toBe("prior");
    await expect(stat(backup)).rejects.toThrow();
  });

  test("reports non-destructive recovery for multiple interrupted backups (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-multiple-backups-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const first = path.join(publicationRoot, ".pr-42-staging-first-previous");
    const second = path.join(publicationRoot, ".pr-42-staging-second-previous");
    await Promise.all([mkdir(first), mkdir(second)]);
    await expect(
      publishStagedDirectory({
        staging: path.join(publicationRoot, "missing"),
        destination,
        lock: destination + ".lock",
      }),
    ).rejects.toThrow(
      `for each candidate, verify summary.json and trace.json exist and match the byte sizes in manifest.json; then rename exactly one verified candidate to the destination without deleting the others: ${first}, ${second}`,
    );
    await expect(Promise.all([stat(first), stat(second)])).resolves.toHaveLength(2);
  });

  test("preserves published artifacts when freshness validation fails (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-contention-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const staging = path.join(publicationRoot, "staging");
    const lock = destination + ".lock";
    await Promise.all([mkdir(destination), mkdir(staging)]);
    await Promise.all([
      writeFile(path.join(destination, "manifest.json"), "current"),
      writeFile(path.join(staging, "manifest.json"), "stale"),
    ]);
    const publication = publishStagedDirectory({
      staging,
      destination,
      lock,
      validate: async () => {
        throw new Error("pull request head changed during lifetime analysis");
      },
    });
    await expect(publication).rejects.toThrow("pull request head changed during lifetime analysis");
    await expect(readFile(path.join(destination, "manifest.json"), "utf8")).resolves.toBe(
      "current",
    );
  });

  test("does not reclaim a lock while its publisher is alive (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-fence-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const first = path.join(publicationRoot, "first");
    const second = path.join(publicationRoot, "second");
    const lock = destination + ".lock";
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all([
      writeFile(path.join(first, "manifest.json"), "first"),
      writeFile(path.join(second, "manifest.json"), "second"),
    ]);
    let resumeFirst!: () => void;
    let firstOwnsLock!: () => void;
    const firstEnteredValidation = new Promise<void>((resolve) => {
      firstOwnsLock = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });
    vi.useFakeTimers();
    const firstPublication = publishStagedDirectory({
      staging: first,
      destination,
      lock,
      validate: () => {
        firstOwnsLock();
        return firstBlocked;
      },
    });
    await firstEnteredValidation;
    expect(await reclaimStalePublicationLock(lock, Date.now() + 6 * 60 * 1_000)).toBe(false);
    const heartbeatBefore = (await stat(lock)).mtimeMs;
    await vi.advanceTimersByTimeAsync(2 * 60 * 1_000);
    vi.useRealTimers();
    await vi.waitUntil(async () => (await stat(lock)).mtimeMs > heartbeatBefore);
    expect((await stat(lock)).mtimeMs).toBeGreaterThan(heartbeatBefore);
    resumeFirst();
    await firstPublication;
    await publishStagedDirectory({ staging: second, destination, lock });
    await expect(readFile(path.join(destination, "manifest.json"), "utf8")).resolves.toBe("second");
  });

  test("reclaims stale unpublished lock candidates (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-candidate-"));
    temporaryDirectories.push(publicationRoot);
    const destination = path.join(publicationRoot, "pr-42");
    const lock = destination + ".lock";
    const candidate = lock + ".candidate-abandoned";
    const staging = path.join(publicationRoot, "staging");
    await mkdir(candidate);
    await mkdir(staging);
    await writeFile(path.join(staging, "manifest.json"), "complete");
    const stale = new Date(Date.now() - 6 * 60 * 1_000);
    await utimes(candidate, stale, stale);
    await publishStagedDirectory({ staging, destination, lock });
    await expect(stat(candidate)).rejects.toThrow();
  });

  test("reclaims stale publication locks but preserves active locks (#10542)", async () => {
    const publicationRoot = await mkdtemp(path.join(tmpdir(), "value-stream-lock-"));
    temporaryDirectories.push(publicationRoot);
    const lock = path.join(publicationRoot, "pr-42.lock");
    await mkdir(lock);
    const liveStart = await readFile("/proc/" + process.pid + "/stat", "utf8");
    const liveIdentity = liveStart
      .slice(liveStart.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u)[19];
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startIdentity: liveIdentity }),
    );
    expect(await reclaimStalePublicationLock(lock)).toBe(false);
    const stale = new Date(Date.now() - 6 * 60 * 1_000);
    await utimes(lock, stale, stale);
    expect(await reclaimStalePublicationLock(lock)).toBe(false);
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
    expect(await reclaimStalePublicationLock(lock)).toBe(false);
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startIdentity: "reused-owner" }),
    );
    expect(await reclaimStalePublicationLock(lock)).toBe(true);
    await mkdir(lock);
    await utimes(lock, stale, stale);
    expect(await reclaimStalePublicationLock(lock)).toBe(true);
    await expect(stat(lock)).rejects.toThrow();
  });

  test("reports retained staging path without hiding publication failure (#10542)", async () => {
    const staging = "/tmp/value-stream-retained-staging";
    const remove = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(
      cleanupLifetimeStaging(staging, new Error("publication failed"), remove),
    ).rejects.toThrow(
      "publication failed; failed to remove retained lifetime staging directory " + staging,
    );
  });

  test("accepts a valid synthetic Chrome trace (#10542)", async () => {
    const trace = path.join(
      await mkdtemp(path.join(tmpdir(), "value-stream-trace-")),
      "trace.json",
    );
    temporaryDirectories.push(path.dirname(trace));
    await writeFile(
      trace,
      JSON.stringify({
        traceEvents: [{ name: "valid", ph: "X", ts: 1, dur: 2, pid: 1, tid: 1, args: {} }],
      }),
    );
    await expect(validateChromeTrace(trace)).resolves.toEqual({ events: 1, tracks: 1 });
  });

  test("rejects an unsupported Chrome trace phase (#10542)", async () => {
    const trace = path.join(
      await mkdtemp(path.join(tmpdir(), "value-stream-trace-")),
      "trace.json",
    );
    temporaryDirectories.push(path.dirname(trace));
    await writeFile(
      trace,
      JSON.stringify({
        traceEvents: [{ name: "invalid", ph: "s", ts: 1, pid: 1, tid: 1, args: {} }],
      }),
    );
    await expect(validateChromeTrace(trace)).rejects.toThrow("unsupported Chrome trace phase");
  });

  test("rejects crossing complete Chrome trace events (#10542)", async () => {
    const trace = path.join(
      await mkdtemp(path.join(tmpdir(), "value-stream-trace-")),
      "trace.json",
    );
    temporaryDirectories.push(path.dirname(trace));
    await writeFile(
      trace,
      JSON.stringify({
        traceEvents: [
          { name: "outer", ph: "X", ts: 1, dur: 5, pid: 1, tid: 1, args: {} },
          { name: "crossing", ph: "X", ts: 3, dur: 5, pid: 1, tid: 1, args: {} },
        ],
      }),
    );
    await expect(validateChromeTrace(trace)).rejects.toThrow("crossing complete events");
  });

  test("rejects removed user-controlled truncation options before GitHub access (#10542)", async () => {
    const result = await run("complete", ["--max-automation-runs", "1"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown argument: --max-automation-runs");
    expect(result.ghCalls).toBe("");
  });
});
