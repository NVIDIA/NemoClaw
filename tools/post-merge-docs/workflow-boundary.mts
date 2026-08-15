#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

import {
  DOCUMENTATION_READINESS_JOB_NAME,
  DOCUMENTATION_READINESS_WORKFLOW_NAME,
  DOCUMENTATION_READINESS_WORKFLOW_PATH,
} from "../../scripts/release/verify-documentation-readiness.mts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW = path.join(ROOT, ".github/workflows/post-merge-docs.yaml");

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function steps(job: unknown): RecordValue[] {
  const value = record(job).steps;
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function contains(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => contains(item, pattern));
  return value && typeof value === "object"
    ? Object.values(value).some((item) => contains(item, pattern))
    : false;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as RecordValue)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function validateJobRuntimeContracts(jobs: RecordValue): string[] {
  const errors: string[] = [];
  const binding = {
    GITHUB_SHA: "${{ github.sha }}",
    RANGE_START_SHA: "${{ needs.discover.outputs.range_start_sha }}",
    RANGE_START_TAG: "${{ needs.discover.outputs.range_start_tag }}",
    ROLLING_HEAD_SHA: "${{ needs.discover.outputs.rolling_head_sha }}",
    ROLLING_PR_NUMBER: "${{ needs.discover.outputs.rolling_pr_number }}",
    TRUSTED_CHECKOUT: "${{ github.workspace }}/trusted",
  };
  const image =
    "ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd";
  const expected = {
    discover: {
      timeout: 10,
      env: {},
      outputs: {
        range_start_tag: "${{ steps.discover.outputs.range_start_tag }}",
        range_start_sha: "${{ steps.discover.outputs.range_start_sha }}",
        rolling_head_sha: "${{ steps.discover.outputs.rolling_head_sha }}",
        rolling_pr_number: "${{ steps.discover.outputs.rolling_pr_number }}",
      },
    },
    analyze: {
      timeout: 40,
      env: {
        ...binding,
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PI_IMAGE: image,
        POST_MERGE_DOCS_ARTIFACT_DIR: "${{ github.workspace }}/analysis-artifact",
        POST_MERGE_DOCS_CONFIG_DIR: "${{ github.workspace }}/config",
        POST_MERGE_DOCS_PHASE: "analyze",
        POST_MERGE_DOCS_WORKDIR: "${{ github.workspace }}/analysis-workdir",
        SANDBOX_NAME: "docs-main-author",
      },
      outputs: { candidate_artifact_id: "${{ steps.upload.outputs.artifact-id }}" },
    },
    validate: {
      timeout: 30,
      env: {
        ...binding,
        POST_MERGE_DOCS_CANDIDATE_DIR: "${{ github.workspace }}/candidate-artifact",
        POST_MERGE_DOCS_CONFIG_DIR: "${{ github.workspace }}/validation-config",
        POST_MERGE_DOCS_PHASE: "review",
        POST_MERGE_DOCS_WORKDIR: "${{ github.workspace }}/validation-workdir",
      },
      outputs: {},
    },
    review: {
      timeout: 40,
      env: {
        ...binding,
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PI_IMAGE: image,
        POST_MERGE_DOCS_ARTIFACT_DIR: "${{ github.workspace }}/reviewed-artifact",
        POST_MERGE_DOCS_CANDIDATE_DIR: "${{ github.workspace }}/candidate-artifact",
        POST_MERGE_DOCS_CONFIG_DIR: "${{ github.workspace }}/config",
        POST_MERGE_DOCS_PHASE: "review",
        POST_MERGE_DOCS_WORKDIR: "${{ github.workspace }}/review-workdir",
        SANDBOX_NAME: "docs-main-review",
      },
      outputs: { approved_artifact_id: "${{ steps.upload.outputs.artifact-id }}" },
    },
    publish: {
      timeout: 10,
      env: {
        ...binding,
        POST_MERGE_DOCS_ARTIFACT_DIR: "${{ github.workspace }}/approved-artifact",
      },
      outputs: {
        covered_sha: "${{ steps.publish.outputs.covered_sha }}",
        pr_number: "${{ steps.publish.outputs.pr_number }}",
        pr_url: "${{ steps.publish.outputs.pr_url }}",
        status: "${{ steps.publish.outputs.status }}",
      },
    },
    readiness: { timeout: 5, env: {}, outputs: {} },
  };
  for (const [jobName, contract] of Object.entries(expected)) {
    const job = record(jobs[jobName]);
    if (
      job["runs-on"] !== "ubuntu-24.04" ||
      job["timeout-minutes"] !== contract.timeout ||
      !sameValue(record(job.env), contract.env) ||
      !sameValue(record(job.outputs), contract.outputs)
    ) {
      errors.push(`${jobName} runtime, environment, and outputs must match the trusted contract`);
    }
  }
  if (record(jobs.discover).if !== "${{ github.repository == 'NVIDIA/NemoClaw' }}") {
    errors.push("discovery must run only in the canonical repository");
  }
  return errors;
}

function validateWorkflowHeader(workflow: RecordValue): string[] {
  const errors: string[] = [];
  const topLevelKeys = new Set(["name", "on", "permissions", "concurrency", "jobs"]);
  if (Object.keys(workflow).some((key) => !topLevelKeys.has(key))) {
    errors.push("workflow contains a key outside the trusted top-level contract");
  }
  if (DOCUMENTATION_READINESS_WORKFLOW_PATH !== ".github/workflows/post-merge-docs.yaml") {
    errors.push("release verifier workflow path must match the post-merge docs workflow");
  }
  if (workflow.name !== DOCUMENTATION_READINESS_WORKFLOW_NAME) {
    errors.push("workflow name must match the release verifier");
  }
  if ("run-name" in workflow) errors.push("workflow must not set run-name");
  if (!sameValue(workflow.on, { push: { branches: ["main"] } })) {
    errors.push("workflow must have exactly one main push trigger");
  }
  if (Object.keys(record(workflow.permissions)).length !== 0) {
    errors.push("top-level permissions must be empty");
  }
  const concurrency = record(workflow.concurrency);
  if (concurrency.group !== "post-merge-docs-main" || concurrency["cancel-in-progress"] !== false) {
    errors.push("workflow must serialize main runs without canceling an active publisher");
  }
  return errors;
}

export function validateWorkflowBoundary(
  file = DEFAULT_WORKFLOW,
  policyDirectory = path.join(ROOT, "tools/post-merge-docs"),
): string[] {
  const workflow = record(YAML.parse(fs.readFileSync(file, "utf8")));
  const errors = validateWorkflowHeader(workflow);
  const jobs = record(workflow.jobs);
  errors.push(...validateJobRuntimeContracts(jobs));
  const expectedJobs = ["discover", "analyze", "validate", "review", "publish", "readiness"];
  for (const name of expectedJobs) {
    if (!(name in jobs)) errors.push(`workflow is missing the ${name} job`);
  }
  if (Object.keys(jobs).some((name) => !expectedJobs.includes(name)))
    errors.push("workflow contains an unexpected job");
  const analyze = record(jobs.analyze);
  const validate = record(jobs.validate);
  const review = record(jobs.review);
  const publish = record(jobs.publish);
  const readiness = record(jobs.readiness);
  const expectedStepNames: Record<string, string[]> = {
    discover: ["Checkout exact main state", "Setup Node", "Bind the tag range and rolling PR"],
    analyze: [
      "Checkout trusted authoring code",
      "Setup Node",
      "Prepare the combined documentation state",
      "Install OpenShell",
      "Configure isolated inference",
      "Create the authoring sandbox",
      "Author the documentation result",
      "Export the bounded candidate artifact",
      "Delete the authoring sandbox",
      "Upload the candidate artifact",
    ],
    validate: [
      "Checkout trusted validation code",
      "Setup Node",
      "Download the same-run candidate artifact",
      "Prepare the candidate for docs validation",
      "Install docs validation dependencies",
      "Build the complete candidate documentation",
    ],
    review: [
      "Checkout trusted review code",
      "Setup Node",
      "Download the same-run candidate artifact",
      "Prepare the reviewed candidate",
      "Install OpenShell",
      "Configure isolated inference",
      "Create the read-only review sandbox",
      "Independently review the complete result",
      "Export the approved artifact",
      "Delete the review sandbox",
      "Upload the approved artifact",
    ],
    publish: [
      "Checkout the trusted publisher",
      "Setup Node",
      "Download the same-run approved artifact",
      "Validate and publish the documentation state",
    ],
    readiness: ["Accept the exact main commit", "Reject incomplete documentation state"],
  };
  const checkoutPin = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  const setupNodePin = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
  const uploadPin = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
  const downloadPin = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
  const modelCommand = (command: string): string =>
    `node --experimental-strip-types --no-warnings "$TRUSTED_CHECKOUT/tools/post-merge-docs/model.mts" ${command}`;
  const installOpenShell =
    'env -u GITHUB_TOKEN -u GH_TOKEN -u OPENAI_API_KEY -u PR_REVIEW_ADVISOR_API_KEY \\\n  NEMOCLAW_NON_INTERACTIVE=1 \\\n  bash "$TRUSTED_CHECKOUT/scripts/install-openshell.sh"\n';
  const expectedRuns: Record<string, Record<string, string>> = {
    discover: {
      "Bind the tag range and rolling PR":
        'node --experimental-strip-types --no-warnings "$TRUSTED_CHECKOUT/tools/post-merge-docs/discover.mts"',
    },
    analyze: {
      "Prepare the combined documentation state": modelCommand("prepare"),
      "Install OpenShell": installOpenShell,
      "Configure isolated inference": modelCommand("configure"),
      "Create the authoring sandbox": modelCommand("create"),
      "Author the documentation result": modelCommand("run"),
      "Export the bounded candidate artifact": modelCommand("export"),
      "Delete the authoring sandbox": modelCommand("delete"),
    },
    validate: {
      "Prepare the candidate for docs validation": modelCommand("prepare"),
      "Install docs validation dependencies": "npm ci --ignore-scripts --no-audit --no-fund",
      "Build the complete candidate documentation": "npm run docs:validate",
    },
    review: {
      "Prepare the reviewed candidate": modelCommand("prepare"),
      "Install OpenShell": installOpenShell,
      "Configure isolated inference": modelCommand("configure"),
      "Create the read-only review sandbox": modelCommand("create"),
      "Independently review the complete result": modelCommand("run"),
      "Export the approved artifact": modelCommand("export"),
      "Delete the review sandbox": modelCommand("delete"),
    },
    publish: {
      "Validate and publish the documentation state":
        'node --experimental-strip-types --no-warnings "$TRUSTED_CHECKOUT/tools/post-merge-docs/publish.mts"',
    },
    readiness: {
      "Accept the exact main commit": 'echo "Documentation is current for $GITHUB_SHA."',
      "Reject incomplete documentation state": `if [[ "$STATUS" == "pr_pending" && "$COVERED_SHA" == "$GITHUB_SHA" ]]; then
  echo "::error::Documentation work remains in rolling documentation PR #\${PR_NUMBER:-unknown}."
else
  echo "::error::The exact main commit does not have a completed approved documentation result."
fi
exit 1
`,
    },
  };
  const expectedStepMetadata: Record<string, Record<string, RecordValue>> = {
    discover: {
      "Bind the tag range and rolling PR": {
        id: "discover",
        env: {
          GITHUB_TOKEN: "${{ github.token }}",
          TRUSTED_CHECKOUT: "${{ github.workspace }}/trusted",
        },
      },
    },
    analyze: {
      "Prepare the combined documentation state": { id: "prepare" },
      "Configure isolated inference": {
        env: { OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" },
      },
      "Export the bounded candidate artifact": {
        id: "export",
        env: { POST_MERGE_DOCS_BASE_TREE_SHA: "${{ steps.prepare.outputs.base_tree_sha }}" },
      },
      "Delete the authoring sandbox": { if: "always()" },
      "Upload the candidate artifact": {
        id: "upload",
        if: "${{ steps.export.outcome == 'success' }}",
      },
    },
    validate: {
      "Prepare the candidate for docs validation": { id: "prepare" },
      "Install docs validation dependencies": {
        "working-directory": "validation-workdir/repo",
      },
      "Build the complete candidate documentation": {
        "working-directory": "validation-workdir/repo",
      },
    },
    review: {
      "Prepare the reviewed candidate": { id: "prepare" },
      "Configure isolated inference": {
        env: { OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" },
      },
      "Export the approved artifact": {
        id: "export",
        env: { POST_MERGE_DOCS_BASE_TREE_SHA: "${{ steps.prepare.outputs.base_tree_sha }}" },
      },
      "Delete the review sandbox": { if: "always()" },
      "Upload the approved artifact": {
        id: "upload",
        if: "${{ steps.export.outcome == 'success' }}",
      },
    },
    publish: {
      "Validate and publish the documentation state": {
        id: "publish",
        env: { GITHUB_TOKEN: "${{ github.token }}" },
      },
    },
    readiness: {
      "Accept the exact main commit": {
        if: "${{ needs.publish.result == 'success' && needs.publish.outputs.status == 'no_changes' && needs.publish.outputs.covered_sha == github.sha }}",
      },
      "Reject incomplete documentation state": {
        if: "${{ !(needs.publish.result == 'success' && needs.publish.outputs.status == 'no_changes' && needs.publish.outputs.covered_sha == github.sha) }}",
        env: {
          COVERED_SHA: "${{ needs.publish.outputs.covered_sha }}",
          PR_NUMBER: "${{ needs.publish.outputs.pr_number }}",
          STATUS: "${{ needs.publish.outputs.status }}",
        },
      },
    },
  };
  const allowedJobKeys = new Set([
    "name",
    "needs",
    "if",
    "runs-on",
    "timeout-minutes",
    "permissions",
    "outputs",
    "env",
    "steps",
  ]);
  const allowedStepKeys = new Set([
    "name",
    "id",
    "if",
    "uses",
    "with",
    "env",
    "run",
    "working-directory",
  ]);
  for (const [jobName, names] of Object.entries(expectedStepNames)) {
    if (Object.keys(record(jobs[jobName])).some((key) => !allowedJobKeys.has(key))) {
      errors.push(`${jobName} job contains a key outside the trusted job contract`);
    }
    const actualSteps = steps(jobs[jobName]);
    if (
      !sameValue(
        actualSteps.map((step) => step.name),
        names,
      )
    ) {
      errors.push(`${jobName} steps must match the trusted step allowlist`);
    }
    for (const step of actualSteps) {
      const stepName = text(step.name);
      if (Object.keys(step).some((key) => !allowedStepKeys.has(key))) {
        errors.push(
          `${jobName} step contains a key outside the trusted step contract: ${stepName}`,
        );
      }
      const expectedAction = stepName.startsWith("Checkout ")
        ? checkoutPin
        : stepName === "Setup Node"
          ? setupNodePin
          : stepName.startsWith("Upload ")
            ? uploadPin
            : stepName.startsWith("Download ")
              ? downloadPin
              : "";
      if (expectedAction ? step.uses !== expectedAction : "uses" in step) {
        errors.push(`${jobName} step action must match the trusted action allowlist: ${stepName}`);
      }
      if (!expectedAction && step.run !== expectedRuns[jobName]?.[stepName]) {
        errors.push(`${jobName} run step must match the trusted command contract: ${stepName}`);
      }
      const metadata = Object.fromEntries(
        ["id", "if", "env", "working-directory"]
          .filter((key) => key in step)
          .map((key) => [key, step[key]]),
      );
      if (!sameValue(metadata, expectedStepMetadata[jobName]?.[stepName] ?? {})) {
        errors.push(`${jobName} step metadata must match the trusted contract: ${stepName}`);
      }
    }
  }
  const expectedPermissions: Record<string, RecordValue> = {
    discover: { contents: "read", "pull-requests": "read" },
    analyze: { contents: "read" },
    validate: { actions: "read", contents: "read" },
    review: { actions: "read", contents: "read" },
    publish: { actions: "read", contents: "write", "pull-requests": "write" },
    readiness: {},
  };
  for (const [jobName, expected] of Object.entries(expectedPermissions)) {
    if (JSON.stringify(record(record(jobs[jobName]).permissions)) !== JSON.stringify(expected)) {
      errors.push(`${jobName} permissions must match the least-privilege contract`);
    }
  }
  for (const [name, job] of [
    ["analyze", analyze],
    ["review", review],
  ] as const) {
    const permissions = record(job.permissions);
    if (Object.values(permissions).some((value) => value === "write")) {
      errors.push(`${name} job must not receive GitHub write permission`);
    }
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    const permissions = record(record(job).permissions);
    for (const [permission, value] of Object.entries(permissions)) {
      if (
        value === "write" &&
        (jobName !== "publish" || !["contents", "pull-requests"].includes(permission))
      ) {
        errors.push(`only publish may write contents or pull requests: ${jobName}.${permission}`);
      }
    }
  }
  const secretOccurrences =
    JSON.stringify(workflow).match(/\$\{\{[^}]*\bsecrets\b[^}]*\}\}/gu)?.length ?? 0;
  if (secretOccurrences !== 2)
    errors.push("workflow must have exactly two configure-only model secret uses");
  if (contains(publish, /\$\{\{\s*secrets(?:\.|\[)/u))
    errors.push("publisher must not receive a model credential");
  if (contains(publish, /(?:openshell|pi-coding-agent|model\.mts|npm\s|npm run docs)/iu))
    errors.push("publisher must not run model, docs, package, or OpenShell commands");
  if (
    contains(validate, /\$\{\{\s*secrets(?:\.|\[)/u) ||
    contains(validate, /(?:openshell|pi-coding-agent)/iu)
  ) {
    errors.push("validation job must remain credential-free and must not run a model");
  }
  if (contains(review, /npm (?:ci|run docs)/iu)) {
    errors.push("model review job must not execute candidate documentation code");
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of steps(job)) {
      const uses = text(step.uses);
      if (uses && !/^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/u.test(uses)) {
        errors.push(`${jobName} uses an action that is not pinned to a commit SHA`);
      }
      if (contains(step, /\$\{\{\s*secrets(?:\.|\[)/u)) {
        if (
          !["analyze", "review"].includes(jobName) ||
          step.name !== "Configure isolated inference" ||
          record(step.env).OPENAI_API_KEY !== "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}"
        ) {
          errors.push("model secret may appear only on isolated inference configure steps");
        }
      }
      if (step.name === "Configure isolated inference") {
        if (
          JSON.stringify(record(step.env)) !==
          JSON.stringify({ OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" })
        ) {
          errors.push("configure step environment must contain only the model credential");
        }
      }
      if (/actions\/checkout@/u.test(uses)) {
        const withValue = record(step.with);
        if (
          !sameValue(withValue, {
            "fetch-depth": 0,
            lfs: false,
            path: "trusted",
            "persist-credentials": false,
            ref: "${{ github.sha }}",
            submodules: false,
          })
        ) {
          errors.push(`${jobName} checkout must bind exact main without persisted credentials`);
        }
      }
      if (/actions\/setup-node@/u.test(uses)) {
        const expected =
          jobName === "validate"
            ? {
                cache: "npm",
                "cache-dependency-path": "trusted/package-lock.json",
                "node-version": "22",
              }
            : { "node-version": "22" };
        if (!sameValue(record(step.with), expected)) {
          errors.push(`${jobName} Node setup must match the trusted runtime contract`);
        }
      }
      if (/actions\/download-artifact@/u.test(uses)) {
        const withValue = record(step.with);
        for (const key of [
          "name",
          "run-id",
          "github-token",
          "repository",
          "pattern",
          "merge-multiple",
        ]) {
          if (key in withValue)
            errors.push(
              `${jobName} artifact download must use one immutable ID from the same workflow run`,
            );
        }
      }
    }
  }
  const publisherStep = steps(publish).find((step) => step.id === "publish");
  if (!text(publisherStep?.run).includes("$TRUSTED_CHECKOUT/tools/post-merge-docs/publish.mts")) {
    errors.push("publisher must execute the trusted post-merge docs publisher");
  }
  if (steps(publish).filter((step) => text(step.run) !== "").length !== 1) {
    errors.push("publisher may execute only the trusted publisher command");
  }
  const validationSteps = steps(validate);
  const installValidation = validationSteps.find(
    (step) => step.name === "Install docs validation dependencies",
  );
  const runValidation = validationSteps.find(
    (step) => step.name === "Build the complete candidate documentation",
  );
  if (
    installValidation?.run !== "npm ci --ignore-scripts --no-audit --no-fund" ||
    installValidation["working-directory"] !== "validation-workdir/repo" ||
    runValidation?.run !== "npm run docs:validate" ||
    runValidation["working-directory"] !== "validation-workdir/repo"
  ) {
    errors.push("validation must install safely and run the non-mutating docs validator");
  }
  if (
    JSON.stringify(publish.needs) !==
      JSON.stringify(["discover", "analyze", "validate", "review"]) ||
    text(publish.if) !==
      "${{ needs.discover.result == 'success' && needs.analyze.result == 'success' && needs.validate.result == 'success' && needs.review.result == 'success' }}"
  ) {
    errors.push("publisher must require successful discovery, analysis, and review jobs");
  }
  if (
    analyze.needs !== "discover" ||
    text(analyze.if) !== "${{ needs.discover.result == 'success' }}"
  ) {
    errors.push("analysis must require successful discovery");
  }
  if (
    JSON.stringify(validate.needs) !== JSON.stringify(["discover", "analyze"]) ||
    text(validate.if) !==
      "${{ needs.discover.result == 'success' && needs.analyze.result == 'success' }}"
  ) {
    errors.push("validation must require successful discovery and analysis");
  }
  if (
    JSON.stringify(review.needs) !== JSON.stringify(["discover", "analyze"]) ||
    text(review.if) !==
      "${{ needs.discover.result == 'success' && needs.analyze.result == 'success' }}"
  ) {
    errors.push("model review must run in parallel with credential-free validation");
  }
  const downloadContracts = new Map<string, { artifactId: string; path: string }>([
    [
      "validate",
      {
        artifactId: "${{ needs.analyze.outputs.candidate_artifact_id }}",
        path: "candidate-artifact",
      },
    ],
    [
      "review",
      {
        artifactId: "${{ needs.analyze.outputs.candidate_artifact_id }}",
        path: "candidate-artifact",
      },
    ],
    [
      "publish",
      {
        artifactId: "${{ needs.review.outputs.approved_artifact_id }}",
        path: "approved-artifact",
      },
    ],
  ]);
  for (const [jobName, expected] of downloadContracts) {
    const download = steps(record(jobs[jobName])).find((step) =>
      text(step.uses).startsWith("actions/download-artifact@"),
    );
    if (
      JSON.stringify(record(download?.with)) !==
      JSON.stringify({ "artifact-ids": expected.artifactId, path: expected.path })
    ) {
      errors.push(`${jobName} must download only its exact same-run immutable artifact ID`);
    }
  }
  if (readiness.name !== DOCUMENTATION_READINESS_JOB_NAME)
    errors.push("terminal job name must match the release verifier");
  if (text(readiness.if) !== "${{ !cancelled() && github.repository == 'NVIDIA/NemoClaw' }}") {
    errors.push("readiness must run after every non-cancelled canonical workflow result");
  }
  const readinessText = JSON.stringify(readiness);
  if (
    !readinessText.includes("no_changes") ||
    !readinessText.includes("covered_sha") ||
    !readinessText.includes("github.sha")
  ) {
    errors.push("readiness must accept only a no-change result for the exact main commit");
  }
  if (!contains(readiness, /exit 1/u))
    errors.push("readiness must fail while documentation work remains");
  const readinessSteps = steps(readiness);
  if (
    JSON.stringify(readiness.needs) !==
    JSON.stringify(["discover", "analyze", "validate", "review", "publish"])
  ) {
    errors.push("readiness must depend on every post-merge documentation job");
  }
  if (
    text(readinessSteps[0]?.if) !==
      "${{ needs.publish.result == 'success' && needs.publish.outputs.status == 'no_changes' && needs.publish.outputs.covered_sha == github.sha }}" ||
    text(readinessSteps[1]?.if) !==
      "${{ !(needs.publish.result == 'success' && needs.publish.outputs.status == 'no_changes' && needs.publish.outputs.covered_sha == github.sha) }}"
  ) {
    errors.push("readiness accept and reject expressions must be exact complements");
  }
  for (const phaseName of ["analyze", "review"] as const) {
    const phaseSteps = steps(record(jobs[phaseName]));
    const exportStep = phaseSteps.find((step) => step.id === "export");
    if (
      record(exportStep?.env).POST_MERGE_DOCS_BASE_TREE_SHA !==
      "${{ steps.prepare.outputs.base_tree_sha }}"
    ) {
      errors.push(`${phaseName} export must bind the prepared base tree SHA`);
    }
    const sandboxName = text(
      record(jobs[phaseName]).env && record(record(jobs[phaseName]).env).SANDBOX_NAME,
    );
    if (sandboxName.length === 0 || sandboxName.length > 19)
      errors.push(`${phaseName} sandbox name must contain 1..19 characters`);
  }
  const artifactContracts = [
    [
      "analyze",
      "candidate_artifact_id",
      "post-merge-docs-candidate",
      "${{ env.POST_MERGE_DOCS_ARTIFACT_DIR }}/",
    ],
    [
      "review",
      "approved_artifact_id",
      "post-merge-docs-approved",
      "${{ env.POST_MERGE_DOCS_ARTIFACT_DIR }}/",
    ],
  ] as const;
  for (const [jobName, outputName, name, artifactPath] of artifactContracts) {
    const upload = steps(record(jobs[jobName])).find((step) =>
      text(step.uses).startsWith("actions/upload-artifact@"),
    );
    const withValue = record(upload?.with);
    if (
      upload?.id !== "upload" ||
      JSON.stringify(record(record(jobs[jobName]).outputs)) !==
        JSON.stringify({ [outputName]: "${{ steps.upload.outputs.artifact-id }}" }) ||
      withValue.name !== name ||
      withValue.path !== artifactPath ||
      withValue.overwrite !== true ||
      withValue["if-no-files-found"] !== "error"
    ) {
      errors.push(`${jobName} upload must match the immutable artifact contract`);
    }
  }
  for (const phaseName of ["analyze", "review"] as const) {
    const policy = record(
      YAML.parse(fs.readFileSync(path.join(policyDirectory, `${phaseName}-policy.yaml`), "utf8")),
    );
    const expectedReadOnly =
      phaseName === "analyze"
        ? ["/usr/bin", "/usr/lib", "/usr/share/git-core", "/etc", "/sandbox/config"]
        : [
            "/usr/bin",
            "/usr/lib",
            "/usr/share/git-core",
            "/etc",
            "/sandbox/config",
            "/sandbox/repo",
            "/sandbox/input",
          ];
    const expectedReadWrite =
      phaseName === "analyze"
        ? ["/dev", "/sandbox/repo", "/sandbox/runtime"]
        : ["/dev", "/sandbox/runtime"];
    const expectedPolicy = {
      version: 1,
      filesystem_policy: {
        include_workdir: false,
        read_only: expectedReadOnly,
        read_write: expectedReadWrite,
      },
      landlock: { compatibility: "hard_requirement" },
      process: { run_as_user: "sandbox", run_as_group: "sandbox" },
      network_policies: {},
    };
    if (!sameValue(policy, expectedPolicy)) {
      errors.push(`${phaseName} policy must match the exact isolated phase contract`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = validateWorkflowBoundary(process.argv[2]);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log("Post-merge documentation workflow boundary passed.");
}
