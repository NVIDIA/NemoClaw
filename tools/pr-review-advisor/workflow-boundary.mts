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

function requireExactPermissions(
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
  requireExactPermissions(errors, "review", reviewJob, {
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  requireExactPermissions(errors, "publish", publishJob, {
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
    errors.push("advisor matrix must identify exactly one primary artifact lane");
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
  if (asRecord(prepare?.env).GIT_LFS_SKIP_SMUDGE !== "1") {
    errors.push("Prepare isolated analysis workspace must disable LFS smudging");
  }
  const requiredPrepareFragments = [
    '[[ ! "$TARGET_REPO" =~ ^[A-Za-z0-9_.-]+/',
    '[[ ! "$TARGET_PR" =~ ^[0-9]+$ ]]',
    '[[ ! "$PR_BASE_SHA" =~ ^[0-9a-f]{40}$ ]]',
    '[[ ! "$EXPECTED_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]',
    "config core.hooksPath /dev/null",
    "config submodule.recurse false",
    "fetch --no-tags --no-recurse-submodules",
    '"${BASE_FETCH}:refs/remotes/target/base"',
    '"refs/pull/${TARGET_PR}/head:refs/remotes/target/pr-${TARGET_PR}"',
    'rev-parse refs/remotes/target/base)" != "$PR_BASE_SHA"',
    'ACTUAL_HEAD_SHA="$(git -C "$TARGET_DIR" rev-parse HEAD)"',
    '"$ACTUAL_HEAD_SHA" != "$EXPECTED_HEAD_SHA"',
  ];
  for (const fragment of requiredPrepareFragments) requireRunContains(errors, prepare, fragment);
  requireRunOrder(
    errors,
    prepare,
    '[[ ! "$EXPECTED_HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]',
    "fetch --no-tags --no-recurse-submodules target",
  );
  requireRunOrder(
    errors,
    prepare,
    'ACTUAL_HEAD_SHA="$(git -C "$TARGET_DIR" rev-parse HEAD)"',
    'echo "ADVISOR_WORKDIR=$TARGET_DIR"',
  );

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
  requireRunContains(errors, analyze, 'cd "$ADVISOR_WORKDIR"');
  requireRunContains(errors, analyze, '"$ADVISOR_DIR/tools/pr-review-advisor/analyze.mts"');
  requireRunContains(errors, analyze, '"$ADVISOR_DIR/tools/pr-review-advisor/schema.json"');
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

  const download = requireStep(errors, steps, "Download primary advisor artifact");
  requireWith(errors, download, "name", "pr-review-advisor");
  requireWith(errors, download, "path", "publish-artifacts/pr-review-advisor");
  for (const forbidden of ["run-id", "github-token", "repository", "pattern", "merge-multiple"]) {
    if (Object.hasOwn(asRecord(download?.with), forbidden)) {
      errors.push(`Download primary advisor artifact must not set with.${forbidden}`);
    }
  }

  const validate = requireStep(errors, steps, "Validate primary advisor artifact");
  for (const fragment of [
    "lstatSync",
    "isSymbolicLink",
    "realpathSync",
    "PR_REVIEW_ADVISOR_MAX_RESULT_BYTES",
    "PR_REVIEW_ADVISOR_MAX_SUMMARY_BYTES",
    "JSON.parse",
    "result.version !== 1",
    "result.headSha !== process.env.EXPECTED_HEAD_SHA",
    "Array.isArray(result.findings)",
    "result.e2e.coverage",
    "result.e2e.targets",
    'gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER"',
    '"$LIVE_HEAD_SHA" != "$EXPECTED_HEAD_SHA"',
    '"$LIVE_BASE_SHA" != "$PR_BASE_SHA"',
  ]) {
    requireRunContains(errors, validate, fragment);
  }

  const comment = requireStep(errors, steps, "Post PR review advisor comment");
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
  const validateIndex = steps.findIndex(
    (step) => step.name === "Validate primary advisor artifact",
  );
  const commentIndex = steps.findIndex((step) => step.name === "Post PR review advisor comment");
  if (validateIndex < 0 || commentIndex < 0 || validateIndex > commentIndex) {
    errors.push(
      "primary artifact and live PR identity must be validated before the trusted comment script",
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
