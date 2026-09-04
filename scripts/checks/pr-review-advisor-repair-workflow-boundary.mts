// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIRECTORY = path.join(REPO_ROOT, ".github", "workflows");
const PHASE1_WORKFLOW = "pr-review-advisor-repair.yaml";
const RECONCILIATION_WORKFLOW = "pr-review-advisor-repair-reconcile.yaml";
const GENERATED_HEAD_WORKFLOWS = [
  "pr.yaml",
  "commit-lint.yaml",
  "dco-check.yaml",
  "installer-hash-check.yaml",
  "code-scanning.yaml",
  "pr-review-advisor.yaml",
] as const;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const TRUSTED_REF = "${{ github.workflow_sha }}";
const PHASE1_INPUTS = [
  "advisor_run_id",
  "finding_ids_json",
  "pr_number",
  "repository_egress_authorized",
  "source_head_sha",
] as const;
const STANDARD_GENERATED_HEAD_INPUTS = [
  "base_sha",
  "pr_number",
  "repair_attempt_key",
  "source_head_sha",
] as const;
const ADVISOR_GENERATED_HEAD_INPUTS = [
  "base_ref",
  "base_sha",
  "head_ref",
  "repair_attempt_key",
  "source_head_sha",
  "target_base",
  "target_pr",
  "target_repo",
] as const;

type Value = Record<string, unknown>;
type Step = Value & { uses?: string; run?: string; with?: Value; env?: Value };

function record(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
}

function steps(job: Value): Step[] {
  return Array.isArray(job.steps) ? (job.steps as Step[]) : [];
}

function jobs(workflow: Value): Array<[string, Value]> {
  return Object.entries(record(workflow.jobs)).map(([name, job]) => [name, record(job)]);
}

function condition(errors: string[], valid: boolean, message: string): void {
  if (!valid) errors.push(message);
}

function same(value: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(value, expected);
}

function actionSteps(workflow: Value): Step[] {
  return jobs(workflow)
    .flatMap(([, job]) => steps(job))
    .filter((step) => step.uses);
}

function pinnedActions(workflow: Value): boolean {
  return actionSteps(workflow).every(
    ({ uses }) => typeof uses === "string" && (uses.startsWith("./") || PINNED_ACTION.test(uses)),
  );
}

function onlyManualDispatch(workflow: Value): boolean {
  return same(Object.keys(record(workflow.on)).sort(), ["workflow_dispatch"]);
}

function trustedCheckouts(workflow: Value): Step[] {
  return actionSteps(workflow).filter(({ uses, with: input }) =>
    Boolean(uses?.startsWith("actions/checkout@") && record(input).path === "trusted"),
  );
}

function exactTrustedCheckout(step: Step): boolean {
  const input = record(step.with);
  return (
    input.repository === "NVIDIA/NemoClaw" &&
    input.ref === TRUSTED_REF &&
    input["persist-credentials"] === false &&
    input.lfs === false &&
    input.submodules === false
  );
}

function downloadsUseImmutableIds(workflow: Value): boolean {
  return actionSteps(workflow)
    .filter(({ uses }) => uses?.startsWith("actions/download-artifact@"))
    .every(({ with: input }) => {
      const options = record(input);
      return typeof options["artifact-ids"] === "string" && !("name" in options);
    });
}

function onlyCheckAttestationMayWrite(job: Value): boolean {
  return Object.entries(record(job.permissions)).every(
    ([scope, access]) => access !== "write" || scope === "checks",
  );
}

function sourceCheckouts(workflow: Value): Array<{ jobName: string; step: Step; input: Value }> {
  return jobs(workflow).flatMap(([jobName, job]) =>
    steps(job)
      .filter(
        ({ uses, with: input }) =>
          uses?.startsWith("actions/checkout@") && record(input).path === "source",
      )
      .map((step) => ({ jobName, step, input: record(step.with) })),
  );
}

function validateSharedWorkflowBoundary(workflow: Value, label: string): string[] {
  const errors: string[] = [];
  const workflowJobs = jobs(workflow);
  condition(errors, onlyManualDispatch(workflow), `${label} must be manual-only`);
  condition(errors, same(workflow.permissions, {}), `${label} top-level permissions must be empty`);
  condition(errors, pinnedActions(workflow), `${label} must pin every third-party action`);
  condition(
    errors,
    trustedCheckouts(workflow).length === workflowJobs.length &&
      trustedCheckouts(workflow).every(exactTrustedCheckout),
    `${label} must give every job one credential-free trusted-code checkout`,
  );
  condition(
    errors,
    downloadsUseImmutableIds(workflow),
    `${label} artifact downloads must use immutable artifact IDs`,
  );
  condition(
    errors,
    sourceCheckouts(workflow).every(
      ({ input }) =>
        input["persist-credentials"] === false && input.repository === "NVIDIA/NemoClaw",
    ),
    `${label} source checkouts must be canonical and credential-free`,
  );
  return errors;
}

export function validatePhase1WorkflowAuthority(workflow: Value): string[] {
  const errors = validateSharedWorkflowBoundary(workflow, "Phase 1 workflow");
  const dispatchInputs = record(record(record(workflow.on).workflow_dispatch).inputs);
  const workflowJobs = record(workflow.jobs);
  const repair = record(workflowJobs.repair);
  const publish = record(workflowJobs.publish);
  const serializedRepair = JSON.stringify(repair);
  const serializedOtherJobs = JSON.stringify(
    Object.fromEntries(Object.entries(workflowJobs).filter(([name]) => name !== "repair")),
  );
  const source = JSON.stringify(workflow);
  const modelCredentialReferences = source.match(/secrets[.]PR_REVIEW_ADVISOR_API_KEY/gu) ?? [];
  condition(
    errors,
    same(Object.keys(dispatchInputs).sort(), [...PHASE1_INPUTS]),
    "Phase 1 workflow must expose only its reviewed dispatch inputs",
  );
  condition(
    errors,
    same(Object.keys(workflowJobs).sort(), [
      "collect",
      "publish",
      "repair",
      "validate",
      "verify-generated-head",
    ]),
    "Phase 1 workflow must retain the reviewed five-job authority split",
  );
  condition(
    errors,
    modelCredentialReferences.length === 1 &&
      serializedRepair.includes("secrets.PR_REVIEW_ADVISOR_API_KEY") &&
      !serializedOtherJobs.includes("secrets.PR_REVIEW_ADVISOR_API_KEY"),
    "only the read-only repair job may receive the model credential",
  );
  condition(
    errors,
    same(repair.permissions, { actions: "read", contents: "read" }),
    "repair must remain read-only",
  );
  condition(
    errors,
    typeof repair.if === "string" && repair.if.includes("github.run_attempt == 1"),
    "repair must be disabled on workflow reruns",
  );
  condition(
    errors,
    same(publish.permissions, {
      actions: "write",
      checks: "write",
      contents: "write",
      "pull-requests": "read",
    }) && publish.environment === "advisor-repair-publication",
    "publication must be the protected source-writing job",
  );
  condition(
    errors,
    jobs(workflow).every(([name, job]) => name === "publish" || onlyCheckAttestationMayWrite(job)),
    "no non-publication job may hold write authority",
  );
  const repairRunSteps = steps(repair).filter(({ run }) => run);
  condition(
    errors,
    repairRunSteps.every(({ run }) => !String(run).includes("$SOURCE_CHECKOUT")) &&
      repairRunSteps.some(
        ({ run, env }) =>
          record(env).REPAIR_COMMAND === "lifecycle" &&
          record(env).OPENAI_API_KEY === "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" &&
          String(run).includes("$TRUSTED_CHECKOUT/tools/pr-review-advisor-repair/resolve.mts"),
      ),
    "repair may send source data only through the trusted bounded lifecycle",
  );
  const expectedSourceRefs: Record<string, string> = {
    publish: "${{ needs.collect.outputs.source_head_sha }}",
    repair: "${{ needs.collect.outputs.source_head_sha }}",
    validate: "${{ needs.collect.outputs.source_head_sha }}",
  };
  condition(
    errors,
    sourceCheckouts(workflow).length === 3 &&
      sourceCheckouts(workflow).every(
        ({ jobName, input }) => input.ref === expectedSourceRefs[jobName],
      ),
    "Phase 1 source checkouts must bind the selected exact head",
  );
  return errors;
}

export function validateReconciliationWorkflowAuthority(workflow: Value): string[] {
  const errors = validateSharedWorkflowBoundary(workflow, "reconciliation workflow");
  const workflowJobs = record(workflow.jobs);
  const publish = record(workflowJobs.publish);
  const source = JSON.stringify(workflow);
  condition(
    errors,
    same(Object.keys(workflowJobs).sort(), ["collect", "publish", "verify-generated-head"]),
    "reconciliation must retain the deterministic three-job recovery split",
  );
  condition(
    errors,
    !/PR_REVIEW_ADVISOR_API_KEY|OPENAI_API_KEY|resolve[.]mts|openshell/iu.test(source),
    "reconciliation must not invoke a model repair",
  );
  condition(
    errors,
    same(publish.permissions, {
      actions: "write",
      checks: "write",
      contents: "write",
      "pull-requests": "read",
    }) && publish.environment === "advisor-repair-publication",
    "reconciliation publication must remain protected",
  );
  condition(
    errors,
    jobs(workflow).every(([name, job]) => name === "publish" || onlyCheckAttestationMayWrite(job)),
    "reconciliation non-publication jobs must not hold write authority",
  );
  condition(
    errors,
    sourceCheckouts(workflow).length === 1 &&
      sourceCheckouts(workflow)[0]?.jobName === "publish" &&
      sourceCheckouts(workflow)[0]?.input.ref === "${{ inputs.source_head_sha }}",
    "reconciliation may check out only the exact original source in its publisher",
  );
  return errors;
}

export function validateGeneratedHeadWorkflow(fileName: string, workflow: Value): string[] {
  const errors: string[] = [];
  const dispatchInputs = record(record(record(workflow.on).workflow_dispatch).inputs);
  const runSteps = jobs(workflow)
    .flatMap(([, job]) => steps(job))
    .filter(({ run }) => run);
  const serialized = JSON.stringify(workflow);
  const expectedInputs =
    fileName === "pr-review-advisor.yaml"
      ? ADVISOR_GENERATED_HEAD_INPUTS
      : STANDARD_GENERATED_HEAD_INPUTS;
  const expectedPrInput =
    fileName === "pr-review-advisor.yaml" ? "${{ inputs.target_pr }}" : "${{ inputs.pr_number }}";
  const verifierJobs = jobs(workflow).filter(([, job]) =>
    steps(job).some(({ run }) => String(run).includes("generated-head-context.mts")),
  );
  const verifierIsTrusted = verifierJobs.some(([, job]) => {
    const jobSteps = steps(job);
    const verifierIndex = jobSteps.findIndex(({ run }) =>
      String(run).includes("generated-head-context.mts"),
    );
    const verifier = jobSteps[verifierIndex];
    const verifierEnvironment = record(verifier?.env);
    const trustedCheckoutBeforeVerifier = jobSteps
      .slice(0, verifierIndex)
      .some(
        ({ uses, with: input }) =>
          uses?.startsWith("actions/checkout@") &&
          String(record(input).ref).includes("github.workflow_sha") &&
          record(input)["persist-credentials"] === false &&
          !("path" in record(input)),
      );
    return (
      trustedCheckoutBeforeVerifier &&
      verifierEnvironment.BASE_SHA === "${{ inputs.base_sha }}" &&
      verifierEnvironment.GITHUB_WORKFLOW_SHA === TRUSTED_REF &&
      verifierEnvironment.PR_NUMBER === expectedPrInput &&
      verifierEnvironment.REPAIR_ATTEMPT_KEY === "${{ inputs.repair_attempt_key }}" &&
      verifierEnvironment.SOURCE_HEAD_SHA === "${{ inputs.source_head_sha }}"
    );
  });
  condition(
    errors,
    same(Object.keys(dispatchInputs).sort(), [...expectedInputs].sort()),
    `${fileName} must expose only its reviewed dispatch inputs`,
  );
  condition(errors, pinnedActions(workflow), `${fileName} must pin every third-party action`);
  condition(
    errors,
    serialized.includes("inputs.source_head_sha") && serialized.includes("inputs.base_sha"),
    `${fileName} must bind the generated head and its recorded base`,
  );
  condition(
    errors,
    runSteps.some(({ run }) => String(run).includes("generated-head-context.mts")) &&
      verifierIsTrusted,
    `${fileName} must invoke the exact-identity verifier from trusted workflow code`,
  );
  return errors;
}

function parseWorkflow(fileName: string, source: string, errors: string[]): Value {
  try {
    return record(YAML.parse(source));
  } catch {
    errors.push(`${fileName} must contain valid YAML`);
    return {};
  }
}

export type RepairWorkflowSources = Readonly<{
  phase1: string;
  reconciliation: string;
  generatedHead: Readonly<Record<string, string>>;
}>;

export function validateRepairWorkflowBoundary(sources: RepairWorkflowSources): string[] {
  const errors: string[] = [];
  const phase1 = parseWorkflow(PHASE1_WORKFLOW, sources.phase1, errors);
  const reconciliation = parseWorkflow(RECONCILIATION_WORKFLOW, sources.reconciliation, errors);
  errors.push(...validatePhase1WorkflowAuthority(phase1));
  errors.push(...validateReconciliationWorkflowAuthority(reconciliation));
  for (const fileName of GENERATED_HEAD_WORKFLOWS) {
    const source = sources.generatedHead[fileName];
    const workflow = parseWorkflow(fileName, source ?? "", errors);
    errors.push(...validateGeneratedHeadWorkflow(fileName, workflow));
  }
  return errors;
}

function readCurrentSources(): RepairWorkflowSources {
  return {
    phase1: fs.readFileSync(path.join(WORKFLOW_DIRECTORY, PHASE1_WORKFLOW), "utf8"),
    reconciliation: fs.readFileSync(path.join(WORKFLOW_DIRECTORY, RECONCILIATION_WORKFLOW), "utf8"),
    generatedHead: Object.fromEntries(
      GENERATED_HEAD_WORKFLOWS.map((fileName) => [
        fileName,
        fs.readFileSync(path.join(WORKFLOW_DIRECTORY, fileName), "utf8"),
      ]),
    ),
  };
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  const errors = validateRepairWorkflowBoundary(readCurrentSources());
  if (errors.length > 0) {
    errors.forEach((error) => console.error(error));
    process.exit(1);
  }
  console.log("PR Review Advisor repair workflow boundary passed.");
}
