// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveCheckpoint, type Checkpoint } from "../../tools/task-continuation/checkpoint.mts";

const roots: string[] = [];
const guide = readFileSync(
  resolve(".agents/skills/nemoclaw-maintainer-e2e/references/manual-pr.md"),
  "utf8",
).replace(/\r\n/g, "\n");
const blocks = [...guide.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]!);
function blockContaining(text: string) {
  const block = blocks.find((value) => value.includes(text));
  if (!block) throw new Error(`Missing executable procedure: ${text}`);
  return block;
}
const functions = blockContaining("save_dispatch_intent()");
const candidate = blockContaining('TASK_RECORD="${TASK_RECORD:');
const headResult = blockContaining('HEAD_RUN_ID="$RUN_ID"');
const base = blockContaining('BASE_CORRELATION_ID="$(python3');
const baseResult = blockContaining('BASE_RUN_ID="$RUN_ID"');

export function manualPrDispatchFixture(baseTargets = "sandbox-operations") {
  const root = mkdtempSync(join(tmpdir(), "manual-pr-checkpoint-"));
  roots.push(root);
  const file = join(root, "state.json");
  const service = join(root, "runs.json");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state: Checkpoint = {
    version: 1,
    revision: 0,
    owner: "fixture-owner",
    objective: "Exercise dispatch recovery",
    scope: "Fake GitHub only",
    authorization: "One candidate and one exact-base comparison in the fake service",
    identities: { pr: "NVIDIA/NemoClaw#123" },
    nextAction: "Dispatch the fixture",
    operations: [],
    evidence: [],
    limits: { "candidate-dispatch": 1, "base-comparison": 1 },
    budgetIdentities: {
      "candidate-dispatch": {
        candidate: "a".repeat(40),
        workflow: "c".repeat(40),
        failureClass: "initial",
      },
      "base-comparison": {
        candidate: "b".repeat(40),
        workflow: "c".repeat(40),
        failureClass: "comparison",
      },
    },
  };
  const authorized = {
    prNumber: "123",
    baseSha: "b".repeat(40),
    workflowSha: "c".repeat(40),
    repository: "NVIDIA/NemoClaw",
    jobs: "",
    targets: "sandbox-operations",
    cleanupOwner: state.owner,
    cleanupObligation: "Remove fixture-owned resources",
    costBounds: "Fake service; no external cost",
    inferenceMode: "mock",
    allowJetsonDispatch: false,
    includeStagingBrevLaunchable: false,
  };
  state.identities["manualE2E.authorization.candidate-dispatch"] = JSON.stringify({
    ...authorized,
    phase: "candidate",
    checkoutSha: "a".repeat(40),
    budgetKey: "candidate-dispatch",
  });
  state.identities["manualE2E.authorization.base-comparison"] = JSON.stringify({
    ...authorized,
    phase: "base",
    targets: baseTargets,
    checkoutSha: "b".repeat(40),
    budgetKey: "base-comparison",
  });
  saveCheckpoint(file, state, -1, state.owner);
  writeFileSync(service, "[]");
  const fake = join(root, "gh.mjs");
  writeFileSync(
    fake,
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readCheckpoint } from ${JSON.stringify(resolve("tools/task-continuation/checkpoint.mts"))};
const args = process.argv.slice(2);
const env = process.env;
const runs = JSON.parse(fs.readFileSync(env.FAKE_RUNS, 'utf8'));
if (args[0] === 'workflow' && args[1] === 'run') {
  fs.appendFileSync(env.FAKE_DISPATCHES, 'attempt\\n');
  const fields = Object.fromEntries(args.flatMap((value, index) => {
    if (value !== '-f') return [];
    const field = args[index + 1]; const split = field.indexOf('=');
    return [[field.slice(0, split), field.slice(split + 1)]];
  }));
  const checkpoint = readCheckpoint(env.TASK_RECORD);
  const operation = checkpoint.operations.find(entry => entry.id === fields.correlation_id);
  assert.ok(operation, 'dispatch must have persisted intent');
  assert.equal(operation.state, 'pending');
  const context = JSON.parse(operation.action);
  assert.equal(context.checkoutSha, fields.checkout_sha);
  assert.equal(context.repository, fields.checkout_repository);
  assert.equal(context.baseSha, fields.base_sha);
  assert.equal(context.workflowSha, fields.workflow_sha);
  assert.equal(context.jobs, fields.jobs);
  assert.equal(context.targets, fields.targets);
  assert.equal(String(context.allowJetsonDispatch), fields.allow_jetson_dispatch);
  assert.equal(String(context.includeStagingBrevLaunchable), fields.include_staging_brev_launchable);
  assert.equal(context.inferenceMode, fields.inference_mode);
  assert.equal(context.budgetKey, operation.budget);
  assert.equal(context.correlationId, fields.correlation_id);
  assert.equal(context.cleanupOwner, env.E2E_CLEANUP_OWNER);
  assert.equal(context.cleanupObligation, env.E2E_CLEANUP_OBLIGATION);
  const databaseId = 100 + runs.length;
  runs.push({ databaseId, displayTitle: 'E2E PR #' + fields.pr_number + ' (' + fields.correlation_id + ')',
    head_sha: fields.workflow_sha, run_attempt: 1, status: 'completed',
    conclusion: context.phase === 'candidate' ? 'failure' : 'success',
    html_url: 'https://github.com/NVIDIA/NemoClaw/actions/runs/' + databaseId });
  fs.writeFileSync(env.FAKE_RUNS, JSON.stringify(runs));
} else if (args[0] === 'run' && args[1] === 'list') {
  console.log(JSON.stringify(runs));
} else if (args[0] === 'run' && args[1] === 'watch') {
  if (args[2] === env.FAKE_STALL_WATCH_RUN) {
    fs.writeFileSync(env.FAKE_WATCH_STARTED, args[2]);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  process.exitCode = runs.find(run => String(run.databaseId) === args[2]).conclusion === 'failure' ? 1 : 0;
} else if (args[0] === 'api' && args[1].includes('/pulls/')) {
  console.log(JSON.stringify({ state: 'open', number: 123,
    head: { sha: env.HEAD_SHA, repo: { full_name: env.HEAD_REPOSITORY,
      owner: { login: env.HEAD_OWNER, type: env.HEAD_OWNER_TYPE } } },
    base: { sha: env.BASE_SHA, ref: 'main', repo: { full_name: env.BASE_REPOSITORY } } }));
} else if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
  const id = args[1].split('/').at(-1);
  const run = runs.find(run => String(run.databaseId) === id);
  assert.ok(run); console.log(JSON.stringify(run));
} else { throw Error('Unexpected fake GitHub request: ' + JSON.stringify(args)); }
`,
  );
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nexec node "$FAKE_GH_SCRIPT" "$@"\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_GH_SCRIPT: fake,
    FAKE_RUNS: service,
    FAKE_DISPATCHES: join(root, "dispatch-attempts"),
    FAKE_WATCH_STARTED: join(root, "watch-started"),
    FAKE_STALL_WATCH_RUN: "",
    E2E_WATCH_TIMEOUT_SECONDS: "5",
    TASK_RECORD: file,
    TASK_OWNER: state.owner,
    PR_NUMBER: "123",
    HEAD_SHA: "a".repeat(40),
    BASE_SHA: "b".repeat(40),
    WORKFLOW_SHA: "c".repeat(40),
    HEAD_REPOSITORY: "NVIDIA/NemoClaw",
    BASE_REPOSITORY: "NVIDIA/NemoClaw",
    HEAD_OWNER: "NVIDIA",
    HEAD_OWNER_TYPE: "Organization",
    E2E_JOBS: "",
    E2E_TARGETS: "sandbox-operations",
    ALLOW_JETSON_DISPATCH: "false",
    INCLUDE_STAGING_BREV_LAUNCHABLE: "false",
    E2E_CANDIDATE_BUDGET: "candidate-dispatch",
    E2E_BASE_BUDGET: "base-comparison",
    E2E_CLEANUP_OWNER: state.owner,
    E2E_CLEANUP_OBLIGATION: "Remove fixture-owned resources",
    E2E_COST_BOUNDS: "Fake service; no external cost",
  };
  const execute = (body: string) =>
    spawnSync("bash", ["-c", body], {
      cwd: resolve("."),
      env,
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
    });
  const run = (body: string) => execute(`${functions}\n${body}`);
  const runWithoutFunctions = (body: string) => execute(`set +e\nset +u\n${body}`);
  return { file, service, state, env, run, runWithoutFunctions };
}
export const manualPrProcedures = { candidate, headResult, base, baseResult };
export function cleanupManualPrDispatchFixtures() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
