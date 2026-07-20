// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const DEFAULT_PACKAGE_LOCK_PATH = join(REPO_ROOT, "package-lock.json");
const TRUSTED_WORKFLOW_REF = "${{ github.workflow_sha }}";
const CANONICAL_ADVISOR_NPM_CI = "npm ci --ignore-scripts --no-audit --no-fund";
const PINNED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const CANONICAL_PREPARE_TARGET_PR = `node --experimental-strip-types "$ADVISOR_DIR/tools/pr-review-advisor/prepare-target-pr.mts"`;
const CANONICAL_RUN_ANALYSIS = `cd "$ADVISOR_WORKDIR"
node --experimental-strip-types "$ADVISOR_DIR/tools/pr-review-advisor/run-analysis.mts"`;
const CANONICAL_VALIDATE_ARTIFACTS = `node --experimental-strip-types "$ADVISOR_DIR/tools/pr-review-advisor/validate-artifacts.mts"`;
const FORBIDDEN_ARTIFACT_DOWNLOAD_WITH_KEYS = [
  "run-id",
  "github-token",
  "repository",
  "pattern",
  "merge-multiple",
] as const;
const ADVISOR_RUNTIME_PACKAGE_PINS = [
  { packageName: "@earendil-works/pi-coding-agent", envName: "PI_SDK_VERSION", version: "0.80.6" },
  { packageName: "typebox", envName: "TYPEBOX_VERSION", version: "1.1.38" },
  { packageName: "yaml", envName: "YAML_VERSION", version: "2.8.3" },
  { packageName: "vitest", envName: "VITEST_VERSION", version: "4.1.9" },
] as const;

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & {
  name?: string;
  run?: string;
  uses?: string;
  with?: WorkflowRecord;
};

function asRecord(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function asSteps(value: unknown): WorkflowStep[] {
  return Array.isArray(value)
    ? (value.filter((entry) => asRecord(entry) === entry) as WorkflowStep[])
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function namedStep(steps: readonly WorkflowStep[], name: string): WorkflowStep | undefined {
  return steps.find((step) => step.name === name);
}

function usesPinnedAction(uses: string): boolean {
  return /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}(?:\s*#.*)?$/.test(uses);
}

function requireStep(
  errors: string[],
  steps: readonly WorkflowStep[],
  name: string,
): WorkflowStep | undefined {
  const step = namedStep(steps, name);
  if (!step) errors.push(`missing workflow step: ${name}`);
  return step;
}

function requireWith(
  errors: string[],
  step: WorkflowStep | undefined,
  key: string,
  expected: string | boolean | number,
): void {
  if (!step) return;
  if (asRecord(step.with)[key] !== expected) {
    errors.push(`step '${step.name ?? "<unnamed>"}' expected with.${key}=${String(expected)}`);
  }
}

function requireRunContains(
  errors: string[],
  step: WorkflowStep | undefined,
  expected: string,
): void {
  if (step && !stringValue(step.run).includes(expected)) {
    errors.push(`step '${step.name ?? "<unnamed>"}' run script must include ${expected}`);
  }
}

function requireRunLine(
  errors: string[],
  step: WorkflowStep | undefined,
  expected: string,
  message: string,
): void {
  if (!step) return;
  const lines = stringValue(step.run)
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (!lines.includes(expected)) errors.push(message);
}

function normalizedRunScript(value: unknown): string {
  return stringValue(value)
    .trim()
    .replace(/\\\r?\n[ \t]*/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => line.replace(/[ \t]+/gu, " "))
    .filter(Boolean)
    .join("\n");
}

function requireCanonicalRun(
  errors: string[],
  step: WorkflowStep | undefined,
  expected: string,
  message: string,
): void {
  if (step && normalizedRunScript(step.run) !== expected) errors.push(message);
}

function requireRunOrder(
  errors: string[],
  step: WorkflowStep | undefined,
  before: string,
  after: string,
): void {
  if (!step) return;
  const run = stringValue(step.run);
  const beforeIndex = run.indexOf(before);
  const afterIndex = run.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex > afterIndex) {
    errors.push(`step '${step.name ?? "<unnamed>"}' must check ${before} before ${after}`);
  }
}

function rejectUntrustedAdvisorHelperExecution(
  errors: string[],
  steps: readonly WorkflowStep[],
): void {
  const untrustedHelperPatterns = [
    /\$\{?ADVISOR_WORKDIR\}?\/tools\/pr-review-advisor\//u,
    /(^|[\s"'`])(?:\.\/)?tools\/pr-review-advisor\/[^\s"'`]+\.mts/u,
  ] as const;
  for (const step of steps) {
    if (untrustedHelperPatterns.some((pattern) => pattern.test(stringValue(step.run)))) {
      errors.push(
        `review step '${step.name ?? "<unnamed>"}' must not execute pr-review-advisor helpers from ADVISOR_WORKDIR`,
      );
    }
  }
}

function requireEnv(
  errors: string[],
  owner: string,
  record: WorkflowRecord,
  key: string,
  expected: string,
): void {
  if (asRecord(record.env)[key] !== expected) {
    errors.push(`${owner} env.${key} must be ${expected}`);
  }
}

function requirePermissions(
  errors: string[],
  jobName: string,
  job: WorkflowRecord,
  expected: Readonly<Record<string, string>>,
): void {
  const actual = asRecord(job.permissions);
  for (const [permission, level] of Object.entries(expected)) {
    if (actual[permission] !== level) {
      errors.push(`${jobName} job permissions.${permission} must be ${level}`);
    }
  }
  for (const permission of Object.keys(actual)) {
    if (!Object.hasOwn(expected, permission)) {
      errors.push(`${jobName} job permissions.${permission} is not allowed`);
    }
  }
}

function checkAdvisorRuntimePackageLock(errors: string[], packageLockPath: string): void {
  let lock: WorkflowRecord;
  try {
    lock = asRecord(JSON.parse(readFileSync(packageLockPath, "utf8")));
  } catch {
    errors.push(`failed to read or parse advisor package lock: ${packageLockPath}`);
    return;
  }
  const packages = asRecord(lock.packages);
  for (const { packageName, version } of ADVISOR_RUNTIME_PACKAGE_PINS) {
    const actualVersion = asRecord(packages[`node_modules/${packageName}`]).version;
    if (actualVersion !== version) {
      errors.push(`advisor package lock must pin ${packageName}@${version}`);
    }
  }
}

function requireActionPins(
  errors: string[],
  jobName: string,
  steps: readonly WorkflowStep[],
): void {
  for (const step of steps) {
    if (step.uses && !usesPinnedAction(step.uses)) {
      errors.push(
        `${jobName} step '${step.name ?? step.uses}' must pin action uses to a full commit SHA`,
      );
    }
  }
}

function advisorMatrixEntries(errors: string[], reviewJob: WorkflowRecord): WorkflowRecord[] {
  const advisor = asRecord(asRecord(reviewJob.strategy).matrix).advisor;
  if (!Array.isArray(advisor)) {
    errors.push("advisor matrix must declare strategy.matrix.advisor entries");
    return [];
  }
  const entries = advisor.filter((entry) => asRecord(entry) === entry) as WorkflowRecord[];
  if (entries.length < 2) errors.push("advisor matrix must include at least two lanes");
  return entries;
}

function requireUniqueMatrixField(
  errors: string[],
  entries: readonly WorkflowRecord[],
  field: string,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const value = stringValue(entry[field]).trim();
    if (!value) {
      errors.push(`advisor matrix entry ${index + 1} missing ${field}`);
    } else if (seen.has(value)) {
      errors.push(`advisor matrix field ${field} must be unique: ${value}`);
    }
    seen.add(value);
  }
}

function checkTargetTriggers(errors: string[], workflow: WorkflowRecord): void {
  const triggers = asRecord(workflow.on ?? workflow[true as unknown as string]);
  if (!Object.hasOwn(triggers, "pull_request_target")) {
    errors.push("workflow must run automatic reviews on pull_request_target");
  }
  if (Object.hasOwn(triggers, "pull_request")) {
    errors.push("workflow must not duplicate automatic reviews on pull_request");
  }
  if (!Object.hasOwn(triggers, "workflow_dispatch")) {
    errors.push("workflow must retain workflow_dispatch support");
  }
}

function checkPrivilegeDomains(
  errors: string[],
  workflow: WorkflowRecord,
  reviewJob: WorkflowRecord,
  publishJob: WorkflowRecord,
): void {
  if (Object.keys(asRecord(workflow.permissions)).length !== 0) {
    errors.push(
      "workflow-level permissions must be empty so each job declares its privilege domain",
    );
  }
  requirePermissions(errors, "review", reviewJob, {
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  requirePermissions(errors, "publish", publishJob, {
    contents: "read",
    "pull-requests": "write",
  });

  const jobs = asRecord(workflow.jobs);
  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const permissions = asRecord(asRecord(rawJob).permissions);
    if (permissions["pull-requests"] === "write" && jobName !== "publish") {
      errors.push("publish must be the only job with pull-requests: write");
    }
  }
  if (JSON.stringify(publishJob).includes("PR_REVIEW_ADVISOR_API_KEY")) {
    errors.push("publish job must not receive the advisor model credential");
  }
  if (JSON.stringify(publishJob).includes("ADVISOR_WORKDIR")) {
    errors.push("publish job must not receive the untrusted analysis worktree");
  }
}

function checkAnalysisJob(errors: string[], reviewJob: WorkflowRecord): void {
  if (stringValue(reviewJob["runs-on"]) !== "ubuntu-24.04") {
    errors.push("review job must pin the Ubuntu runner used by runtime package versions");
  }
  if (stringValue(reviewJob["continue-on-error"]) !== "${{ !matrix.advisor.publish_comment }}") {
    errors.push("review job failures must be non-blocking only for non-publishing advisor lanes");
  }

  const entries = advisorMatrixEntries(errors, reviewJob);
  for (const [index, entry] of entries.entries()) {
    if (booleanValue(entry.publish_comment) === undefined) {
      errors.push(`advisor matrix entry ${index + 1} missing boolean publish_comment`);
    }
  }
  if (entries.filter((entry) => booleanValue(entry.publish_comment) === true).length !== 1) {
    errors.push("advisor matrix must identify one primary artifact lane");
  }
  for (const field of ["model", "artifact_dir", "artifact_name"]) {
    requireUniqueMatrixField(errors, entries, field);
  }

  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_REVIEW_ADVISOR_MODEL",
    "${{ matrix.advisor.model }}",
  );
  requireEnv(errors, "review job", reviewJob, "FD_FIND_VERSION", "9.0.0-1");
  requireEnv(errors, "review job", reviewJob, "RIPGREP_VERSION", "14.1.0-1");
  for (const { envName, version } of ADVISOR_RUNTIME_PACKAGE_PINS) {
    requireEnv(errors, "review job", reviewJob, envName, version);
  }
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_REVIEW_ADVISOR_ARTIFACT_DIR",
    "${{ matrix.advisor.artifact_dir }}",
  );
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_REVIEW_ADVISOR_WORKFLOW_NAME",
    "PR Review / Advisor",
  );
  requireEnv(errors, "review job", reviewJob, "PR_REVIEW_ADVISOR_LOAD_PREVIOUS_REVIEW", "false");

  const steps = asSteps(reviewJob.steps);
  if (steps.length === 0) errors.push("review job must declare steps");
  requireActionPins(errors, "review", steps);
  rejectUntrustedAdvisorHelperExecution(errors, steps);

  if (steps.some((step) => step.name === "Checkout PR workspace (read-only data)")) {
    errors.push("pull_request_target data must be fetched manually, not with actions/checkout");
  }
  const trustedCheckout = requireStep(
    errors,
    steps,
    "Checkout trusted advisor code (workflow revision)",
  );
  requireWith(errors, trustedCheckout, "repository", "NVIDIA/NemoClaw");
  requireWith(errors, trustedCheckout, "ref", TRUSTED_WORKFLOW_REF);
  requireWith(errors, trustedCheckout, "path", "advisor");
  requireWith(errors, trustedCheckout, "persist-credentials", false);
  requireWith(errors, trustedCheckout, "lfs", false);
  requireWith(errors, trustedCheckout, "submodules", false);

  const dispatchCheckout = requireStep(
    errors,
    steps,
    "Checkout dispatch workspace (read-only data)",
  );
  requireWith(errors, dispatchCheckout, "ref", "${{ github.sha }}");
  requireWith(errors, dispatchCheckout, "path", "pr-workdir");
  requireWith(errors, dispatchCheckout, "persist-credentials", false);
  requireWith(errors, dispatchCheckout, "lfs", false);
  requireWith(errors, dispatchCheckout, "submodules", false);

  const prepare = requireStep(errors, steps, "Prepare isolated analysis workspace");
  const prepareEnv = asRecord(prepare?.env);
  if (prepareEnv.GIT_LFS_SKIP_SMUDGE !== "1") {
    errors.push("Prepare isolated analysis workspace must disable LFS smudging");
  }
  // The fetch/validate/checkout logic lives in the trusted, unit-tested helper
  // (prepare-target-pr.mts); the workflow must invoke it from the pinned advisor
  // checkout ($ADVISOR_DIR), never from PR-controlled content.
  requireCanonicalRun(
    errors,
    prepare,
    CANONICAL_PREPARE_TARGET_PR,
    "step 'Prepare isolated analysis workspace' must use the canonical trusted prepare helper command",
  );
  // The base and head must be bound to the immutable SHAs in the triggering
  // event so the helper's fail-closed SHA verification cannot be silently
  // disabled by dropping the environment binding.
  if (
    prepare &&
    !stringValue(prepareEnv.EXPECTED_HEAD_SHA).includes("github.event.pull_request.head.sha")
  ) {
    errors.push(
      "Prepare isolated analysis workspace must bind EXPECTED_HEAD_SHA to the triggering PR head",
    );
  }
  if (
    prepare &&
    !stringValue(prepareEnv.PR_BASE_SHA).includes("github.event.pull_request.base.sha")
  ) {
    errors.push(
      "Prepare isolated analysis workspace must bind PR_BASE_SHA to the triggering PR base",
    );
  }

  const removeSymlinks = requireStep(errors, steps, "Remove symlinks from analysis workspace");
  if (removeSymlinks && stringValue(removeSymlinks.shell) !== "bash") {
    errors.push("Remove symlinks from analysis workspace must use the bash shell");
  }
  const expectedSymlinkRemoval = `while IFS= read -r -d '' link; do
  rm -- "$link"
done < <(find "$ADVISOR_WORKDIR" -type l -print0)`;
  if (removeSymlinks && stringValue(removeSymlinks.run).trim() !== expectedSymlinkRemoval) {
    errors.push(
      "Remove symlinks from analysis workspace must use the canonical fail-closed cleanup script",
    );
  }

  const install = requireStep(errors, steps, "Install Pi SDK");
  requireRunContains(errors, install, "sudo apt-get install -y --no-install-recommends");
  requireRunContains(errors, install, '"fd-find=${FD_FIND_VERSION}"');
  requireRunContains(errors, install, '"ripgrep=${RIPGREP_VERSION}"');
  requireRunContains(errors, install, "sudo apt-get update -qq");
  requireRunContains(errors, install, "dpkg-query -W -f='${Version}' fd-find");
  requireRunContains(errors, install, "dpkg-query -W -f='${Version}' ripgrep");
  requireRunContains(errors, install, '"$INSTALLED_FD_FIND_VERSION" != "$FD_FIND_VERSION"');
  requireRunContains(errors, install, '"$INSTALLED_RIPGREP_VERSION" != "$RIPGREP_VERSION"');
  requireRunContains(errors, install, "command -v fdfind");
  requireRunContains(errors, install, "command -v rg");
  requireRunContains(errors, install, 'FD_BINARY_VERSION="$(fdfind --version)"');
  requireRunContains(errors, install, 'RG_BINARY_VERSION="$(rg --version)"');
  requireRunContains(
    errors,
    install,
    '"$FD_BINARY_VERSION" != "fdfind $EXPECTED_FD_BINARY_VERSION"',
  );
  requireRunContains(
    errors,
    install,
    '"$RG_BINARY_VERSION" != "ripgrep $EXPECTED_RG_BINARY_VERSION"',
  );
  requireRunContains(errors, install, "npm ci");
  requireRunContains(errors, install, 'cd "$ADVISOR_DIR"');
  requireRunContains(errors, install, "--ignore-scripts");
  requireRunContains(errors, install, "--no-audit");
  requireRunContains(errors, install, "--no-fund");
  requireRunLine(
    errors,
    install,
    CANONICAL_ADVISOR_NPM_CI,
    "step 'Install Pi SDK' must use the canonical lockfile-only npm ci command",
  );
  requireRunOrder(errors, install, 'cd "$ADVISOR_DIR"', CANONICAL_ADVISOR_NPM_CI);

  const analyze = requireStep(errors, steps, "Run PR review advisor");
  requireCanonicalRun(
    errors,
    analyze,
    CANONICAL_RUN_ANALYSIS,
    "step 'Run PR review advisor' must use the canonical trusted analysis command",
  );
  if (analyze && booleanValue(analyze["continue-on-error"]) !== true) {
    errors.push("Run PR review advisor must continue-on-error until artifacts are uploaded");
  }
  const analyzeEnv = asRecord(analyze?.env);
  if (analyzeEnv.PR_REVIEW_ADVISOR_API_KEY !== "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}") {
    errors.push("Run PR review advisor must receive only secrets.PR_REVIEW_ADVISOR_API_KEY");
  }
  if (Object.hasOwn(analyzeEnv, "OPENAI_API_KEY")) {
    errors.push("Run PR review advisor must not receive OPENAI_API_KEY");
  }
  const modelSecretSteps = steps.filter((step) =>
    JSON.stringify(step).includes("PR_REVIEW_ADVISOR_API_KEY"),
  );
  if (modelSecretSteps.length !== 1 || modelSecretSteps[0] !== analyze) {
    errors.push("only the analysis step may receive the advisor model credential");
  }

  const symlinkIndex = steps.findIndex(
    (step) => step.name === "Remove symlinks from analysis workspace",
  );
  if (symlinkIndex >= 0) {
    for (const workspaceStepName of [
      "Checkout dispatch workspace (read-only data)",
      "Set default advisor workdir",
      "Prepare isolated analysis workspace",
    ]) {
      const workspaceStepIndex = steps.findIndex((step) => step.name === workspaceStepName);
      if (workspaceStepIndex >= 0 && symlinkIndex < workspaceStepIndex) {
        errors.push(
          `Remove symlinks from analysis workspace must run after workspace-selection step '${workspaceStepName}'`,
        );
      }
    }
  }
  const analyzeIndex = steps.findIndex((step) => step.name === "Run PR review advisor");
  const installIndex = steps.findIndex((step) => step.name === "Install Pi SDK");
  if (installIndex < 0 || analyzeIndex < 0 || installIndex > analyzeIndex) {
    errors.push("pinned advisor tools must be installed before the model credential is exposed");
  }
  if (symlinkIndex < 0 || analyzeIndex < 0 || symlinkIndex > analyzeIndex) {
    errors.push(
      "analysis workspace symlinks must be removed before the model credential is exposed",
    );
  }
  if (steps.some((step) => step.name === "Post PR review advisor comment")) {
    errors.push("analysis job must not publish PR comments");
  }

  const upload = requireStep(errors, steps, "Upload advisor artifacts");
  requireWith(errors, upload, "name", "${{ matrix.advisor.artifact_name }}");
  requireWith(errors, upload, "path", "artifacts/${{ matrix.advisor.artifact_dir }}/");
  const outcome = requireStep(errors, steps, "Verify advisor analysis outcome");
  if (outcome && booleanValue(outcome["continue-on-error"]) === true) {
    errors.push("Verify advisor analysis outcome must not continue on error");
  }
  requireRunContains(errors, outcome, 'if [ "$ANALYSIS_OUTCOME" != "success" ]');
  const uploadIndex = steps.findIndex((step) => step.name === "Upload advisor artifacts");
  const outcomeIndex = steps.findIndex((step) => step.name === "Verify advisor analysis outcome");
  if (uploadIndex >= 0 && outcomeIndex >= 0 && outcomeIndex < uploadIndex) {
    errors.push("Verify advisor analysis outcome must run after Upload advisor artifacts");
  }
}

function checkPublishJob(errors: string[], publishJob: WorkflowRecord): void {
  if (booleanValue(publishJob["continue-on-error"]) !== true) {
    errors.push("publish job must be best-effort so it cannot mask the primary analysis outcome");
  }
  if (publishJob.needs !== "review") errors.push("publish job must depend on the review matrix");
  const publishIf = stringValue(publishJob.if);
  if (!publishIf.includes("always()") || !publishIf.includes("pull_request_target")) {
    errors.push("publish job must run best-effort only for pull_request_target events");
  }
  for (const [key, expected] of Object.entries({
    PR_REVIEW_ADVISOR_WORKFLOW_NAME: "PR Review / Advisor",
    PR_REVIEW_ADVISOR_WORKFLOW_PATH: ".github/workflows/pr-review-advisor.yaml",
    PR_REVIEW_ADVISOR_EVENT_NAME: "${{ github.event_name }}",
    PR_REVIEW_ADVISOR_RUN_ID: "${{ github.run_id }}",
    PR_REVIEW_ADVISOR_RUN_ATTEMPT: "${{ github.run_attempt }}",
    PR_NUMBER: "${{ github.event.pull_request.number }}",
    EXPECTED_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    TRUSTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    PUBLISH_ARTIFACT_DIR: "${{ github.workspace }}/publish-artifacts/pr-review-advisor",
    SECONDARY_PUBLISH_ARTIFACT_DIR:
      "${{ github.workspace }}/publish-artifacts/pr-review-advisor-nemotron-ultra",
  })) {
    requireEnv(errors, "publish job", publishJob, key, expected);
  }

  const steps = asSteps(publishJob.steps);
  requireActionPins(errors, "publish", steps);
  const checkout = requireStep(
    errors,
    steps,
    "Checkout trusted comment publisher (workflow revision)",
  );
  requireWith(errors, checkout, "repository", "NVIDIA/NemoClaw");
  requireWith(errors, checkout, "ref", TRUSTED_WORKFLOW_REF);
  requireWith(errors, checkout, "path", "advisor");
  requireWith(errors, checkout, "persist-credentials", false);
  requireWith(errors, checkout, "lfs", false);
  requireWith(errors, checkout, "submodules", false);

  const setupNode = requireStep(errors, steps, "Setup Node for trusted publisher");
  if (setupNode && stringValue(setupNode.uses) !== PINNED_SETUP_NODE_ACTION) {
    errors.push("Setup Node for trusted publisher must use the pinned actions/setup-node action");
  }
  requireWith(errors, setupNode, "node-version", "22");

  const install = requireStep(errors, steps, "Install trusted publisher dependencies");
  if (install && stringValue(install["working-directory"]) !== "advisor") {
    errors.push("Install trusted publisher dependencies must run in the trusted advisor checkout");
  }
  requireCanonicalRun(
    errors,
    install,
    CANONICAL_ADVISOR_NPM_CI,
    "step 'Install trusted publisher dependencies' must use the canonical lockfile-only npm ci command",
  );

  const download = requireStep(errors, steps, "Download primary advisor artifact");
  requireWith(errors, download, "name", "pr-review-advisor");
  requireWith(errors, download, "path", "publish-artifacts/pr-review-advisor");
  if (download && booleanValue(download["continue-on-error"]) === true) {
    errors.push("primary advisor artifact download must fail closed");
  }
  for (const forbidden of FORBIDDEN_ARTIFACT_DOWNLOAD_WITH_KEYS) {
    if (Object.hasOwn(asRecord(download?.with), forbidden)) {
      errors.push(`Download primary advisor artifact must not set with.${forbidden}`);
    }
  }

  const secondaryDownload = requireStep(errors, steps, "Download secondary advisor artifact");
  requireWith(errors, secondaryDownload, "name", "pr-review-advisor-nemotron-ultra");
  requireWith(
    errors,
    secondaryDownload,
    "path",
    "publish-artifacts/pr-review-advisor-nemotron-ultra",
  );
  if (stringValue(secondaryDownload?.id) !== "download-secondary-advisor-artifact") {
    errors.push(
      "Download secondary advisor artifact id must be download-secondary-advisor-artifact",
    );
  }
  if (secondaryDownload && booleanValue(secondaryDownload["continue-on-error"]) !== true) {
    errors.push("secondary advisor artifact download must remain non-blocking");
  }
  for (const forbidden of FORBIDDEN_ARTIFACT_DOWNLOAD_WITH_KEYS) {
    if (Object.hasOwn(asRecord(secondaryDownload?.with), forbidden)) {
      errors.push(`Download secondary advisor artifact must not set with.${forbidden}`);
    }
  }

  const validate = requireStep(errors, steps, "Validate advisor artifacts");
  if (stringValue(validate?.id) !== "validate-advisor-artifacts") {
    errors.push("Validate advisor artifacts id must be validate-advisor-artifacts");
  }
  if (
    asRecord(validate?.env).SECONDARY_ARTIFACT_OUTCOME !==
    "${{ steps.download-secondary-advisor-artifact.outcome }}"
  ) {
    errors.push("Validate advisor artifacts must use the trusted secondary download step outcome");
  }
  requireCanonicalRun(
    errors,
    validate,
    CANONICAL_VALIDATE_ARTIFACTS,
    "step 'Validate advisor artifacts' must use the canonical trusted validation command",
  );

  const comment = requireStep(errors, steps, "Post PR review advisor comment");
  if (
    asRecord(comment?.env).SECONDARY_ARTIFACT_VALIDATED !==
    "${{ steps.validate-advisor-artifacts.outputs.secondary_artifact_validated }}"
  ) {
    errors.push(
      "Post PR review advisor comment must use the trusted secondary artifact validation output",
    );
  }
  requireRunContains(errors, comment, '"$ADVISOR_DIR/tools/pr-review-advisor/comment.mts"');
  requireRunContains(
    errors,
    comment,
    '--summary "$PUBLISH_ARTIFACT_DIR/pr-review-advisor-summary.md"',
  );
  requireRunContains(
    errors,
    comment,
    '--result "$PUBLISH_ARTIFACT_DIR/pr-review-advisor-final-result.json"',
  );
  requireRunContains(
    errors,
    comment,
    '--analysis-result "$PUBLISH_ARTIFACT_DIR/pr-review-advisor-result.json"',
  );
  requireRunContains(errors, comment, 'if [ "$SECONDARY_ARTIFACT_VALIDATED" = "true" ]');
  requireRunContains(
    errors,
    comment,
    '--second-opinion-analysis-result "$SECONDARY_PUBLISH_ARTIFACT_DIR/pr-review-advisor-result.json"',
  );
  requireRunContains(
    errors,
    comment,
    '--second-opinion-result "$SECONDARY_PUBLISH_ARTIFACT_DIR/pr-review-advisor-final-result.json"',
  );
  requireRunContains(errors, comment, '"${SECONDARY_ARGS[@]}"');
  const checkoutIndex = steps.findIndex(
    (step) => step.name === "Checkout trusted comment publisher (workflow revision)",
  );
  const setupNodeIndex = steps.findIndex(
    (step) => step.name === "Setup Node for trusted publisher",
  );
  const installIndex = steps.findIndex(
    (step) => step.name === "Install trusted publisher dependencies",
  );
  const primaryDownloadIndex = steps.findIndex(
    (step) => step.name === "Download primary advisor artifact",
  );
  const secondaryDownloadIndex = steps.findIndex(
    (step) => step.name === "Download secondary advisor artifact",
  );
  const validateIndex = steps.findIndex((step) => step.name === "Validate advisor artifacts");
  const commentIndex = steps.findIndex((step) => step.name === "Post PR review advisor comment");
  if (
    checkoutIndex < 0 ||
    setupNodeIndex < 0 ||
    installIndex < 0 ||
    validateIndex < 0 ||
    checkoutIndex > setupNodeIndex ||
    setupNodeIndex > installIndex ||
    installIndex > validateIndex
  ) {
    errors.push(
      "trusted publisher Node and dependencies must be installed from the trusted checkout before artifact validation",
    );
  }
  if (
    primaryDownloadIndex < 0 ||
    secondaryDownloadIndex < 0 ||
    validateIndex < 0 ||
    commentIndex < 0 ||
    primaryDownloadIndex > validateIndex ||
    secondaryDownloadIndex > validateIndex ||
    validateIndex > commentIndex
  ) {
    errors.push(
      "same-run advisor artifacts and live PR identity must be validated before the trusted comment script",
    );
  }
}

export function validatePrReviewAdvisorWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  packageLockPath = DEFAULT_PACKAGE_LOCK_PATH,
): string[] {
  const errors: string[] = [];
  let workflow: WorkflowRecord;
  try {
    workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  } catch {
    return [`failed to read or parse workflow: ${workflowPath}`];
  }

  if (workflow.name !== "PR Review / Advisor") {
    errors.push("workflow name must remain PR Review / Advisor");
  }
  checkAdvisorRuntimePackageLock(errors, packageLockPath);
  checkTargetTriggers(errors, workflow);
  const concurrencyGroup = stringValue(asRecord(workflow.concurrency).group);
  if (!concurrencyGroup.includes("github.event_name")) {
    errors.push("workflow concurrency must distinguish event types");
  }

  const jobs = asRecord(workflow.jobs);
  const reviewJob = asRecord(jobs.review);
  const publishJob = asRecord(jobs.publish);
  if (Object.keys(reviewJob).length === 0) errors.push("workflow must declare the review job");
  if (Object.keys(publishJob).length === 0) errors.push("workflow must declare the publish job");
  checkPrivilegeDomains(errors, workflow, reviewJob, publishJob);
  checkAnalysisJob(errors, reviewJob);
  checkPublishJob(errors, publishJob);
  return errors;
}
