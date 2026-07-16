// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Trust-boundary assertions for the codebase growth guardrails workflow.
//
// The workflow runs under pull_request_target, so it executes in the base-repo
// context with a token. It must therefore stay data-only with respect to the
// pull request: inspect PR metadata and blob text, but never check out or
// execute pull-request-controlled code. This module parses the workflow and
// returns a violation string for every broken invariant (empty array = OK), so
// a regression that weakens the boundary fails a unit test rather than shipping.

import { readFileSync } from "node:fs";

import YAML from "yaml";

/** The only ref a checkout in this workflow may use: the trusted base commit. */
export const TRUSTED_BASE_REF = "${{ github.event.pull_request.base.sha }}";

/** The trusted tool entrypoints that replace the former inline node heredocs. */
export const REQUIRED_TOOL_INVOCATIONS = [
  "node --experimental-strip-types tools/growth-guardrails/test-size-budget.mts",
  "node --experimental-strip-types tools/growth-guardrails/test-conditionals.mts",
] as const;

const HEAD_REF_MARKERS = [
  "github.event.pull_request.head",
  "github.head_ref",
  "refs/pull/",
] as const;

// A run step is trusted only if it carries one of these signatures: a data-only
// PR inspection, the tool-detection guard, the pinned dependency install, or a
// pinned trusted tool invocation. Anything else fails closed.
const PERMITTED_RUN_SIGNATURES = [
  "gh api ",
  '>> "$GITHUB_OUTPUT"',
  "npm ci --ignore-scripts",
  ...REQUIRED_TOOL_INVOCATIONS,
] as const;

// Primitives that could fetch or execute PR-controlled code. Forbidden in every
// run step even when the step also carries a permitted signature.
const FORBIDDEN_RUN_SUBSTRINGS = ["| bash", "| sh", "curl ", "wget ", "eval ", "node <<"] as const;

type WorkflowStep = {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
};

type WorkflowJob = {
  readonly steps?: readonly WorkflowStep[];
  readonly permissions?: Record<string, unknown>;
};

type WorkflowDoc = {
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, unknown>;
  readonly jobs?: Record<string, WorkflowJob>;
};

function allSteps(wf: WorkflowDoc): WorkflowStep[] {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

export function validateGrowthGuardrailsWorkflowBoundary(workflowPath: string): string[] {
  const violations: string[] = [];
  const wf = YAML.parse(readFileSync(workflowPath, "utf8")) as WorkflowDoc;

  // 1. Trigger must be pull_request_target (base context) and never the
  //    untrusted pull_request head context.
  const on = wf.on ?? {};
  if (!("pull_request_target" in on)) {
    violations.push("workflow must trigger on pull_request_target");
  }
  if ("pull_request" in on) {
    violations.push(
      "workflow must not trigger on pull_request (runs untrusted head code with a token)",
    );
  }

  // 2. Permissions must stay read-only: a write scope would let PR-influenced
  //    logic mutate the repo.
  const permissions = wf.permissions ?? {};
  if (Object.keys(permissions).length === 0) {
    violations.push("workflow must declare explicit read-only permissions");
  }
  for (const [scope, value] of Object.entries(permissions)) {
    if (value !== "read" && value !== "none") {
      violations.push(`permission ${scope}: ${String(value)} must be read or none, not write`);
    }
  }
  // A job-level permissions block overrides the workflow default, so a write
  // scope there would reopen the boundary even with read-only top-level perms.
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const [scope, value] of Object.entries(job.permissions ?? {})) {
      if (value !== "read" && value !== "none") {
        violations.push(
          `job ${jobId} permission ${scope}: ${String(value)} must be read or none, not write`,
        );
      }
    }
  }

  const steps = allSteps(wf);

  // 3. Any checkout must pin the trusted base commit and never the PR head.
  const checkoutSteps = steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout"));
  if (checkoutSteps.length === 0) {
    violations.push("workflow must check out the trusted base ref to run the guardrail tools");
  }
  for (const step of checkoutSteps) {
    const ref = step.with?.ref;
    if (typeof ref !== "string") {
      violations.push("actions/checkout must pin an explicit ref (the trusted base sha)");
      continue;
    }
    if (ref !== TRUSTED_BASE_REF) {
      violations.push(`actions/checkout ref must be ${TRUSTED_BASE_REF}, not ${ref}`);
    }
    if (HEAD_REF_MARKERS.some((marker) => ref.includes(marker))) {
      violations.push(`actions/checkout must not reference the PR head ref (${ref})`);
    }
  }

  // 4. Each policy must still be invoked through its pinned trusted tool.
  const runScripts = steps.flatMap((step) => (step.run ? [step.run] : []));
  const allRun = runScripts.join("\n");
  for (const invocation of REQUIRED_TOOL_INVOCATIONS) {
    if (!allRun.includes(invocation)) {
      violations.push(`workflow must invoke the trusted tool: ${invocation}`);
    }
  }

  // 5. Fail closed on run steps. Requiring the tool strings to appear somewhere
  //    is not enough: an extra step could fetch and execute PR-controlled code
  //    while the tool strings remain elsewhere. Every run step must carry a
  //    permitted signature and no forbidden execution primitive.
  for (const script of runScripts) {
    const firstLine =
      script
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "";
    if (!PERMITTED_RUN_SIGNATURES.some((signature) => script.includes(signature))) {
      violations.push(
        `run step is not on the trusted allowlist (may execute PR code): ${firstLine}`,
      );
    }
    for (const forbidden of FORBIDDEN_RUN_SUBSTRINGS) {
      if (script.includes(forbidden)) {
        violations.push(
          `run step uses a forbidden execution primitive '${forbidden}': ${firstLine}`,
        );
      }
    }
    for (const line of script.split("\n")) {
      if (/\bnpm (ci|install)\b/.test(line) && !line.includes("--ignore-scripts")) {
        violations.push(`dependency install must use --ignore-scripts: ${line.trim()}`);
      }
      if (
        /\bgit (checkout|fetch|merge)\b/.test(line) &&
        HEAD_REF_MARKERS.some((marker) => line.includes(marker))
      ) {
        violations.push(`must not check out PR head code in a run step: ${line.trim()}`);
      }
    }
  }

  return violations;
}

async function main(): Promise<void> {
  const workflowPath = process.argv[2] ?? ".github/workflows/codebase-growth-guardrails.yaml";
  const violations = validateGrowthGuardrailsWorkflowBoundary(workflowPath);
  if (violations.length > 0) {
    console.error(`FAIL: ${workflowPath} violates the growth-guardrails trust boundary:`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log(`PASS: ${workflowPath} satisfies the growth-guardrails trust boundary.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
