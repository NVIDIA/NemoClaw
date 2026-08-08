// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

type JsonRecord = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = ".github/workflows/openshell-0.0.101-qualification.yaml";
const CONTRACT_PATH = "ci/openshell-0.0.101-qualification-v1.json";
const PRODUCER_ENTRYPOINT = "scripts/checks/openshell-qualification-contract.mts";
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const MAX_FILE_BYTES = 512 * 1024;

const STEP_SCRIPT_DIGESTS = new Map([
  [
    "Authenticate exact qualification dispatch",
    "51c295efeb55b28ac0125bcfa2a04429d0d16a277dbfd657015e675d0b12d2ad",
  ],
  [
    "Produce receipt from authenticated source checks",
    "8394d4becf8555c1e930437bc6dc55c0ff7585604b35c28d3044271a7e59b4c5",
  ],
  [
    "Consume and validate the produced receipt",
    "08a5c1d9961d1b9ad3cff8576f9c4e8a7807872960a6c7486c48863373ca3225",
  ],
]);

const EXPECTED_INPUTS = {
  phase: {
    description: "Receipt phase; final is shared by promotion and release contexts.",
    required: true,
    type: "choice",
    options: ["selector", "final"],
  },
  execution_context: {
    description: "Trust and identity context for this receipt.",
    required: true,
    type: "choice",
    options: ["selector", "final-promotion", "release"],
  },
  candidate_sha: {
    description: "Exact lowercase candidate commit SHA.",
    required: true,
    type: "string",
  },
  base_sha: {
    description: "Exact lowercase current PR base or final candidate first-parent SHA.",
    required: true,
    type: "string",
  },
  pr_number: {
    description: "Open pull request number for selector or final-promotion; empty for release.",
    required: false,
    default: "",
    type: "string",
  },
  workflow_sha: {
    description: "Exact trusted producer workflow SHA (PR base or release candidate).",
    required: true,
    type: "string",
  },
};

const AUTHENTICATE_ENV = {
  ACTOR: "${{ github.actor }}",
  BASE_SHA: "${{ inputs.base_sha }}",
  CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
  EXECUTION_CONTEXT: "${{ inputs.execution_context }}",
  EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
  GITHUB_TOKEN: "${{ github.token }}",
  PHASE: "${{ inputs.phase }}",
  PR_NUMBER: "${{ inputs.pr_number }}",
  RUN_ATTEMPT: "${{ github.run_attempt }}",
  TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
  WORKFLOW_SHA: "${{ github.workflow_sha }}",
};

const PRODUCE_ENV = {
  BASE_SHA: "${{ inputs.base_sha }}",
  CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
  CANDIDATE_ROOT: "${{ github.workspace }}/.candidate-openshell-qualification",
  EXECUTION_CONTEXT: "${{ inputs.execution_context }}",
  GITHUB_TOKEN: "${{ github.token }}",
  PHASE: "${{ inputs.phase }}",
  PR_NUMBER: "${{ inputs.pr_number }}",
  RECEIPT_DIR: "${{ runner.temp }}/openshell-0.0.101-qualification",
  REPOSITORY: "${{ github.repository }}",
  RUN_ATTEMPT: "${{ github.run_attempt }}",
  RUN_ID: "${{ github.run_id }}",
  RUN_URL:
    "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}",
  TRUSTED_ROOT: "${{ github.workspace }}/.trusted-openshell-qualification",
  WORKFLOW_SHA: "${{ github.workflow_sha }}",
};

const CONSUME_ENV = {
  BASE_SHA: "${{ inputs.base_sha }}",
  CANDIDATE_SHA: "${{ inputs.candidate_sha }}",
  CANDIDATE_ROOT: "${{ github.workspace }}/.candidate-openshell-qualification",
  EXECUTION_CONTEXT: "${{ inputs.execution_context }}",
  PHASE: "${{ inputs.phase }}",
  PR_NUMBER: "${{ inputs.pr_number }}",
  RECEIPT_DIR: "${{ runner.temp }}/openshell-0.0.101-qualification",
  REPOSITORY: "${{ github.repository }}",
  TRUSTED_ROOT: "${{ github.workspace }}/.trusted-openshell-qualification",
};

function fail(message: string): never {
  throw new Error(`OpenShell qualification producer workflow check failed: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a string`);
  return value;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function exactJson(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(canonicalJson(actual)) !== JSON.stringify(canonicalJson(expected))) {
    fail(`${label} does not match the reviewed contract`);
  }
}

function regularFileSource(relativePath: string): string {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    fail(`${relativePath} must be a bounded regular file`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function moduleImportPaths(relativePath: string): string[] {
  const source = regularFileSource(relativePath);
  const imports = new Set<string>();
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+\.mts)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(relativePath), specifier),
    );
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
      fail(`trusted runtime import escapes the repository: ${specifier}`);
    }
    imports.add(resolved);
  }
  return [...imports];
}

export function qualificationProducerRuntimePaths(): string[] {
  const discovered = new Set<string>([CONTRACT_PATH]);
  const pending = [PRODUCER_ENTRYPOINT];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || discovered.has(current)) continue;
    discovered.add(current);
    for (const imported of moduleImportPaths(current)) pending.push(imported);
  }
  return [...discovered].sort();
}

function contractOwnedIdentifiers(): string[] {
  const contract = record(JSON.parse(regularFileSource(CONTRACT_PATH)) as unknown, "contract");
  const tests = array(contract.tests, "contract.tests");
  const identifiers = new Set<string>();
  for (const [index, rawTest] of tests.entries()) {
    const test = record(rawTest, `contract.tests[${index}]`);
    identifiers.add(string(test.id, `contract.tests[${index}].id`));
    const matrix = record(test.matrix, `contract.tests[${index}].matrix`);
    for (const rawLane of array(matrix.lanes, `contract.tests[${index}].matrix.lanes`)) {
      const lane = record(rawLane, `contract.tests[${index}].matrix.lane`);
      for (const key of ["id", "jobId", "jobName", "name"]) {
        if (typeof lane[key] === "string" && lane[key].length > 0) identifiers.add(lane[key]);
      }
    }
  }
  return [...identifiers];
}

function validateScriptStep(step: JsonRecord, name: string, expectedEnv: JsonRecord): void {
  exactKeys(step, ["env", "name", "run", "shell"], `step ${name}`);
  if (step.name !== name || step.shell !== "bash") fail(`step ${name} identity is invalid`);
  exactJson(step.env, expectedEnv, `step ${name} environment`);
  const digest = createHash("sha256")
    .update(string(step.run, `step ${name} run`))
    .digest("hex");
  if (digest !== STEP_SCRIPT_DIGESTS.get(name)) fail(`step ${name} program changed`);
}

function validateTrustedCheckout(step: JsonRecord): void {
  exactKeys(step, ["name", "uses", "with"], "trusted checkout step");
  if (
    step.name !== "Check out base-trusted qualification contract" ||
    step.uses !== CHECKOUT_ACTION
  ) {
    fail("trusted checkout action identity changed");
  }
  const inputs = record(step.with, "trusted checkout inputs");
  exactKeys(
    inputs,
    ["path", "persist-credentials", "ref", "sparse-checkout", "sparse-checkout-cone-mode"],
    "trusted checkout inputs",
  );
  exactJson(
    { ...inputs, "sparse-checkout": undefined },
    {
      ref: "${{ inputs.base_sha }}",
      path: ".trusted-openshell-qualification",
      "persist-credentials": false,
      "sparse-checkout": undefined,
      "sparse-checkout-cone-mode": false,
    },
    "trusted checkout inputs",
  );
  const sparsePaths = string(inputs["sparse-checkout"], "trusted sparse checkout")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = [...new Set(sparsePaths)].sort();
  if (unique.length !== sparsePaths.length) fail("trusted sparse checkout paths are duplicated");
  exactJson(unique, qualificationProducerRuntimePaths(), "trusted sparse checkout runtime closure");
}

function validateContractOwnedMatrix(workflow: JsonRecord): void {
  const serialized = JSON.stringify(workflow);
  for (const identifier of contractOwnedIdentifiers()) {
    if (serialized.includes(identifier))
      fail(`workflow hard-codes contract-owned identifier ${identifier}`);
  }
  if (
    /openshell-[0-9]{5}-/u.test(serialized) ||
    serialized.includes("Rootless Podman CPU lifecycle")
  ) {
    fail("workflow hard-codes qualification matrix ownership outside the contract");
  }
}

export function validateQualificationProducerWorkflow(value: unknown): void {
  const workflow = record(value, "workflow");
  exactKeys(workflow, ["concurrency", "jobs", "name", "on", "permissions", "run-name"], "workflow");
  validateContractOwnedMatrix(workflow);
  if (workflow.name !== "OpenShell 0.0.101 Qualification") fail("workflow name changed");
  if (
    workflow["run-name"] !==
    "OpenShell 0.0.101 ${{ inputs.execution_context }} candidate ${{ inputs.candidate_sha }} base ${{ inputs.base_sha }}"
  ) {
    fail("workflow run identity changed");
  }

  const triggers = record(workflow.on, "workflow.on");
  exactKeys(triggers, ["workflow_dispatch"], "workflow.on");
  const dispatch = record(triggers.workflow_dispatch, "workflow_dispatch");
  exactKeys(dispatch, ["inputs"], "workflow_dispatch");
  exactJson(
    record(dispatch.inputs, "workflow_dispatch.inputs"),
    EXPECTED_INPUTS,
    "dispatch inputs",
  );
  exactJson(
    workflow.permissions,
    { actions: "read", checks: "read", contents: "read", "pull-requests": "read" },
    "workflow permissions",
  );
  exactJson(
    workflow.concurrency,
    {
      group:
        "openshell-0.0.101-qualification-${{ inputs.execution_context }}-${{ inputs.candidate_sha }}",
      "cancel-in-progress": true,
    },
    "workflow concurrency",
  );

  const jobs = record(workflow.jobs, "workflow.jobs");
  exactKeys(jobs, ["receipt"], "workflow.jobs");
  const job = record(jobs.receipt, "receipt job");
  exactKeys(job, ["if", "runs-on", "steps", "timeout-minutes"], "receipt job");
  if (
    job.if !== "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main'" ||
    job["runs-on"] !== "ubuntu-latest" ||
    job["timeout-minutes"] !== 10
  ) {
    fail("receipt job repository, ref, runner, or timeout boundary changed");
  }

  const steps = array(job.steps, "receipt job steps").map((step, index) =>
    record(step, `receipt job step ${index}`),
  );
  if (steps.length !== 7) fail("receipt job must contain exactly seven reviewed steps");
  exactJson(
    steps[0],
    {
      name: "Set up trusted qualification runtime",
      uses: SETUP_NODE_ACTION,
      with: { "node-version": "22.19.0" },
    },
    "trusted runtime setup step",
  );
  validateScriptStep(steps[1] ?? {}, "Authenticate exact qualification dispatch", AUTHENTICATE_ENV);
  validateTrustedCheckout(steps[2] ?? {});
  exactJson(
    steps[3],
    {
      name: "Check out candidate qualification contract data",
      uses: CHECKOUT_ACTION,
      with: {
        ref: "${{ inputs.candidate_sha }}",
        path: ".candidate-openshell-qualification",
        "persist-credentials": false,
        "sparse-checkout": CONTRACT_PATH,
        "sparse-checkout-cone-mode": false,
      },
    },
    "candidate data-only checkout step",
  );
  validateScriptStep(
    steps[4] ?? {},
    "Produce receipt from authenticated source checks",
    PRODUCE_ENV,
  );
  validateScriptStep(steps[5] ?? {}, "Consume and validate the produced receipt", CONSUME_ENV);
  exactJson(
    steps[6],
    {
      name: "Upload exact qualification receipt",
      uses: UPLOAD_ACTION,
      with: {
        name: "openshell-0.0.101-qualification-${{ inputs.execution_context }}-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/openshell-0.0.101-qualification/qualification.json",
        "if-no-files-found": "error",
        "retention-days": 30,
        "compression-level": 0,
      },
    },
    "receipt artifact step",
  );
}

export function loadQualificationProducerWorkflow(
  workflowPath = path.join(REPO_ROOT, WORKFLOW_PATH),
): unknown {
  const stat = fs.lstatSync(workflowPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    fail("producer workflow must be a bounded regular file");
  }
  try {
    return YAML.parse(fs.readFileSync(workflowPath, "utf8")) as unknown;
  } catch {
    fail("producer workflow YAML is malformed");
  }
}

export function verifyQualificationProducerWorkflowFile(workflowPath?: string): void {
  validateQualificationProducerWorkflow(loadQualificationProducerWorkflow(workflowPath));
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  if (process.argv.length > 3) fail("expected at most one workflow path argument");
  verifyQualificationProducerWorkflowFile(process.argv[2]);
  console.log("OpenShell qualification producer workflow contract passed.");
}
