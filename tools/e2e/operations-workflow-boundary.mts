// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const DEFAULT_ADVISOR_PATH = join(REPO_ROOT, ".github", "workflows", "e2e-advisor.yaml");
const META_JOBS = new Set(["report-to-pr", "scorecard"]);
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const GITHUB_SCRIPT_NODE24_ACTION =
  "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3";
const ISSUE_API_REFERENCE = /\bgithub\.rest\.issues\b/u;
const ISSUE_MUTATION_BEYOND_COMMENT =
  /github\.rest\.issues\.(?:addAssignees|addLabels|create|deleteComment|lock|removeAssignees|removeLabel|setLabels|unlock|update|updateComment)\s*\(/u;
const GENERIC_GITHUB_WRITE_SURFACE =
  /github\s*(?:(?:\?\.|\.)\s*(?:graphql|request)\b|\[\s*["'](?:graphql|request)["']\s*\])|\b(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*\s*=\s*github\b|\{[^}]*\b(?:graphql|request)\b[^}]*\}\s*=\s*github(?:\.rest)?\b)|\bfetch\b|\bgh\s+api\b/u;
const GENERIC_ISSUE_REST_MUTATION =
  /github\.request\s*\(\s*["'`](?:POST|PATCH|PUT|DELETE)\s+\/repos\/[^/\s]+\/[^/\s]+\/issues(?:\/|\b)/u;
const GENERIC_ISSUE_GRAPHQL_MUTATION =
  /github\.graphql\s*\(\s*["'`]\s*mutation\b[\s\S]*?\b(?:addComment|closeIssue|createIssue|reopenIssue|updateIssue)\b/u;

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowPermissions = Record<string, unknown> | string;

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: unknown;
  permissions?: WorkflowPermissions;
  steps?: WorkflowStep[];
};

export type OperationsWorkflow = {
  jobs: Record<string, WorkflowJob>;
  permissions?: WorkflowPermissions;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, Record<string, unknown>>;
    };
  };
};

export function readE2eOperationsWorkflow(path = DEFAULT_WORKFLOW_PATH): OperationsWorkflow {
  return YAML.parse(readFileSync(path, "utf8")) as OperationsWorkflow;
}

function needs(job: WorkflowJob): string[] {
  return Array.isArray(job.needs)
    ? job.needs.filter((name): name is string => typeof name === "string")
    : typeof job.needs === "string"
      ? [job.needs]
      : [];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function permissionMap(permissions: WorkflowPermissions | undefined): Record<string, unknown> {
  return permissions !== null && typeof permissions === "object" ? permissions : {};
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  return job.steps?.find((step) => step.name === name) ?? {};
}

function executableSource(job: WorkflowJob): string {
  return (job.steps ?? [])
    .flatMap((step) => [step.run, step.with?.script])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function requirePinnedAction(errors: string[], step: WorkflowStep, owner: string): void {
  if (!FULL_SHA_ACTION.test(step.uses ?? "")) {
    errors.push(`${owner} must pin its action to a full SHA`);
  }
}

function requireNode24GithubScript(errors: string[], step: WorkflowStep, owner: string): void {
  requirePinnedAction(errors, step, owner);
  if (step.uses !== GITHUB_SCRIPT_NODE24_ACTION) {
    errors.push(`${owner} must use the pinned Node 24 github-script runtime`);
  }
}

function validateAggregation(errors: string[], workflow: OperationsWorkflow): void {
  const executionJobs = Object.keys(workflow.jobs).filter((name) => !META_JOBS.has(name));
  const reportNeeds = needs(workflow.jobs["report-to-pr"] ?? {});
  for (const name of executionJobs) {
    if (!reportNeeds.includes(name)) errors.push(`report-to-pr must wait for ${name}`);
  }
  for (const name of reportNeeds) {
    if (!executionJobs.includes(name)) errors.push(`report-to-pr waits for unknown job ${name}`);
  }
  const scorecardNeeds = needs(workflow.jobs.scorecard ?? {});
  if (!sameMembers(scorecardNeeds, reportNeeds)) {
    errors.push("scorecard needs must exactly match report-to-pr needs");
  }
}

function validateIssueRoutingRetirement(errors: string[], workflow: OperationsWorkflow): void {
  if ("notify-on-failure" in workflow.jobs) {
    errors.push("notify-on-failure must remain retired");
  }

  if (
    workflow.permissions === "write-all" ||
    permissionMap(workflow.permissions).issues === "write"
  ) {
    errors.push("E2E workflow must not grant top-level issues: write");
  }
  if (
    workflow.permissions === "write-all" ||
    permissionMap(workflow.permissions)["pull-requests"] === "write"
  ) {
    errors.push("E2E workflow must not grant top-level pull-requests: write");
  }

  for (const [name, job] of Object.entries(workflow.jobs)) {
    const permissions = permissionMap(job.permissions);
    const jobSource = executableSource(job);
    if (job.permissions === "write-all" || permissions.issues === "write") {
      errors.push(`${name} must not hold issues: write`);
    }
    if (name === "report-to-pr") {
      if (
        job.permissions === "write-all" ||
        permissions["pull-requests"] !== "write" ||
        Object.keys(permissions).length !== 1
      ) {
        errors.push("report-to-pr must hold only pull-requests: write");
      }
      if (job.if !== "${{ always() && github.event_name == 'workflow_dispatch' }}") {
        errors.push("report-to-pr must run only for manual workflow dispatches");
      }
      const report = findStep(job, "Post E2E target results to PR");
      if (job.steps?.length !== 1) {
        errors.push("report-to-pr must contain only its PR-comment step");
      }
      requireNode24GithubScript(errors, report, "report-to-pr");
      const reportScript = String(report.with?.script ?? "");
      const commentCalls = jobSource.match(/github\.rest\.issues\.createComment\s*\(/gu);
      const issueNamespaceReferences = reportScript.match(/github\.rest\.issues\b/gu);
      const prScopedComment =
        /await\s+github\.rest\.issues\.createComment\(\{\s*owner:\s*context\.repo\.owner,\s*repo:\s*context\.repo\.repo,\s*issue_number:\s*prNumber,\s*body:\s*lines\.join\('\\n'\),?\s*\}\);/u;
      if (commentCalls?.length !== 1 || !prScopedComment.test(reportScript)) {
        errors.push(
          "report-to-pr must limit issue mutation to one validated PR-scoped createComment call",
        );
      }
      if (
        issueNamespaceReferences?.length !== 1 ||
        ISSUE_MUTATION_BEYOND_COMMENT.test(jobSource) ||
        GENERIC_GITHUB_WRITE_SURFACE.test(jobSource)
      ) {
        errors.push("report-to-pr must not use issue mutations or generic GitHub write surfaces");
      }
      continue;
    }

    if (job.permissions === "write-all" || permissions["pull-requests"] === "write") {
      errors.push(`${name} must not hold pull-requests: write`);
    }

    // Deny these generic API clients by default. The scorecard's single fixed
    // Slack webhook call is the only allowlisted use outside report-to-pr;
    // validateScorecard binds webhookUrl to a step-scoped Slack secret. This
    // textual scan is defense in depth; token permissions are the hard boundary.
    const sourceWithoutSlackPublisher =
      name === "scorecard"
        ? jobSource.replace(/\bfetch\s*\(\s*webhookUrl\s*,/u, "validatedSlackFetch(")
        : jobSource;

    if (
      ISSUE_API_REFERENCE.test(jobSource) ||
      GENERIC_ISSUE_REST_MUTATION.test(jobSource) ||
      GENERIC_ISSUE_GRAPHQL_MUTATION.test(jobSource)
    ) {
      errors.push(`${name} must not mutate GitHub issues`);
    }
    if (GENERIC_GITHUB_WRITE_SURFACE.test(sourceWithoutSlackPublisher)) {
      errors.push(`${name} must not use unvalidated generic write surfaces`);
    }
  }
}

function validateScorecard(errors: string[], workflow: OperationsWorkflow): void {
  const dispatchInput = workflow.on?.workflow_dispatch?.inputs?.post_to_slack;
  if (dispatchInput?.type !== "boolean" || dispatchInput.default !== false) {
    errors.push("workflow_dispatch post_to_slack must be an opt-in boolean");
  }

  const job = workflow.jobs.scorecard ?? {};
  const permissions = permissionMap(job.permissions);
  if (
    job.if !==
    "${{ always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}"
  ) {
    errors.push("scorecard must run after scheduled and manual E2E executions");
  }
  if (
    permissions.actions !== "read" ||
    permissions.contents !== "read" ||
    Object.keys(permissions).length !== 2
  ) {
    errors.push("scorecard permissions must be actions: read and contents: read");
  }
  if (job.env && Object.keys(job.env).length > 0) {
    errors.push("scorecard must not expose credentials at job scope");
  }

  const checkout = findStep(job, "Checkout scorecard builders");
  requirePinnedAction(errors, checkout, "scorecard checkout");
  if (checkout.with?.["persist-credentials"] !== false) {
    errors.push("scorecard checkout must disable persisted credentials");
  }
  if (checkout.with?.["sparse-checkout"] !== "scripts/scorecard") {
    errors.push("scorecard checkout must be limited to scripts/scorecard");
  }

  const generate = findStep(job, "Generate E2E scorecard");
  requireNode24GithubScript(errors, generate, "scorecard generator");
  const generateScript = String(generate.with?.script ?? "");
  for (const fragment of [
    "scripts/scorecard/analyze-trace-timing.ts",
    "traceTiming.buildTraceTimingResult",
    "scripts/scorecard/summarize-jobs.ts",
    "scorecardJobs.isSelectiveDispatch",
    "scorecardJobs.loadWorkflowRunJobs",
    "scorecardJobs.summarizeJobs",
    "scripts/scorecard/build-slack-blocks.ts",
    "slackBlocks.buildBlocks",
    "core.summary",
    "scorecardData",
    "slackData",
  ]) {
    if (!generateScript.includes(fragment))
      errors.push(`scorecard generator must retain ${fragment}`);
  }
  if (
    generate.env?.EXPLICIT_ONLY_JOBS !== "${{ needs.generate-matrix.outputs.explicit_only_jobs }}"
  ) {
    errors.push("scorecard generator must derive explicit-only jobs from workflow inventory");
  }

  const slack = findStep(job, "Post scorecard to Slack");
  requirePinnedAction(errors, slack, "scorecard Slack publisher");
  if (
    slack.if !== "${{ steps.scorecard.outputs.slackData != '' && github.ref == 'refs/heads/main' }}"
  ) {
    errors.push("scorecard Slack publisher must expose webhook secrets only on main");
  }
  const expectedSlackEnv = [
    "SLACK_WEBHOOK_URL_DAILY",
    "SLACK_WEBHOOK_URL_FULLRUN",
    "SLACK_WEBHOOK_URL_PREVIEW",
  ];
  for (const name of expectedSlackEnv) {
    if (!String(slack.env?.[name] ?? "").includes(`secrets.${name}`)) {
      errors.push(`scorecard Slack publisher must scope ${name} to its step`);
    }
  }
  if (slack.env?.POST_TO_SLACK !== "${{ inputs.post_to_slack }}") {
    errors.push("scorecard Slack publisher must honor the post_to_slack opt-in");
  }
  if (slack.env?.SLACK_DATA !== "${{ steps.scorecard.outputs.slackData }}") {
    errors.push("scorecard Slack publisher must consume the precomputed Slack payload");
  }
  const slackScript = String(slack.with?.script ?? "");
  for (const fragment of [
    "process.env.SLACK_DATA",
    "Invalid precomputed Slack payload",
    "Selective dispatch without post_to_slack",
    "SLACK_WEBHOOK_URL_PREVIEW",
    "const webhookUrl = process.env[envByChannel[channel]];",
    "await fetch(webhookUrl, {",
  ]) {
    if (!slackScript.includes(fragment))
      errors.push(`scorecard Slack publisher must retain ${fragment}`);
  }
  for (const forbidden of ["GITHUB_WORKSPACE", "require(", "scripts/scorecard/"]) {
    if (slackScript.includes(forbidden)) {
      errors.push(`scorecard Slack publisher must not execute workflow-ref code via ${forbidden}`);
    }
  }
}

function validateTraceTiming(errors: string[], workflow: OperationsWorkflow): void {
  const job = workflow.jobs["cloud-onboard"] ?? {};
  if (job.env?.NEMOCLAW_TRACE_DIR !== undefined) {
    errors.push("cloud-onboard trace directory must not use unavailable job-level contexts");
  }
  const configure = findStep(job, "Configure cloud-onboard trace directory");
  for (const fragment of ['"${RUNNER_TEMP}/nemoclaw-cloud-onboard-traces"', '>> "${GITHUB_ENV}"']) {
    if (!String(configure.run ?? "").includes(fragment)) {
      errors.push(`cloud-onboard trace directory setup must retain ${fragment}`);
    }
  }
  const sanitize = findStep(job, "Build trusted cloud-onboard timing summary");
  if (sanitize.if !== "always()") {
    errors.push("cloud-onboard trace sanitizer must always run");
  }
  const script = sanitize.run ?? "";
  for (const fragment of [
    'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-cloud-onboard-traces"',
    '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
    "scripts/e2e/sanitize-trace-timing.py",
    '"${NEMOCLAW_TRACE_DIR}"',
    '"${E2E_ARTIFACT_DIR}"',
  ]) {
    if (!script.includes(fragment))
      errors.push(`cloud-onboard trace sanitizer must retain ${fragment}`);
  }
  const sourceGuardIndex = script.indexOf(
    '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
  );
  const sanitizeCommandIndex = script.indexOf("python3 scripts/e2e/sanitize-trace-timing.py");
  if (
    sourceGuardIndex === -1 ||
    sanitizeCommandIndex === -1 ||
    sourceGuardIndex > sanitizeCommandIndex
  ) {
    errors.push("cloud-onboard trace sanitizer must verify source path before reading traces");
  }
  const steps = job.steps ?? [];
  const configureIndex = steps.findIndex(
    (step) => step.name === "Configure cloud-onboard trace directory",
  );
  const runIndex = steps.findIndex((step) => step.name === "Run cloud-onboard live Vitest test");
  const sanitizeIndex = steps.findIndex(
    (step) => step.name === "Build trusted cloud-onboard timing summary",
  );
  const cleanup = findStep(job, "Delete raw cloud-onboard traces");
  const cleanupIndex = steps.findIndex((step) => step.name === "Delete raw cloud-onboard traces");
  const uploadIndex = steps.findIndex((step) => step.name === "Upload cloud-onboard artifacts");
  if (cleanup.if !== "always()") {
    errors.push("cloud-onboard raw trace cleanup must always run");
  }
  for (const fragment of [
    'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-cloud-onboard-traces"',
    '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
    'rm -rf -- "${NEMOCLAW_TRACE_DIR}"',
  ]) {
    if (!String(cleanup.run ?? "").includes(fragment)) {
      errors.push(`cloud-onboard raw trace cleanup must retain ${fragment}`);
    }
  }
  if (
    !(
      configureIndex >= 0 &&
      configureIndex < runIndex &&
      runIndex < sanitizeIndex &&
      sanitizeIndex < cleanupIndex &&
      cleanupIndex < uploadIndex
    )
  ) {
    errors.push(
      "cloud-onboard must test, sanitize raw traces, delete raw traces, then upload trusted artifacts",
    );
  }
}

function validateAdvisorRetirement(errors: string[], advisorPath: string): void {
  const source = readFileSync(advisorPath, "utf8");
  const advisor = YAML.parse(source) as OperationsWorkflow;
  const permissionBlocks = [
    advisor.permissions,
    ...Object.values(advisor.jobs ?? {}).map((job) => job.permissions),
  ];
  if (
    permissionBlocks.some(
      (permissions) =>
        permissions === "write-all" || permissionMap(permissions).actions === "write",
    )
  ) {
    errors.push("E2E advisor must not hold actions: write");
  }
  if (/createWorkflowDispatch|workflow_dispatches/u.test(source)) {
    errors.push("E2E advisor must not auto-dispatch workflows");
  }
}

export function validateE2eOperationsWorkflow(
  workflow: OperationsWorkflow,
  advisorPath = DEFAULT_ADVISOR_PATH,
): string[] {
  const errors: string[] = [];
  validateAggregation(errors, workflow);
  validateIssueRoutingRetirement(errors, workflow);
  validateScorecard(errors, workflow);
  validateTraceTiming(errors, workflow);
  validateAdvisorRetirement(errors, advisorPath);
  return errors;
}

export function validateE2eOperationsWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  advisorPath = DEFAULT_ADVISOR_PATH,
): string[] {
  return validateE2eOperationsWorkflow(readE2eOperationsWorkflow(workflowPath), advisorPath);
}
