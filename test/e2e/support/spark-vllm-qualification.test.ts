// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { loadManagedInferenceCatalog } from "../../../src/lib/inference/serving/catalog-loader.ts";
import { isHostLocalInferenceServingRecipe } from "../../../src/lib/inference/serving/adapter-registry.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { materializeHostLocalVllmModel } from "../../../src/lib/inference/serving/host-local-vllm-selection.ts";
import { buildVllmServeCommand } from "../../../src/lib/inference/vllm-models.ts";
import { assembleManagedImageCatalog } from "../../../tools/e2e/pr-managed-image-publication.mts";
import {
  ARM64_REFERENCE,
  candidateCatalogEnvironment,
  REVISION,
  selectedEnvironment,
} from "./managed-image-receipt-fixture.ts";
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
const recipe = loadManagedInferenceCatalog().recipes.find(
  ({ metadata }) => metadata.id === "vllm.qwen3-6-35b-a3b-nvfp4.spark-single-64gb.v1",
);
assert(recipe && isHostLocalInferenceServingRecipe(recipe) && recipe.spec.serve?.directInstall);
const boundedCommand = buildVllmServeCommand(
  materializeHostLocalVllmModel(recipe, recipe.spec.serve.directInstall, "spark"),
  {
    NEMOCLAW_VLLM_EXTRA_ARGS_JSON: '["--max-num-seqs","2"]',
  },
);
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
  const env: NodeJS.ProcessEnv = {
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
  const workload = {
    agent: "openclaw",
    platform: "linux/arm64",
    reference: ARM64_REFERENCE,
    sourceCohort: "ghrun-32707920950-1",
    sourceRevision: imageRevision,
  };
  await artifacts.writeJson("spark-sandbox-image.json", workload);
  return { directory, scenario, artifacts, signal, env, workload };
}

it("consumes actual target-writer and risk-reporter artifacts with independent run and image identities", async () => {
  const { directory, env } = await fixture();
  const receipt = await sparkVllmQualificationReceipt(directory, env);
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

async function candidateFixture(platform: "linux/arm64" | "linux/amd64") {
  const { directory, artifacts, env, workload } = await fixture();
  const source = candidateCatalogEnvironment(directory, platform);
  const contracts = JSON.parse(
    readFileSync(source.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!, "utf8").replaceAll(
      REVISION,
      candidate,
    ),
  );
  const catalog = assembleManagedImageCatalog(
    Object.values(contracts),
    candidate,
    { id: 32707920950, attempt: 1 },
    platform,
  );
  delete env.E2E_MANAGED_IMAGE_REVISION;
  delete env.E2E_MANAGED_IMAGE_COHORT_RECEIPT;
  env.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON = JSON.stringify(catalog);
  const observed = { ...workload, sourceRevision: candidate };
  await artifacts.writeJson("spark-sandbox-image.json", observed);
  return { directory, env, observed };
}

it("qualifies the ARM64 candidate catalog and installed sandbox image", async () => {
  const { directory, env, observed } = await candidateFixture("linux/arm64");
  expect(await sparkVllmQualificationReceipt(directory, env)).toMatchObject({
    managedImageRevision: candidate,
    workload: observed,
  });
});

it.each([
  { platform: "linux/amd64", revision: candidate, error: /platform/ },
  { platform: "linux/arm64", revision: imageRevision, error: /revision/ },
] as const)(
  "rejects a candidate catalog with the wrong $error",
  async ({ platform, revision, error }) => {
    const { directory, env } = await candidateFixture(platform);
    env.SPARK_CATALOG_REVISION = revision;
    await expect(sparkVllmQualificationReceipt(directory, env)).rejects.toThrow(error);
  },
);

it("rejects a different durable sandbox image on the physical run", async () => {
  const { directory, artifacts, env, workload } = await fixture();
  await artifacts.writeJson("spark-sandbox-image.json", {
    ...workload,
    reference: workload.reference.replaceAll("b".repeat(64), "e".repeat(64)),
  });
  await expect(sparkVllmQualificationReceipt(directory, env)).rejects.toThrow(/sandbox image/);
});

it("writes the canonical qualification file through the workflow CLI entrypoint", async () => {
  const { directory, env } = await fixture();
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "tools/e2e/spark-vllm-qualification.mts"],
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
  await expect(sparkVllmQualificationReceipt(directory, env)).rejects.toThrow(/memory/);
});

it.each([
  `${boundedCommand} && true`,
  boundedCommand + " --max-model-len=262144",
  boundedCommand + " --max_model_len 262144",
  boundedCommand.replace(/--max-model-len \d+/u, "--max-model-len 0"),
  boundedCommand.replace(/ --max-num-seqs 2$/u, ""),
  boundedCommand + " --max-num-seqs 1",
])(
  "rejects an inspected command that loses the bounded recipe or final override",
  async (command) => {
    const { artifacts, directory, env } = await fixture();
    await artifacts.writeJson("shell/spark-express-vllm-container-inspect.result.json", {
      exitCode: 0,
      stdout: JSON.stringify([{ Id: "d".repeat(64), Config: { Cmd: ["-lc", command] } }]),
    });
    await expect(sparkVllmQualificationReceipt(directory, env)).rejects.toThrow(/command/);
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
  await expect(sparkVllmQualificationReceipt(proof.directory, proof.env)).rejects.toThrow();
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
      step(job, "Validate Spark vLLM qualification receipt").run =
        "node --import ./candidate-loader.mjs tools/e2e/spark-vllm-qualification.mts";
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
