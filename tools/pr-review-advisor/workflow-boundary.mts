// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { ADVISOR_INTERESTS, ADVISOR_SPECIALISTS } from "./specialists.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW = join(ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const DEFAULT_LOCK = join(ROOT, "package-lock.json");
const DEFAULT_POLICY = join(ROOT, "tools", "pr-review-advisor", "openshell-policy.yaml");
const ACTION_PIN = /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}(?:\s*#.*)?$/u;
const SANDBOX_NAME = /^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/u;
const INTERESTS = new Set(ADVISOR_INTERESTS);
const SPECIALIST_MATRIX_EXPRESSION =
  "${{ fromJSON(needs.discover-specialists.outputs.matrix) }}";
const BASE_REF_EXPRESSION =
  "${{ github.event_name == 'pull_request_target' && 'target/base' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'target/base' || inputs.base_ref) }}";
const HEAD_REF_EXPRESSION =
  "${{ github.event_name == 'pull_request_target' && 'HEAD' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'HEAD' || inputs.head_ref) }}";
const SPECIALIST_PERMISSIONS = { actions: "read" };

type Value = Record<string, any>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
}

function jobSteps(job: Value): Value[] {
  return Array.isArray(job.steps) ? job.steps.map(object) : [];
}

function namedStep(job: Value, name: string): Value | undefined {
  return jobSteps(job).find((item) => item.name === name);
}

function requireWith(
  errors: string[],
  item: Value | undefined,
  key: string,
  expected: unknown,
): void {
  if (!item) {
    errors.push("missing workflow step");
    return;
  }
  if (object(item.with)[key] !== expected)
    errors.push("step '" + item.name + "' expected with." + key + "=" + String(expected));
}

function checkPermissions(
  errors: string[],
  name: string,
  job: Value,
  expected: Record<string, string>,
): void {
  const actual = object(job.permissions);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) errors.push(name + " job permissions." + key + " must be " + value);
  }
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key)) {
      const expectation = key === "pull-requests" ? " must be read" : " is not allowed";
      errors.push(name + " job permissions." + key + expectation);
    }
  }
}

function checkActionPins(errors: string[], name: string, job: Value): void {
  for (const item of jobSteps(job)) {
    if (item.uses && !ACTION_PIN.test(item.uses))
      errors.push(
        name + " step '" + (item.name ?? item.uses) + "' must pin action uses to a full commit SHA",
      );
  }
}

function checkLock(errors: string[], path: string): void {
  try {
    const packages = object(object(JSON.parse(readFileSync(path, "utf8"))).packages);
    const pins = [
      ["@earendil-works/pi-coding-agent", "0.80.6"],
      ["typebox", "1.1.38"],
      ["undici", "8.10.0"],
      ["yaml", "2.8.3"],
      ["vitest", "4.1.9"],
    ];
    for (const [name, version] of pins) {
      if (object(packages["node_modules/" + name]).version !== version)
        errors.push("advisor package lock must pin " + name + "@" + version);
    }
  } catch {
    errors.push("failed to read or parse advisor package lock: " + path);
  }
}

function checkPolicy(errors: string[], path: string): void {
  try {
    const policy = object(YAML.parse(readFileSync(path, "utf8")));
    const filesystem = object(policy.filesystem_policy);
    if (filesystem.include_workdir !== false)
      errors.push("advisor OpenShell policy must not include the default workdir");
    const writable = Array.isArray(filesystem.read_write) ? filesystem.read_write : [];
    if (writable.some((item) => !["/dev", "/sandbox/pr-review-advisor-runtime"].includes(item)))
      errors.push("advisor OpenShell policy must confine writable paths");
    if (Object.keys(object(policy.network_policies)).length !== 0)
      errors.push("advisor OpenShell policy must not allow direct network egress");
  } catch {
    errors.push("failed to read or parse advisor OpenShell policy: " + path);
  }
}

function checkSandboxNames(errors: string[], jobs: Array<[string, Value]>): void {
  const names: string[] = [];
  for (const [label, job] of jobs) {
    const rows = object(object(job.strategy).matrix).advisor;
    const resolvedRows =
      rows === SPECIALIST_MATRIX_EXPRESSION
        ? ADVISOR_SPECIALISTS.map(({ sandboxName }) => ({ sandbox_name: sandboxName }))
        : rows;
    if (!Array.isArray(resolvedRows) || resolvedRows.length === 0) {
      errors.push(label + " matrix must declare a non-empty advisor array");
      continue;
    }
    resolvedRows.map(object).forEach((row, index) => {
      const name = typeof row.sandbox_name === "string" ? row.sandbox_name : "";
      names.push(name);
      if (name.length > 19 || !SANDBOX_NAME.test(name))
        errors.push(
          label +
            " matrix entry " +
            (index + 1) +
            " sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)",
        );
    });
  }
  if (new Set(names).size !== names.length)
    errors.push("specialist sandbox_name values must be unique");
}

export function validatePrReviewAdvisorWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW,
  packageLockPath = DEFAULT_LOCK,
  policyPath = DEFAULT_POLICY,
): string[] {
  const errors: string[] = [];
  let workflow: Value;
  try {
    workflow = object(YAML.parse(readFileSync(workflowPath, "utf8")));
  } catch {
    return ["failed to read or parse workflow: " + workflowPath];
  }
  checkLock(errors, packageLockPath);
  checkPolicy(errors, policyPath);
  const triggers = object(workflow.on ?? workflow.true);
  if (!("pull_request_target" in triggers) || "pull_request" in triggers)
    errors.push("workflow must use pull_request_target without pull_request");
  if (Object.keys(object(workflow.permissions)).length !== 0)
    errors.push(
      "workflow-level permissions must be empty so each job declares its privilege domain",
    );
  const jobs = object(workflow.jobs);
  const discovery = object(jobs["discover-specialists"]);
  const specialists = object(jobs["review-specialists"]);
  const publish = object(jobs.publish);
  checkPermissions(errors, "discover-specialists", discovery, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  checkPermissions(errors, "review-specialists", specialists, SPECIALIST_PERMISSIONS);
  checkPermissions(errors, "publish", publish, { contents: "read", "pull-requests": "write" });
  if (jobs.review !== undefined) errors.push("workflow must not declare a synthesis job");
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== "publish" && object(object(job).permissions)["pull-requests"] === "write")
      errors.push("publish must be the only job with pull-requests: write");
  }
  if (JSON.stringify(publish).includes("PR_REVIEW_ADVISOR_API_KEY"))
    errors.push("publish job must not receive the advisor model credential");
  if (JSON.stringify(publish).includes("ADVISOR_WORKDIR"))
    errors.push("publish job must not receive the untrusted analysis worktree");
  const contextCollection = namedStep(discovery, "Collect GitHub review context");
  if (object(contextCollection?.env).GH_TOKEN !== "${{ github.token }}")
    errors.push("shared context collection must receive github.token as GH_TOKEN");
  const specialistTokenWiring = JSON.stringify(specialists);
  const specialistEnvironments = [specialists, ...jobSteps(specialists)].map((item) =>
    object(item.env),
  );
  if (
    specialistEnvironments.some(
      (env) => env.GH_TOKEN !== undefined || env.GITHUB_TOKEN !== undefined,
    ) ||
    /\$\{\{[^}]*\b(?:github\.token|secrets\.GITHUB_TOKEN)\b[^}]*\}\}/u.test(
      specialistTokenWiring,
    )
  )
    errors.push("specialist jobs must not wire a GitHub token into steps");
  const contextUpload = namedStep(discovery, "Upload GitHub review context");
  const contextDownload = namedStep(specialists, "Download GitHub review context");
  if (!String(contextUpload?.uses ?? "").startsWith("actions/upload-artifact@"))
    errors.push("shared context upload must use actions/upload-artifact");
  if (!String(contextDownload?.uses ?? "").startsWith("actions/download-artifact@"))
    errors.push("shared context download must use actions/download-artifact");
  requireWith(errors, contextUpload, "path", "artifacts/pr-review-advisor-context/github-context.json");
  requireWith(
    errors,
    contextDownload,
    "path",
    "${{ runner.temp }}/shared-pr-review-advisor-context",
  );
  requireWith(errors, contextUpload, "if-no-files-found", "error");
  requireWith(errors, contextUpload, "retention-days", 1);
  requireWith(
    errors,
    contextUpload,
    "name",
    "pr-review-advisor-context-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  requireWith(
    errors,
    contextDownload,
    "name",
    "pr-review-advisor-context-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  checkSandboxNames(errors, [["specialist", specialists]]);
  const rows = object(object(specialists.strategy).matrix).advisor;
  if (rows !== SPECIALIST_MATRIX_EXPRESSION)
    errors.push("specialist matrix must use the discovered specialist prompts");
  const specialistNeeds = Array.isArray(specialists.needs)
    ? specialists.needs
    : [specialists.needs];
  if (!specialistNeeds.includes("discover-specialists"))
    errors.push("specialist matrix must depend on prompt discovery");
  if (specialists["continue-on-error"] !== undefined)
    errors.push("specialist failures must block publication");
  if (publish.needs !== "review-specialists")
    errors.push("publisher must depend on the specialist matrix");
  if (object(specialists.env).PR_REVIEW_ADVISOR_INTEREST !== "${{ matrix.advisor.interest }}")
    errors.push(
      "specialist job env.PR_REVIEW_ADVISOR_INTEREST must be ${{ matrix.advisor.interest }}",
    );
  const prepareInputs = namedStep(specialists, "Prepare advisor sandbox inputs");
  const prepareEnvironment = object(prepareInputs?.env);
  if (prepareEnvironment.BASE_REF !== BASE_REF_EXPRESSION)
    errors.push("Prepare advisor sandbox inputs must receive the selected base ref");
  if (prepareEnvironment.HEAD_REF !== HEAD_REF_EXPRESSION)
    errors.push("Prepare advisor sandbox inputs must receive the selected head ref");
  if (
    prepareEnvironment.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH !==
    "${{ runner.temp }}/shared-pr-review-advisor-context/github-context.json"
  )
    errors.push("Prepare advisor sandbox inputs must receive the downloaded GitHub context");
  const specialistUpload = namedStep(specialists, "Upload specialist review");
  if (!String(specialistUpload?.uses ?? "").startsWith("actions/upload-artifact@"))
    errors.push("specialist review step must use actions/upload-artifact");
  requireWith(errors, specialistUpload, "if-no-files-found", "error");
  requireWith(
    errors,
    specialistUpload,
    "path",
    "artifacts/${{ matrix.advisor.artifact_dir }}/",
  );
  requireWith(
    errors,
    namedStep(publish, "Checkout trusted comment publisher (workflow revision)"),
    "ref",
    "${{ github.workflow_sha }}",
  );
  const publishCommand = String(namedStep(publish, "Post PR review advisor link")?.run ?? "");
  if (!publishCommand.includes("tools/pr-review-advisor/completion-comment.mts"))
    errors.push("publisher must post the workflow-run advisory link");
  checkActionPins(errors, "discover-specialists", discovery);
  checkActionPins(errors, "review-specialists", specialists);
  checkActionPins(errors, "publish", publish);
  return errors;
}
