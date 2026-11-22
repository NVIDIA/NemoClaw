// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { selectedEnvironment } from "./managed-image-receipt-fixture.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildRiskSignal } from "../../../tools/e2e/risk-signal.ts";
import {
  sparkVllmQualificationReceipt,
  validateSparkVllmWorkflowBoundary,
} from "../../../tools/e2e/spark-vllm-qualification.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";

const target = "spark-vllm-extra-arguments";
const candidate = "a".repeat(40);
const imageRevision = "b".repeat(40);
const workflowSha = "c".repeat(40);
const correlationId = "11111111-2222-4333-8444-555555555555";
const boundedCommand =
  "vllm serve nvidia/Qwen3.6-35B-A3B-NVFP4 --max-model-len 32768 --max-num-seqs 1 --max-num-batched-tokens 4096 --gpu-memory-utilization 0.5 --load-format safetensors --safetensors-load-strategy lazy --max-num-seqs 2";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "spark-proof-"));
  roots.push(directory);
  const scenario = path.join(directory, "scenario");
  mkdirSync(scenario);
  const artifacts = new ArtifactSink(scenario);
  await artifacts.target.declare({
    id: target,
    scenario: "extra-arguments",
    presetId: "vllm.dgx-spark-gb10.single-64gb.qwen3-6-35b-a3b-nvfp4",
    sandboxName: "e2e-spark-vllm",
  });
  await artifacts.target.complete({ id: target, scenario: "extra-arguments" });
  await artifacts.writeJson("cleanup.json", {
    passed: ["remove nemoclaw-vllm", "remove sandbox e2e-spark-vllm"],
    failures: [],
  });
  await artifacts.writeJson("shell/spark-extra-arguments-physical-memory.result.json", {
    exitCode: 0,
    stdout: "63082733568\n",
  });
  await artifacts.writeJson("shell/spark-express-vllm-container-inspect.result.json", {
    exitCode: 0,
    stdout: JSON.stringify([{ Id: "d".repeat(64), Config: { Cmd: ["-lc", boundedCommand] } }]),
  });
  const signal = buildRiskSignal(
    {
      artifactDir: directory,
      jobId: target,
      shardId: "default",
      expectedSha: candidate,
      testedSha: candidate,
      correlationId,
    },
    { passed: 1, failed: 0, skipped: 0, pending: 0, unhandledErrors: 0, runReason: "passed" },
  );
  writeFileSync(path.join(directory, "risk-signal.json"), JSON.stringify(signal));
  const env = {
    NEMOCLAW_E2E_EXPECTED_SHA: candidate,
    E2E_MANAGED_IMAGE_REVISION: imageRevision,
    SPARK_VLLM_WORKFLOW_SHA: workflowSha,
    NEMOCLAW_E2E_CORRELATION_ID: correlationId,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    E2E_MANAGED_IMAGE_COHORT_RECEIPT: selectedEnvironment(
      directory,
    ).E2E_MANAGED_IMAGE_COHORT_RECEIPT!.replaceAll("d".repeat(40), imageRevision),
  };
  return { directory, scenario, artifacts, signal, env };
}

it("consumes actual target-writer and risk-reporter artifacts with independent run and image identities", async () => {
  const { directory, env } = await fixture();
  const receipt = sparkVllmQualificationReceipt(directory, env);
  expect(receipt).toMatchObject({
    kind: "nemoclaw-spark-vllm-qualification-v1",
    candidateSha: candidate,
    managedImageRevision: imageRevision,
    workflowSha,
    runId: "123",
    runAttempt: "2",
    correlationId,
    memoryBytes: 63082733568,
    containerId: "d".repeat(64),
    cleanup: { failures: [] },
    result: { status: "passed" },
  });
});

it("writes the canonical qualification file through the workflow CLI entrypoint", async () => {
  const { directory, env } = await fixture();
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "tools/e2e/spark-vllm-qualification.mts"],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, ...env, E2E_ARTIFACT_DIR: directory },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(
    JSON.parse(readFileSync(path.join(directory, "spark-vllm-qualification.json"), "utf8")),
  ).toMatchObject({ candidateSha: candidate, runId: "123", memoryBytes: 63082733568 });
});

it.each([
  [1, "63082733568"],
  [0, " "],
  [0, "59999999999"],
  [0, "64000000000"],
  [0, "6.1e10"],
])("rejects an unsuccessful or out-of-tier memory probe (%s, %s)", async (exitCode, stdout) => {
  const { artifacts, directory, env } = await fixture();
  await artifacts.writeJson("shell/spark-extra-arguments-physical-memory.result.json", {
    exitCode,
    stdout,
  });
  expect(() => sparkVllmQualificationReceipt(directory, env)).toThrow(/memory/);
});

it.each([
  boundedCommand.replace("32768", "262144"),
  boundedCommand.replace(" --max-num-seqs 2", ""),
  boundedCommand + " --max-num-seqs 1",
])(
  "rejects an inspected command that loses the bounded recipe or final override",
  async (command) => {
    const { artifacts, directory, env } = await fixture();
    await artifacts.writeJson("shell/spark-express-vllm-container-inspect.result.json", {
      exitCode: 0,
      stdout: JSON.stringify([{ Id: "d".repeat(64), Config: { Cmd: ["-lc", command] } }]),
    });
    expect(() => sparkVllmQualificationReceipt(directory, env)).toThrow(/command/);
  },
);

type Proof = Awaited<ReturnType<typeof fixture>>;
it.each<[string, (proof: Proof) => void | Promise<unknown>]>([
  [
    "stale candidate",
    ({ env }) => {
      env.NEMOCLAW_E2E_EXPECTED_SHA = "e".repeat(40);
    },
  ],
  [
    "skipped",
    ({ signal }) => {
      signal.passed = 0;
      signal.skipped = 1;
    },
  ],
  [
    "failed",
    ({ signal }) => {
      signal.failed = 1;
      signal.runReason = "failed";
    },
  ],
  [
    "wrong image",
    ({ env }) => {
      env.E2E_MANAGED_IMAGE_REVISION = "e".repeat(40);
    },
  ],
  [
    "missing cleanup",
    ({ scenario }) => {
      rmSync(path.join(scenario, "cleanup.json"));
    },
  ],
  [
    "failed cleanup",
    ({ artifacts }) =>
      artifacts.writeJson("cleanup.json", {
        passed: [],
        failures: [{ name: "remove nemoclaw-vllm", message: "permission denied" }],
      }),
  ],
  [
    "wrong scenario",
    ({ artifacts }) =>
      artifacts.target.complete({ id: "dgx-station-express", scenario: "station" }),
  ],
  [
    "missing inspection",
    ({ scenario }) => {
      rmSync(path.join(scenario, "shell/spark-express-vllm-container-inspect.result.json"));
    },
  ],
])("refuses incomplete or mismatched qualification: %s", async (_fault, mutate) => {
  const proof = await fixture();
  await mutate(proof);
  writeFileSync(path.join(proof.directory, "risk-signal.json"), JSON.stringify(proof.signal));
  expect(() => sparkVllmQualificationReceipt(proof.directory, proof.env)).toThrow();
});

const readWorkflow = () => YAML.parse(readFileSync(".github/workflows/e2e.yaml", "utf8"));
it("accepts the complete hosted selection, preparation and evidence workflow", () => {
  expect(validateSparkVllmWorkflowBoundary(readWorkflow())).toEqual([]);
  expect(validateE2eWorkflow(readWorkflow())).toEqual([]);
});

type Job = ReturnType<typeof readWorkflow>;
const step = (job: Job, name: string) =>
  job.steps.find((item: { name: string }) => item.name === name);
it.each<[string, (job: Job) => void]>([
  [
    "approval",
    (job) => {
      delete job.environment;
    },
  ],
  [
    "runner",
    (job) => {
      job["runs-on"] = "ubuntu-latest";
    },
  ],
  [
    "guard",
    (job) => {
      job.if = "always()";
    },
  ],
  [
    "cancellation",
    (job) => {
      job.concurrency["cancel-in-progress"] = true;
    },
  ],
  [
    "image",
    (job) => {
      job.env.E2E_MANAGED_IMAGE_REVISION = "${{ inputs.checkout_sha }}";
    },
  ],
  [
    "candidate checkout",
    (job) => {
      step(job, "Check out exact Spark candidate").with.ref = "main";
    },
  ],
  [
    "selector",
    (job) => {
      step(job, "Run Spark vLLM extra arguments").run += " --selector '^dgx-station-express:'";
    },
  ],
  [
    "failure masking",
    (job) => {
      step(job, "Run Spark vLLM extra arguments")["continue-on-error"] = true;
    },
  ],
  [
    "artifact upload",
    (job) => {
      step(job, "Upload Spark vLLM qualification artifacts").if = "success()";
    },
  ],
])("rejects drift in the physical Spark boundary: %s", (_fault, mutate) => {
  const workflow = readWorkflow();
  mutate(workflow.jobs[target]);
  expect(validateSparkVllmWorkflowBoundary(workflow).length).toBeGreaterThan(0);
});

it.each<[string, (job: Job) => void]>([
  [
    "candidate checkout",
    (job) => {
      step(job, "Check out trusted Spark receipt validator").with.ref =
        "${{ inputs.checkout_sha }}";
    },
  ],
  [
    "previous attempt",
    (job) => {
      step(job, "Download this attempt's Spark observations").with.name =
        "spark-vllm-observations-1-1";
    },
  ],
  [
    "candidate loader",
    (job) => {
      step(job, "Validate Spark vLLM qualification receipt").run += " --import tsx";
    },
  ],
  [
    "shared runner",
    (job) => {
      job["runs-on"] = "linux-arm64-gpu-dgx-spark-gb10-protected-1";
    },
  ],
])("rejects a compromised receipt consumer: %s", (_fault, mutate) => {
  const workflow = readWorkflow();
  mutate(workflow.jobs["spark-vllm-receipt"]);
  expect(validateSparkVllmWorkflowBoundary(workflow)).not.toEqual([]);
});
