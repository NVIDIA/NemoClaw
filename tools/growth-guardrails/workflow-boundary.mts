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

import { createHash } from "node:crypto";
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

const TRUSTED_JOB_ID = "codebase-growth-guardrails";
const APPROVED_WORKFLOW_ENVELOPE_SHA256 =
  "d3dcbf1a277f7d41fa3ff0357935027be900d866c5b808bb9b31e851d5719968";
const APPROVED_JOB_ENVELOPE_SHA256 =
  "a674580895f5761361f13fc49eecab030694c28a403c98cba38ee24fdfac15f1";

// Hash the complete parsed step object, not only `run`. This binds names, env,
// conditions, action refs and inputs, and execution fields such as `shell`,
// while allowing comments and YAML formatting to change without weakening the
// trust boundary.
const APPROVED_STEP_SHAPES = [
  {
    name: "Block newly added JavaScript files",
    sha256: "c2291c5ea47f093845b8e6bc6a93698fd9fe3f617b5c03265c2803439749ea38",
  },
  {
    name: "Require src/lib/onboard.ts to be net-neutral or smaller",
    sha256: "92aba85cd31e30bfaa9cdd05dde6962f14373b1d60a9121bfcea48146ca0348b",
  },
  {
    name: "Check out the trusted base revision",
    sha256: "ca92ffc6907f8ef3ddcf98eacb19dee0de5b7a76b0520f0ada097fa88b0af3b2",
  },
  {
    name: "Detect guardrail tools on the base revision",
    sha256: "f10b24b97320e991cc060be9f5e98bda2705abd8d0814da123cfd5ca8672a442",
  },
  {
    name: "Install trusted dependencies",
    sha256: "bf5757db70862f1e068748855d97ab5ae6a4a43ebd7ed812baa9f45269bdf6c3",
  },
  {
    name: "Require changed test files to stay within size budget",
    sha256: "eec9020e81cf9d972592cc3129f6656ec0d46618623fb368674e8e823d8c1457",
  },
  {
    name: "Require changed test files not to add if statements",
    sha256: "9aa363162eb2dc6740d9a27c52e6171b2a5587017eb039773a0f4ee0b32f8cde",
  },
] as const;

type WorkflowStep = {
  readonly [key: string]: unknown;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
};

type WorkflowJob = {
  readonly [key: string]: unknown;
  readonly steps?: readonly WorkflowStep[];
  readonly permissions?: Record<string, unknown>;
};

type WorkflowDoc = {
  readonly [key: string]: unknown;
  readonly on?: Record<string, unknown>;
  readonly permissions?: Record<string, unknown>;
  readonly jobs?: Record<string, WorkflowJob>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

function canonicalSha256(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("cannot hash an undefined workflow shape");
  return createHash("sha256").update(serialized).digest("hex");
}

function withoutKey(
  object: Readonly<Record<string, unknown>>,
  excludedKey: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => key !== excludedKey));
}

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

  // 3. Bind the complete execution shape. A substring allowlist is not a trust
  //    boundary: a permitted command can be followed by another executor, and
  //    an extra action or reusable-workflow job has no `run` text to inspect.
  //    The envelopes reject new execution fields, while the ordered full-step
  //    hashes reject missing, duplicate, extra, reordered, or modified steps.
  const workflowEnvelopeHash = canonicalSha256(withoutKey(wf, "jobs"));
  if (workflowEnvelopeHash !== APPROVED_WORKFLOW_ENVELOPE_SHA256) {
    violations.push(
      `workflow envelope must match the approved shape (sha256: ${workflowEnvelopeHash})`,
    );
  }

  const jobs = wf.jobs ?? {};
  const jobIds = Object.keys(jobs);
  if (jobIds.length !== 1 || jobIds[0] !== TRUSTED_JOB_ID) {
    violations.push(
      `workflow jobs must be exactly ${TRUSTED_JOB_ID}, not ${jobIds.join(", ") || "none"}`,
    );
  }

  const trustedJob = jobs[TRUSTED_JOB_ID];
  if (trustedJob) {
    const jobEnvelopeHash = canonicalSha256(withoutKey(trustedJob, "steps"));
    if (jobEnvelopeHash !== APPROVED_JOB_ENVELOPE_SHA256) {
      violations.push(
        `job ${TRUSTED_JOB_ID} envelope must match the approved shape (sha256: ${jobEnvelopeHash})`,
      );
    }

    const jobSteps = trustedJob.steps ?? [];
    if (jobSteps.length !== APPROVED_STEP_SHAPES.length) {
      violations.push(
        `job ${TRUSTED_JOB_ID} must contain exactly ${APPROVED_STEP_SHAPES.length} approved steps, not ${jobSteps.length}`,
      );
    }

    const stepNames = jobSteps.flatMap((step) => (step.name ? [step.name] : []));
    const duplicateNames = [
      ...new Set(stepNames.filter((name, index) => stepNames.indexOf(name) !== index)),
    ];
    if (duplicateNames.length > 0) {
      violations.push(
        `job ${TRUSTED_JOB_ID} must not contain duplicate step names: ${duplicateNames.join(", ")}`,
      );
    }

    for (const [index, approved] of APPROVED_STEP_SHAPES.entries()) {
      const step = jobSteps[index];
      if (!step) continue;
      if (step.name !== approved.name) {
        violations.push(
          `job ${TRUSTED_JOB_ID} step ${index + 1} must be ${approved.name}, not ${step.name ?? "unnamed"}`,
        );
      }
      const stepHash = canonicalSha256(step);
      if (stepHash !== approved.sha256) {
        violations.push(
          `job ${TRUSTED_JOB_ID} step ${step.name ?? index + 1} must match the approved shape (sha256: ${stepHash})`,
        );
      }
    }
  }

  const steps = allSteps(wf);

  // 4. Any checkout must pin the trusted base commit and never the PR head.
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

  // 5. Each policy must still be invoked through its pinned trusted tool.
  const runScripts = steps.flatMap((step) => (step.run ? [step.run] : []));
  const allRun = runScripts.join("\n");
  for (const invocation of REQUIRED_TOOL_INVOCATIONS) {
    if (!allRun.includes(invocation)) {
      violations.push(`workflow must invoke the trusted tool: ${invocation}`);
    }
  }

  // 6. Preserve specific diagnostics for dependency installs and PR-head Git
  //    operations in addition to the exact execution-shape check above.
  for (const script of runScripts) {
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
