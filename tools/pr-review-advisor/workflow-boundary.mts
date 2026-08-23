// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { ADVISOR_INTERESTS } from "./specialists.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW = join(ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const DEFAULT_LOCK = join(ROOT, "package-lock.json");
const DEFAULT_POLICY = join(ROOT, "tools", "pr-review-advisor", "openshell-policy.yaml");
const ACTION_PIN = /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}(?:\s*#.*)?$/u;
const SANDBOX_NAME = /^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/u;
const INTERESTS = new Set(ADVISOR_INTERESTS);
const READ_PERMISSIONS = {
  actions: "read",
  checks: "read",
  contents: "read",
  issues: "read",
  "pull-requests": "read",
};

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
    if (!Object.hasOwn(expected, key))
      errors.push(name + " job permissions." + key + " is not allowed");
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
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push(label + " matrix must declare a non-empty advisor array");
      continue;
    }
    rows.map(object).forEach((row, index) => {
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
    errors.push("advisor, specialist, and synthesis sandbox_name values must be unique");
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
  const specialists = object(jobs["review-specialists"]);
  const review = object(jobs.review);
  const publish = object(jobs.publish);
  checkPermissions(errors, "review-specialists", specialists, READ_PERMISSIONS);
  checkPermissions(errors, "review", review, READ_PERMISSIONS);
  checkPermissions(errors, "publish", publish, { contents: "read", "pull-requests": "write" });
  for (const [name, job] of Object.entries(jobs)) {
    if (name !== "publish" && object(object(job).permissions)["pull-requests"] === "write")
      errors.push("publish must be the only job with pull-requests: write");
  }
  if (JSON.stringify(publish).includes("PR_REVIEW_ADVISOR_API_KEY"))
    errors.push("publish job must not receive the advisor model credential");
  if (JSON.stringify(publish).includes("ADVISOR_WORKDIR"))
    errors.push("publish job must not receive the untrusted analysis worktree");
  checkSandboxNames(errors, [
    ["specialist", specialists],
    ["synthesis", review],
  ]);
  const rows = object(object(specialists.strategy).matrix).advisor;
  const interests = Array.isArray(rows) ? rows.map((row) => object(row).interest) : [];
  if (
    interests.length !== INTERESTS.size ||
    new Set(interests).size !== INTERESTS.size ||
    interests.some((interest) => !INTERESTS.has(interest))
  )
    errors.push("specialist matrix must declare the five review interests");
  if (specialists["continue-on-error"] !== undefined)
    errors.push("specialist failures must block synthesis");
  if (review.needs !== "review-specialists")
    errors.push("review synthesis must depend on the specialist matrix");
  if (publish.needs !== "review") errors.push("publisher must depend on review synthesis");
  if (object(specialists.env).PR_REVIEW_ADVISOR_INTEREST !== "${{ matrix.advisor.interest }}")
    errors.push(
      "specialist job env.PR_REVIEW_ADVISOR_INTEREST must be ${{ matrix.advisor.interest }}",
    );
  requireWith(
    errors,
    namedStep(specialists, "Upload native specialist session"),
    "if-no-files-found",
    "error",
  );
  requireWith(
    errors,
    namedStep(review, "Download specialist session artifacts"),
    "path",
    "pr-workdir/.pr-review-advisor-sessions",
  );
  requireWith(
    errors,
    namedStep(review, "Checkout trusted advisor code (workflow revision)"),
    "ref",
    "${{ github.workflow_sha }}",
  );
  const artifact = namedStep(publish, "Download primary advisor artifact");
  requireWith(errors, artifact, "name", "pr-review-advisor");
  requireWith(errors, artifact, "path", "publish-artifacts/pr-review-advisor");
  for (const key of ["run-id", "github-token", "repository", "pattern", "merge-multiple"]) {
    if (key in object(artifact?.with))
      errors.push("Download primary advisor artifact must not set with." + key);
  }
  checkActionPins(errors, "review-specialists", specialists);
  checkActionPins(errors, "review", review);
  checkActionPins(errors, "publish", publish);
  return errors;
}
