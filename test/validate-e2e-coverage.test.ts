// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate that nightly-e2e.yaml remains internally consistent.
 *
 * Catches:
 * - Nightly E2E jobs missing the selective dispatch guard in their `if:` condition
 * - Aggregate reporting/notification jobs missing real E2E jobs in their `needs` lists
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a YAML file and return the raw object. */
function loadYaml(relPath: string): Record<string, unknown> {
  const text = readFileSync(repoPath(relPath), "utf-8");
  return YAML.parse(text) as Record<string, unknown>;
}

/**
 * Extract all E2E job names from the nightly-e2e.yaml workflow.
 * A job is any top-level key under `jobs:` except infrastructure jobs
 * (`notify-on-failure`, `report-to-pr`).
 */
function getNightlyJobNames(workflow: Record<string, unknown>): string[] {
  const jobs = workflow.jobs as Record<string, unknown> | undefined;
  if (!jobs) return [];
  const infra = new Set(["notify-on-failure", "report-to-pr", "scorecard"]);
  return Object.keys(jobs).filter((name) => !infra.has(name));
}

function getJobNeeds(job: unknown): string[] {
  if (typeof job !== "object" || job === null) return [];
  const needs = (job as Record<string, unknown>).needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) {
    return needs.filter((name): name is string => typeof name === "string");
  }
  return [];
}

/**
 * Extract the `if:` condition string from a workflow job object.
 */
function getJobIf(job: unknown): string | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const record = job as Record<string, unknown>;
  if (typeof record.if === "string") return record.if;
  return undefined;
}

function getJobStep(job: unknown, stepName: string): Record<string, unknown> | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const steps = (job as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return undefined;
  return steps.find(
    (step): step is Record<string, unknown> =>
      typeof step === "object" &&
      step !== null &&
      (step as Record<string, unknown>).name === stepName,
  );
}

function getStepEnv(job: unknown, stepName: string): Record<string, unknown> | undefined {
  const step = getJobStep(job, stepName);
  if (!step || typeof step.env !== "object" || step.env === null) return undefined;
  return step.env as Record<string, unknown>;
}

function getCheckoutStep(job: unknown): Record<string, unknown> | undefined {
  if (typeof job !== "object" || job === null) return undefined;
  const steps = (job as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return undefined;
  return steps.find((step): step is Record<string, unknown> => {
    if (typeof step !== "object" || step === null) return false;
    const uses = (step as Record<string, unknown>).uses;
    return typeof uses === "string" && uses.startsWith("actions/checkout");
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("nightly E2E workflow validation", () => {
  const workflow = loadYaml(".github/workflows/nightly-e2e.yaml");
  const reusableRunner = loadYaml(".github/workflows/e2e-script.yaml");

  const nightlyJobs = getNightlyJobNames(workflow);
  const aggregateJobs = ["notify-on-failure", "report-to-pr", "scorecard"];

  it("every nightly E2E job has the selective dispatch guard in its if: condition", () => {
    const jobs = workflow.jobs as Record<string, unknown>;
    const missing: string[] = [];

    for (const name of nightlyJobs) {
      const job = jobs[name];
      const condition = getJobIf(job);
      if (!condition) {
        missing.push(`${name} (no if: condition)`);
        continue;
      }
      // Check for the full selective dispatch pattern:
      // (github.event_name != 'workflow_dispatch' ||
      //  inputs.jobs == '' ||
      //  contains(format(',{0},', inputs.jobs), ',<job-name>,'))
      const hasDispatchBypass = condition.includes(
        "github.event_name != 'workflow_dispatch'",
      );
      const hasEmptySelectionBypass = condition.includes("inputs.jobs == ''");
      const hasExactJobMatch = condition.includes(
        `contains(format(',{0},', inputs.jobs), ',${name},')`,
      );
      if (!(hasDispatchBypass && hasEmptySelectionBypass && hasExactJobMatch)) {
        missing.push(name);
      }
    }

    expect(
      missing,
      `Nightly E2E jobs missing the selective dispatch guard in their ` +
        `if: condition: ${missing.join(", ")}. Each job needs:\n` +
        `  (github.event_name != 'workflow_dispatch' ||\n` +
        `   inputs.jobs == '' ||\n` +
        `   contains(format(',{0},', inputs.jobs), ',<job-name>,'))`,
    ).toEqual([]);
  });

  it("every aggregate job depends on every nightly E2E job", () => {
    const jobs = workflow.jobs as Record<string, unknown>;
    const missing: string[] = [];

    for (const aggregateJob of aggregateJobs) {
      const needs = new Set(getJobNeeds(jobs[aggregateJob]));
      for (const nightlyJob of nightlyJobs) {
        if (!needs.has(nightlyJob)) {
          missing.push(`${aggregateJob} -> ${nightlyJob}`);
        }
      }
    }

    expect(
      missing,
      `Nightly E2E aggregate jobs missing real E2E jobs in needs: ` +
        `${missing.join(", ")}. Update notify-on-failure, report-to-pr, ` +
        `and scorecard so their needs lists include every nightly E2E job.`,
    ).toEqual([]);
  });

  it("public installer E2Es install the resolved checkout ref", () => {
    const jobs = workflow.jobs as Record<string, unknown>;
    const expectedCheckoutRef = "${{ inputs.target_ref || github.ref }}";
    const expectedTrustedWorkflowRef = "${{ github.ref }}";
    const expectedInstallRef = "${{ steps.public_install_ref.outputs.ref }}";
    const publicInstallerJobs: Array<{
      jobName: string;
      stepName: string;
      privilegedTrustedScript?: boolean;
    }> = [
      { jobName: "cloud-onboard-e2e", stepName: "Run cloud onboard E2E test" },
      {
        jobName: "openclaw-tui-chat-correlation-e2e",
        stepName: "Run OpenClaw TUI chat correlation E2E test",
      },
      {
        jobName: "issue-4434-tui-unreachable-inference-e2e",
        stepName: "Run issue #4434 TUI unreachable inference E2E test",
        privilegedTrustedScript: true,
      },
    ];
    const invalid: string[] = [];

    const runnerJobs = reusableRunner.jobs as Record<string, unknown>;
    const reusableRefExporter = getJobStep(
      runnerJobs.run,
      "Export checked-out ref environment",
    );
    if (
      typeof reusableRefExporter?.run !== "string" ||
      !reusableRefExporter.run.includes("git -C repo rev-parse HEAD")
    ) {
      invalid.push("reusable runner missing checked-out ref exporter");
    }

    for (const { jobName, stepName, privilegedTrustedScript = false } of publicInstallerJobs) {
      const job = jobs[jobName] as Record<string, unknown> | undefined;
      const jobWith = job?.with as Record<string, unknown> | undefined;

      if (job?.uses === "./.github/workflows/e2e-script.yaml") {
        if (jobWith?.ref !== expectedCheckoutRef) {
          invalid.push(`${jobName} with.ref=${String(jobWith?.ref)}`);
        }
        if (jobWith?.checked_out_ref_env !== "NEMOCLAW_PUBLIC_INSTALL_REF") {
          invalid.push(
            `${jobName} checked_out_ref_env=${String(jobWith?.checked_out_ref_env)}`,
          );
        }
        if (typeof jobWith?.env_json === "string") {
          const env = JSON.parse(jobWith.env_json) as Record<string, unknown>;
          if (env.NEMOCLAW_PUBLIC_INSTALL_REF !== undefined) {
            invalid.push(`${jobName} hard-codes NEMOCLAW_PUBLIC_INSTALL_REF in env_json`);
          }
          if (env.NEMOCLAW_INSTALL_REF === "${{ github.ref_name }}") {
            invalid.push(`${jobName} still pins public install to github.ref_name`);
          }
        }
        continue;
      }

      const checkoutWith = getCheckoutStep(job)?.with as Record<string, unknown> | undefined;
      const expectedJobCheckoutRef = privilegedTrustedScript
        ? expectedTrustedWorkflowRef
        : expectedCheckoutRef;
      if (checkoutWith?.ref !== expectedJobCheckoutRef) {
        invalid.push(`${jobName} checkout.ref=${String(checkoutWith?.ref)}`);
      }

      const resolver = getJobStep(
        job,
        privilegedTrustedScript ? "Resolve trusted public install ref" : "Resolve public install ref",
      );
      if (!resolver) {
        invalid.push(`${jobName} missing resolved-ref step`);
      } else {
        if (resolver.id !== "public_install_ref") {
          invalid.push(`${jobName} resolved-ref id=${String(resolver.id)}`);
        }
        const run = typeof resolver.run === "string" ? resolver.run : "";
        if (privilegedTrustedScript) {
          const env = resolver.env as Record<string, unknown> | undefined;
          if (env?.TARGET_REF !== "${{ inputs.target_ref }}") {
            invalid.push(`${jobName} resolved-ref TARGET_REF=${String(env?.TARGET_REF)}`);
          }
          if (!run.includes("trusted_head=\"$(git rev-parse HEAD)\"")) {
            invalid.push(`${jobName} resolved-ref step does not derive trusted HEAD`);
          }
          if (!run.includes("git merge-base --is-ancestor")) {
            invalid.push(`${jobName} resolved-ref step does not validate ref reachability`);
          }
        } else if (!run.includes("git rev-parse HEAD")) {
          invalid.push(`${jobName} resolved-ref step does not use git rev-parse HEAD`);
        }
      }

      const env = getStepEnv(job, stepName);
      if (!env) {
        invalid.push(`${jobName} (${stepName} missing env)`);
        continue;
      }
      if (env.NEMOCLAW_PUBLIC_INSTALL_REF !== expectedInstallRef) {
        invalid.push(
          `${jobName} NEMOCLAW_PUBLIC_INSTALL_REF=${String(env.NEMOCLAW_PUBLIC_INSTALL_REF)}`,
        );
      }
      if (env.NEMOCLAW_INSTALL_REF === "${{ github.ref_name }}") {
        invalid.push(`${jobName} still pins public install to github.ref_name`);
      }
    }

    expect(
      invalid,
      `Public installer E2Es must resolve the checked-out ref once and pass that SHA ` +
        `through to the curl-install path; otherwise trusted dispatch can check out one ` +
        `commit but install another. ` +
        `Invalid jobs: ${invalid.join(", ")}`,
    ).toEqual([]);
  });

  it("messaging providers nightly can receive optional live message secrets", () => {
    const expectedSecretNames = [
      "TELEGRAM_BOT_TOKEN_REAL",
      "TELEGRAM_CHAT_ID_E2E",
      "DISCORD_BOT_TOKEN_REAL",
      "DISCORD_CHANNEL_ID_E2E",
      "SLACK_BOT_TOKEN_REAL",
      "SLACK_APP_TOKEN_REAL",
      "SLACK_CHANNEL_ID_E2E",
    ];

    const missing: string[] = [];
    const reusableSecrets =
      ((reusableRunner.on as Record<string, unknown> | undefined)?.workflow_call as
        | Record<string, unknown>
        | undefined) ?? {};
    const reusableSecretDefs =
      (reusableSecrets.secrets as Record<string, unknown> | undefined) ?? {};
    const runnerJobs = (reusableRunner.jobs as Record<string, unknown> | undefined) ?? {};
    const runStepEnv = getStepEnv(runnerJobs.run, "Run E2E script") ?? {};
    const jobs = (workflow.jobs as Record<string, unknown> | undefined) ?? {};
    const messagingJob = jobs["messaging-providers-e2e"] as
      | Record<string, unknown>
      | undefined;
    if (!messagingJob) {
      missing.push("nightly job messaging-providers-e2e");
    }
    const messagingSecrets =
      (messagingJob?.secrets as Record<string, unknown> | undefined) ?? {};

    for (const name of expectedSecretNames) {
      if (!reusableSecretDefs[name]) {
        missing.push(`workflow_call.secrets.${name}`);
      }
      if (runStepEnv[name] !== `\${{ secrets.${name} }}`) {
        missing.push(`e2e-script Run E2E script env.${name}`);
      }
      if (messagingSecrets[name] !== `\${{ secrets.${name} }}`) {
        missing.push(`nightly messaging-providers-e2e secrets.${name}`);
      }
    }

    expect(
      missing,
      `messaging-providers-e2e must pass optional live-message credentials and ` +
        `targets through the reusable runner so Phase 6 can exercise ` +
        `openclaw message send when repository secrets are configured. ` +
        `Missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
