// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const OPENSHELL_SANDBOX_NAME_MAX_LENGTH = 19;
const OPENSHELL_SANDBOX_NAME_PATTERN = /^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/u;
const DEFAULT_PACKAGE_LOCK_PATH = join(REPO_ROOT, "package-lock.json");
const DEFAULT_OPENSHELL_POLICY_PATH = join(
  REPO_ROOT,
  "tools",
  "pr-review-advisor",
  "openshell-policy.yaml",
);
const CANONICAL_ADVISOR_DIR = "${{ github.workspace }}/advisor";
const CANONICAL_DEFAULT_WORKDIR_IF =
  "${{ github.event_name == 'workflow_dispatch' && inputs.target_repo == '' && inputs.target_pr == '' }}";
const CANONICAL_DEFAULT_WORKDIR =
  'echo "ADVISOR_WORKDIR=$GITHUB_WORKSPACE/pr-workdir" >> "$GITHUB_ENV"';
const TRUSTED_WORKFLOW_REF = "${{ github.workflow_sha }}";
const CANONICAL_ADVISOR_NPM_CI = "npm ci --ignore-scripts --no-audit --no-fund";
const PINNED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const CANONICAL_PREPARE_TARGET_PR = `node --experimental-strip-types "$ADVISOR_DIR/tools/pr-review-advisor/prepare-target-pr.mts"`;
const CANONICAL_PREPARE_SANDBOX = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" prepare`;
const CANONICAL_INSTALL_OPENSHELL =
  'env -u GITHUB_TOKEN -u GH_TOKEN -u PR_REVIEW_ADVISOR_API_KEY NEMOCLAW_NON_INTERACTIVE=1 bash "$ADVISOR_DIR/scripts/install-openshell.sh"';
const CANONICAL_RUN_ANALYSIS_SELECTOR =
  "${{ github.event_name == 'workflow_dispatch' && inputs.run_analysis == false && '0' || '1' }}";
const CANONICAL_ANALYSIS_ENABLED_IF = "${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS == '1' }}";
const CANONICAL_UNAVAILABLE_IF =
  "${{ always() && steps.configure-openshell.outcome != 'success' }}";
const CANONICAL_UNAVAILABLE_REASON =
  "${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS == '0' && 'PR_REVIEW_ADVISOR_RUN_ANALYSIS=0' || 'OpenShell inference configuration failed or the advisor credential is unavailable' }}";
const CANONICAL_CONFIGURE_OPENSHELL = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" configure`;
const CANONICAL_UNAVAILABLE_ANALYSIS = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" unavailable`;
const CANONICAL_CREATE_SANDBOX = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" create`;
const CANONICAL_RUN_ANALYSIS = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" run`;
const CANONICAL_DOWNLOAD_ARTIFACTS = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" download`;
const CANONICAL_DELETE_SANDBOX = `node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" delete`;
const CANONICAL_VALIDATE_ARTIFACTS = `node --experimental-strip-types "$ADVISOR_DIR/tools/pr-review-advisor/validate-artifacts.mts"`;
const PINNED_PI_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd";
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
  { packageName: "undici", envName: "UNDICI_VERSION", version: "8.10.0" },
  { packageName: "yaml", envName: "YAML_VERSION", version: "2.8.3" },
  { packageName: "vitest", envName: "VITEST_VERSION", version: "4.1.9" },
] as const;
const SHADOW_ANALYSIS_STEP_NAMES = [
  "Checkout trusted advisor code (workflow revision)",
  "Checkout dispatch workspace (read-only data)",
  "Set default advisor workdir",
  "Setup Node",
  "Prepare isolated analysis workspace",
  "Remove symlinks from analysis workspace",
  "Download specialist session artifacts",
  "Install Pi SDK",
  "Prepare advisor sandbox inputs",
  "Install OpenShell",
  "Configure OpenShell inference",
  "Write unavailable advisor artifacts",
  "Create credential-free advisor sandbox",
  "Run PR review advisor",
  "Download advisor artifacts from sandbox",
  "Delete advisor sandbox",
  "Publish job summary",
  "Upload advisor artifacts",
  "Upload native specialist session",
  "Verify advisor analysis outcome",
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function containsStringMatching(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsStringMatching(entry, pattern));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => containsStringMatching(entry, pattern));
  }
  return false;
}

function containsSecretExpression(value: unknown): boolean {
  return containsStringMatching(value, /\$\{\{\s*secrets(?:\.|\s*\[)/u);
}

function containsGitHubTokenExpression(value: unknown): boolean {
  return containsStringMatching(value, /\$\{\{\s*github(?:\.token|\s*\[\s*["']token["']\s*\])/u);
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

function checkOpenShellPolicy(errors: string[], policyPath: string): void {
  let policy: WorkflowRecord;
  try {
    policy = asRecord(YAML.parse(readFileSync(policyPath, "utf8")));
  } catch {
    errors.push(`failed to read or parse advisor OpenShell policy: ${policyPath}`);
    return;
  }
  if (policy.version !== 1) {
    errors.push("advisor OpenShell policy version must remain 1");
  }

  const filesystem = asRecord(policy.filesystem_policy);
  if (booleanValue(filesystem.include_workdir) !== false) {
    errors.push("advisor OpenShell policy must not include the default workdir");
  }
  const readOnly = stringArray(filesystem.read_only);
  const allowedReadOnlyPaths = [
    "/usr/bin",
    "/usr/lib",
    "/usr/share/git-core",
    "/etc",
    "/advisor",
    "/pr-workdir",
    "/pr-review-advisor-context",
    "/pr-review-advisor-tools",
  ];
  for (const requiredPath of allowedReadOnlyPaths) {
    if (!readOnly.includes(requiredPath)) {
      errors.push(`advisor OpenShell policy must grant read-only access to ${requiredPath}`);
    }
  }
  for (const readOnlyPath of readOnly) {
    if (!allowedReadOnlyPaths.includes(readOnlyPath)) {
      errors.push(`advisor OpenShell policy must not grant read access to ${readOnlyPath}`);
    }
  }
  const readWrite = stringArray(filesystem.read_write);
  if (!readWrite.includes("/dev")) {
    errors.push("advisor OpenShell policy must retain writable device access");
  }
  if (!readWrite.includes("/sandbox/pr-review-advisor-runtime")) {
    errors.push("advisor OpenShell policy must retain only its writable runtime subtree");
  }
  for (const writablePath of readWrite) {
    if (!["/dev", "/sandbox/pr-review-advisor-runtime"].includes(writablePath)) {
      errors.push(`advisor OpenShell policy must not grant write access to ${writablePath}`);
    }
  }

  if (asRecord(policy.landlock).compatibility !== "hard_requirement") {
    errors.push("advisor OpenShell policy must fail closed when Landlock is unavailable");
  }
  const processPolicy = asRecord(policy.process);
  if (processPolicy.run_as_user !== "sandbox" || processPolicy.run_as_group !== "sandbox") {
    errors.push("advisor OpenShell policy must run as the sandbox user and group");
  }
  const networkPolicies = asRecord(policy.network_policies);
  if (networkPolicies !== policy.network_policies || Object.keys(networkPolicies).length !== 0) {
    errors.push("advisor OpenShell policy must not allow direct network egress");
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

function checkSandboxNames(
  errors: string[],
  jobs: Array<{ name: string; job: WorkflowRecord }>,
): void {
  const sandboxNames: string[] = [];
  for (const { name, job } of jobs) {
    const advisor = asRecord(asRecord(job.strategy).matrix).advisor;
    if (!Array.isArray(advisor) || advisor.length === 0) {
      errors.push(`${name} matrix must declare a non-empty advisor array`);
      continue;
    }
    const entries = advisor.map(asRecord);
    for (const [index, entry] of entries.entries()) {
      const sandboxName = stringValue(entry.sandbox_name);
      sandboxNames.push(sandboxName);
      if (
        sandboxName.length > OPENSHELL_SANDBOX_NAME_MAX_LENGTH ||
        !OPENSHELL_SANDBOX_NAME_PATTERN.test(sandboxName)
      ) {
        errors.push(
          `${name} matrix entry ${index + 1} sandbox_name must satisfy the OpenShell sandbox-name contract (max 19 characters)`,
        );
      }
    }
  }
  if (new Set(sandboxNames).size !== sandboxNames.length) {
    errors.push("advisor, specialist, and synthesis sandbox_name values must be unique");
  }
}

function checkAnalysisJob(errors: string[], reviewJob: WorkflowRecord): void {
  if (stringValue(reviewJob["runs-on"]) !== "ubuntu-24.04") {
    errors.push("review job must pin the Ubuntu runner used by runtime package versions");
  }
  if (stringValue(reviewJob["continue-on-error"]) !== "${{ !matrix.advisor.publish_comment }}") {
    errors.push("review job failures must be non-blocking only for non-publishing advisor lanes");
  }
  const reviewEnv = asRecord(reviewJob.env);
  const forbiddenJobCredentials = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "PR_REVIEW_ADVISOR_API_KEY",
  ];
  if (
    forbiddenJobCredentials.some((name) => Object.hasOwn(reviewEnv, name)) ||
    containsSecretExpression(reviewEnv) ||
    containsGitHubTokenExpression(reviewEnv)
  ) {
    errors.push("review job-level environment must not expose GitHub or model credentials");
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
  for (const field of ["model", "artifact_dir", "artifact_name", "sandbox_name"]) {
    requireUniqueMatrixField(errors, entries, field);
  }
  for (const [index, entry] of entries.entries()) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(stringValue(entry.artifact_dir))) {
      errors.push(`advisor matrix entry ${index + 1} artifact_dir must be a simple directory name`);
    }
  }

  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_REVIEW_ADVISOR_MODEL",
    "${{ matrix.advisor.model }}",
  );
  requireEnv(errors, "review job", reviewJob, "ADVISOR_DIR", CANONICAL_ADVISOR_DIR);
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
    "PR_REVIEW_ADVISOR_RUN_ANALYSIS",
    CANONICAL_RUN_ANALYSIS_SELECTOR,
  );
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "TARGET_REPO",
    "${{ github.event_name == 'pull_request_target' && github.repository || inputs.target_repo || github.repository }}",
  );
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_NUMBER",
    "${{ github.event.pull_request.number || inputs.target_pr }}",
  );
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "PR_REVIEW_ADVISOR_WORKFLOW_NAME",
    "Automation / PR Review Advisor",
  );
  requireEnv(
    errors,
    "review job",
    reviewJob,
    "OPENSHELL_GATEWAY_ENDPOINT",
    "http://127.0.0.1:8080",
  );
  requireEnv(errors, "review job", reviewJob, "PI_IMAGE", PINNED_PI_IMAGE);
  requireEnv(errors, "review job", reviewJob, "PR_REVIEW_ADVISOR_SANDBOX_TIMEOUT_SECONDS", "2100");
  requireEnv(errors, "review job", reviewJob, "SANDBOX_NAME", "${{ matrix.advisor.sandbox_name }}");

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

  const defaultWorkdir = requireStep(errors, steps, "Set default advisor workdir");
  if (defaultWorkdir && stringValue(defaultWorkdir.if) !== CANONICAL_DEFAULT_WORKDIR_IF) {
    errors.push("Set default advisor workdir must use the canonical dispatch-only condition");
  }
  requireCanonicalRun(
    errors,
    defaultWorkdir,
    CANONICAL_DEFAULT_WORKDIR,
    "Set default advisor workdir must bind ADVISOR_WORKDIR to the fixed pr-workdir checkout",
  );

  const prepare = requireStep(errors, steps, "Prepare isolated analysis workspace");
  const prepareEnv = asRecord(prepare?.env);
  if (prepareEnv.GIT_LFS_SKIP_SMUDGE !== "1") {
    errors.push("Prepare isolated analysis workspace must disable LFS smudging");
  }
  if (prepareEnv.TARGET_DIR !== "${{ github.workspace }}/pr-workdir") {
    errors.push(
      "Prepare isolated analysis workspace must use the fixed pr-workdir upload directory",
    );
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

  const prepareSandbox = requireStep(errors, steps, "Prepare advisor sandbox inputs");
  requireCanonicalRun(
    errors,
    prepareSandbox,
    CANONICAL_PREPARE_SANDBOX,
    "step 'Prepare advisor sandbox inputs' must use the canonical trusted OpenShell helper command",
  );
  const prepareSandboxEnv = asRecord(prepareSandbox?.env);
  if (
    prepareSandboxEnv.GH_TOKEN !== "${{ github.token }}" ||
    Object.keys(prepareSandboxEnv).length !== 1
  ) {
    errors.push("Prepare advisor sandbox inputs must receive only github.token");
  }

  const installOpenShell = requireStep(errors, steps, "Install OpenShell");
  requireCanonicalRun(
    errors,
    installOpenShell,
    CANONICAL_INSTALL_OPENSHELL,
    "step 'Install OpenShell' must use the canonical credential-free trusted installer command",
  );
  if (stringValue(installOpenShell?.if) !== CANONICAL_ANALYSIS_ENABLED_IF) {
    errors.push("Install OpenShell must run only when advisor analysis is requested");
  }

  const configureOpenShell = requireStep(errors, steps, "Configure OpenShell inference");
  requireCanonicalRun(
    errors,
    configureOpenShell,
    CANONICAL_CONFIGURE_OPENSHELL,
    "step 'Configure OpenShell inference' must use the canonical trusted OpenShell helper command",
  );
  const configureEnv = asRecord(configureOpenShell?.env);
  if (
    configureEnv.OPENAI_API_KEY !== "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" ||
    Object.keys(configureEnv).length !== 1
  ) {
    errors.push(
      "Configure OpenShell inference must receive only secrets.PR_REVIEW_ADVISOR_API_KEY as OPENAI_API_KEY",
    );
  }
  if (stringValue(configureOpenShell?.id) !== "configure-openshell") {
    errors.push("Configure OpenShell inference id must be configure-openshell");
  }
  if (stringValue(configureOpenShell?.if) !== CANONICAL_ANALYSIS_ENABLED_IF) {
    errors.push("Configure OpenShell inference must run only when advisor analysis is requested");
  }
  if (configureOpenShell && booleanValue(configureOpenShell["continue-on-error"]) !== true) {
    errors.push(
      "Configure OpenShell inference must continue-on-error until unavailable artifacts are written",
    );
  }

  const unavailable = requireStep(errors, steps, "Write unavailable advisor artifacts");
  if (stringValue(unavailable?.id) !== "unavailable-analysis") {
    errors.push("Write unavailable advisor artifacts id must be unavailable-analysis");
  }
  if (stringValue(unavailable?.if) !== CANONICAL_UNAVAILABLE_IF) {
    errors.push(
      "Write unavailable advisor artifacts must run after skipped or failed configuration",
    );
  }
  requireCanonicalRun(
    errors,
    unavailable,
    CANONICAL_UNAVAILABLE_ANALYSIS,
    "step 'Write unavailable advisor artifacts' must use the canonical trusted fallback command",
  );
  const unavailableEnv = asRecord(unavailable?.env);
  if (
    unavailableEnv.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON !== CANONICAL_UNAVAILABLE_REASON ||
    !Object.hasOwn(unavailableEnv, "BASE_REF") ||
    !Object.hasOwn(unavailableEnv, "HEAD_REF") ||
    Object.keys(unavailableEnv).length !== 3
  ) {
    errors.push(
      "Write unavailable advisor artifacts must receive only refs and the canonical unavailable reason",
    );
  }

  const createSandbox = requireStep(errors, steps, "Create credential-free advisor sandbox");
  requireCanonicalRun(
    errors,
    createSandbox,
    CANONICAL_CREATE_SANDBOX,
    "step 'Create credential-free advisor sandbox' must use the canonical trusted OpenShell helper command",
  );
  if (stringValue(createSandbox?.if) !== "${{ steps.configure-openshell.outcome == 'success' }}") {
    errors.push("Create credential-free advisor sandbox must require successful configuration");
  }

  const analyze = requireStep(errors, steps, "Run PR review advisor");
  requireCanonicalRun(
    errors,
    analyze,
    CANONICAL_RUN_ANALYSIS,
    "step 'Run PR review advisor' must use the canonical trusted analysis command",
  );
  if (stringValue(analyze?.if) !== "${{ steps.configure-openshell.outcome == 'success' }}") {
    errors.push("Run PR review advisor must require successful configuration");
  }
  if (analyze && booleanValue(analyze["continue-on-error"]) !== true) {
    errors.push("Run PR review advisor must continue-on-error until artifacts are uploaded");
  }
  if (
    containsSecretExpression(analyze) ||
    Object.hasOwn(asRecord(analyze?.env), "OPENAI_API_KEY")
  ) {
    errors.push("Run PR review advisor must not receive the upstream model credential");
  }
  const analyzeEnv = asRecord(analyze?.env);
  if (
    unavailableEnv.BASE_REF !== analyzeEnv.BASE_REF ||
    unavailableEnv.HEAD_REF !== analyzeEnv.HEAD_REF
  ) {
    errors.push("Write unavailable advisor artifacts must use the same refs as sandbox analysis");
  }

  const download = requireStep(errors, steps, "Download advisor artifacts from sandbox");
  if (stringValue(download?.id) !== "download-analysis") {
    errors.push("Download advisor artifacts from sandbox id must be download-analysis");
  }
  if (
    stringValue(download?.if) !==
    "${{ always() && steps.configure-openshell.outcome == 'success' }}"
  ) {
    errors.push(
      "Download advisor artifacts from sandbox must run after every configured sandbox analysis",
    );
  }
  if (download && booleanValue(download["continue-on-error"]) !== true) {
    errors.push(
      "Download advisor artifacts from sandbox must continue-on-error until artifacts are uploaded",
    );
  }
  requireCanonicalRun(
    errors,
    download,
    CANONICAL_DOWNLOAD_ARTIFACTS,
    "step 'Download advisor artifacts from sandbox' must use the canonical trusted OpenShell helper command",
  );

  const deleteSandbox = requireStep(errors, steps, "Delete advisor sandbox");
  if (stringValue(deleteSandbox?.if) !== "always()") {
    errors.push("Delete advisor sandbox must run always");
  }
  requireCanonicalRun(
    errors,
    deleteSandbox,
    CANONICAL_DELETE_SANDBOX,
    "step 'Delete advisor sandbox' must use the canonical trusted OpenShell helper command",
  );

  const modelSecretSteps = steps.filter((step) => containsSecretExpression(step));
  if (modelSecretSteps.length !== 1 || modelSecretSteps[0] !== configureOpenShell) {
    errors.push("only OpenShell provider configuration may receive the advisor model credential");
  }
  const githubTokenSteps = steps.filter((step) => containsGitHubTokenExpression(step));
  if (githubTokenSteps.length !== 1 || githubTokenSteps[0] !== prepareSandbox) {
    errors.push("only advisor sandbox input preparation may receive github.token");
  }
  for (const step of [unavailable, createSandbox, analyze, download, deleteSandbox]) {
    const stepEnv = asRecord(step?.env);
    if (
      step &&
      (["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "PR_REVIEW_ADVISOR_API_KEY"].some((name) =>
        Object.hasOwn(stepEnv, name),
      ) ||
        containsGitHubTokenExpression(step) ||
        containsSecretExpression(step))
    ) {
      errors.push(
        `step '${step.name ?? "<unnamed>"}' must remain credential-free after OpenShell configuration`,
      );
    }
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
  const prepareSandboxIndex = steps.findIndex(
    (step) => step.name === "Prepare advisor sandbox inputs",
  );
  const installOpenShellIndex = steps.findIndex((step) => step.name === "Install OpenShell");
  const configureIndex = steps.findIndex((step) => step.name === "Configure OpenShell inference");
  const unavailableIndex = steps.findIndex(
    (step) => step.name === "Write unavailable advisor artifacts",
  );
  const createIndex = steps.findIndex(
    (step) => step.name === "Create credential-free advisor sandbox",
  );
  const analyzeIndex = steps.findIndex((step) => step.name === "Run PR review advisor");
  const downloadIndex = steps.findIndex(
    (step) => step.name === "Download advisor artifacts from sandbox",
  );
  const deleteIndex = steps.findIndex((step) => step.name === "Delete advisor sandbox");
  const installIndex = steps.findIndex((step) => step.name === "Install Pi SDK");
  if (installIndex < 0 || configureIndex < 0 || installIndex > configureIndex) {
    errors.push("pinned advisor tools must be installed before the model credential is exposed");
  }
  if (symlinkIndex < 0 || configureIndex < 0 || symlinkIndex > configureIndex) {
    errors.push(
      "analysis workspace symlinks must be removed before the model credential is exposed",
    );
  }
  if (
    prepareSandboxIndex < 0 ||
    installOpenShellIndex < 0 ||
    configureIndex < 0 ||
    unavailableIndex < 0 ||
    createIndex < 0 ||
    analyzeIndex < 0 ||
    downloadIndex < 0 ||
    deleteIndex < 0 ||
    prepareSandboxIndex > configureIndex ||
    installOpenShellIndex > configureIndex ||
    configureIndex > unavailableIndex ||
    unavailableIndex > createIndex ||
    createIndex > analyzeIndex ||
    analyzeIndex > downloadIndex ||
    downloadIndex > deleteIndex
  ) {
    errors.push(
      "advisor inputs, OpenShell, sandbox execution, artifact download, and cleanup must run in the canonical order",
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
  requireRunContains(errors, outcome, 'if [ "$CONFIGURE_OUTCOME" != "success" ]');
  requireRunContains(errors, outcome, 'if [ "$UNAVAILABLE_OUTCOME" != "success" ]');
  requireRunContains(errors, outcome, 'if [ "$ANALYSIS_REQUESTED" = "0" ]');
  requireRunContains(errors, outcome, 'if [ "$ANALYSIS_OUTCOME" != "success" ]');
  requireRunContains(errors, outcome, 'if [ "$DOWNLOAD_OUTCOME" != "success" ]');
  if (asRecord(outcome?.env).ANALYSIS_OUTCOME !== "${{ steps.analysis.outcome }}") {
    errors.push("Verify advisor analysis outcome must use the trusted analysis step outcome");
  }
  if (asRecord(outcome?.env).ANALYSIS_REQUESTED !== "${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS }}") {
    errors.push("Verify advisor analysis outcome must use the trusted analysis request selector");
  }
  if (asRecord(outcome?.env).DOWNLOAD_OUTCOME !== "${{ steps.download-analysis.outcome }}") {
    errors.push("Verify advisor analysis outcome must use the trusted sandbox download outcome");
  }
  if (asRecord(outcome?.env).CONFIGURE_OUTCOME !== "${{ steps.configure-openshell.outcome }}") {
    errors.push("Verify advisor analysis outcome must use the trusted configuration step outcome");
  }
  if (asRecord(outcome?.env).UNAVAILABLE_OUTCOME !== "${{ steps.unavailable-analysis.outcome }}") {
    errors.push("Verify advisor analysis outcome must use the trusted unavailable step outcome");
  }
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
    ADVISOR_DIR: CANONICAL_ADVISOR_DIR,
    PR_REVIEW_ADVISOR_WORKFLOW_NAME: "Automation / PR Review Advisor",
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

function checkShadowAnalysisTrustBoundary(
  errors: string[],
  jobName: string,
  job: WorkflowRecord,
  steps: readonly WorkflowStep[],
): void {
  const env = asRecord(job.env);
  if (
    ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "PR_REVIEW_ADVISOR_API_KEY"].some((name) =>
      Object.hasOwn(env, name),
    ) ||
    containsSecretExpression(env) ||
    containsGitHubTokenExpression(env)
  ) {
    errors.push(`${jobName} job-level environment must not expose GitHub or model credentials`);
  }
  requireEnv(errors, `${jobName} job`, job, "ADVISOR_DIR", CANONICAL_ADVISOR_DIR);
  const stepNames = steps.map((step) => step.name ?? "<unnamed>");
  if (stepNames.join("\n") !== SHADOW_ANALYSIS_STEP_NAMES.join("\n")) {
    errors.push(`${jobName} steps must match the fixed trusted analysis inventory`);
  }
  rejectUntrustedAdvisorHelperExecution(errors, steps);

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

  const canonicalCommands = [
    ["Prepare isolated analysis workspace", CANONICAL_PREPARE_TARGET_PR],
    ["Prepare advisor sandbox inputs", CANONICAL_PREPARE_SANDBOX],
    ["Install OpenShell", CANONICAL_INSTALL_OPENSHELL],
    ["Configure OpenShell inference", CANONICAL_CONFIGURE_OPENSHELL],
    ["Write unavailable advisor artifacts", CANONICAL_UNAVAILABLE_ANALYSIS],
    ["Create credential-free advisor sandbox", CANONICAL_CREATE_SANDBOX],
    ["Run PR review advisor", CANONICAL_RUN_ANALYSIS],
    ["Download advisor artifacts from sandbox", CANONICAL_DOWNLOAD_ARTIFACTS],
    ["Delete advisor sandbox", CANONICAL_DELETE_SANDBOX],
  ] as const;
  for (const [stepName, command] of canonicalCommands) {
    const step = requireStep(errors, steps, stepName);
    requireCanonicalRun(
      errors,
      step,
      command,
      `${jobName} step '${stepName}' must use the canonical trusted command`,
    );
  }

  const install = requireStep(errors, steps, "Install Pi SDK");
  requireRunLine(
    errors,
    install,
    CANONICAL_ADVISOR_NPM_CI,
    `${jobName} step 'Install Pi SDK' must use the canonical lockfile-only npm ci command`,
  );
  requireRunOrder(errors, install, 'cd "$ADVISOR_DIR"', CANONICAL_ADVISOR_NPM_CI);

  const configure = namedStep(steps, "Configure OpenShell inference");
  const configureEnv = asRecord(configure?.env);
  if (
    configureEnv.OPENAI_API_KEY !== "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}" ||
    Object.keys(configureEnv).length !== 1
  ) {
    errors.push(
      `${jobName} Configure OpenShell inference must receive only the advisor model credential`,
    );
  }
  const prepareSandbox = namedStep(steps, "Prepare advisor sandbox inputs");
  const prepareSandboxEnv = asRecord(prepareSandbox?.env);
  if (
    prepareSandboxEnv.GH_TOKEN !== "${{ github.token }}" ||
    Object.keys(prepareSandboxEnv).length !== 1
  ) {
    errors.push(`${jobName} Prepare advisor sandbox inputs must receive only github.token`);
  }
  const modelSecretSteps = steps.filter((step) => containsSecretExpression(step));
  if (modelSecretSteps.length !== 1 || modelSecretSteps[0] !== configure) {
    errors.push(`${jobName} must expose the advisor model credential only during configuration`);
  }
  const githubTokenSteps = steps.filter((step) => containsGitHubTokenExpression(step));
  if (githubTokenSteps.length !== 1 || githubTokenSteps[0] !== prepareSandbox) {
    errors.push(`${jobName} must expose github.token only during sandbox input preparation`);
  }
}

function checkShadowTopology(
  errors: string[],
  reviewJob: WorkflowRecord,
  specialistJob: WorkflowRecord,
  synthesisJob: WorkflowRecord,
): void {
  const readPermissions = {
    actions: "read",
    checks: "read",
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  };
  requirePermissions(errors, "review-specialists", specialistJob, readPermissions);
  requirePermissions(errors, "review-synthesis-shadow", synthesisJob, readPermissions);
  if (booleanValue(specialistJob["continue-on-error"]) !== true) {
    errors.push("specialist failures must remain non-blocking in shadow mode");
  }
  const strategy = asRecord(specialistJob.strategy);
  if (booleanValue(strategy["fail-fast"]) !== false) {
    errors.push("specialist matrix must disable fail-fast");
  }
  const reviewEntries = asRecord(asRecord(reviewJob.strategy).matrix).advisor;
  const publishingReviewEntries = Array.isArray(reviewEntries)
    ? reviewEntries.map(asRecord).filter((entry) => booleanValue(entry.publish_comment) === true)
    : [];
  const primaryModel =
    publishingReviewEntries.length === 1 ? stringValue(publishingReviewEntries[0].model) : "";
  const entries = asRecord(strategy.matrix).advisor;
  const expected = ["behavior", "trust", "design-architecture", "operations", "documentation"];
  if (!Array.isArray(entries) || entries.length !== expected.length) {
    errors.push("specialist matrix must declare exactly five interests");
  } else {
    const records = entries.map(asRecord);
    if (records.map((entry) => stringValue(entry.interest)).join(",") !== expected.join(",")) {
      errors.push("specialist matrix interests must match the trusted five-interest order");
    }
    if (!primaryModel || records.some((entry) => stringValue(entry.model) !== primaryModel)) {
      errors.push("specialists must use the publishing review model");
    }
  }
  requireEnv(
    errors,
    "specialist job",
    specialistJob,
    "PR_REVIEW_ADVISOR_INTEREST",
    "${{ matrix.advisor.interest }}",
  );
  requireEnv(
    errors,
    "specialist job",
    specialistJob,
    "PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR",
    "",
  );
  requireEnv(
    errors,
    "synthesis job",
    synthesisJob,
    "PR_REVIEW_ADVISOR_SPECIALIST_SESSION_DIR",
    "${{ github.workspace }}/pr-workdir/.pr-review-advisor-sessions",
  );
  if (synthesisJob.needs !== "review-specialists") {
    errors.push("shadow synthesis must depend only on the specialist matrix");
  }
  const specialistSteps = asSteps(specialistJob.steps);
  const synthesisSteps = asSteps(synthesisJob.steps);
  requireActionPins(errors, "review-specialists", specialistSteps);
  requireActionPins(errors, "review-synthesis-shadow", synthesisSteps);
  checkShadowAnalysisTrustBoundary(errors, "review-specialists", specialistJob, specialistSteps);
  checkShadowAnalysisTrustBoundary(errors, "review-synthesis-shadow", synthesisJob, synthesisSteps);
  const upload = requireStep(errors, specialistSteps, "Upload native specialist session");
  if (stringValue(upload?.id) !== "upload-specialist-session") {
    errors.push("Upload native specialist session id must be upload-specialist-session");
  }
  requireWith(errors, upload, "name", "${{ matrix.advisor.artifact_name }}");
  requireWith(
    errors,
    upload,
    "path",
    "artifacts/${{ matrix.advisor.artifact_dir }}/pr-review-${{ matrix.advisor.interest }}-session.jsonl",
  );
  requireWith(errors, upload, "if-no-files-found", "error");
  const specialistOutcome = requireStep(errors, specialistSteps, "Verify advisor analysis outcome");
  const specialistOutcomeEnv = asRecord(specialistOutcome?.env);
  if (specialistOutcomeEnv.ADVISOR_INTEREST !== "${{ matrix.advisor.interest }}") {
    errors.push("specialist outcome must use the matrix interest");
  }
  if (
    specialistOutcomeEnv.SPECIALIST_UPLOAD_OUTCOME !==
    "${{ steps.upload-specialist-session.outcome }}"
  ) {
    errors.push("specialist outcome must use the native session upload outcome");
  }
  requireRunContains(errors, specialistOutcome, 'if [ -n "$ADVISOR_INTEREST" ]');
  requireRunContains(errors, specialistOutcome, 'if [ "$SPECIALIST_UPLOAD_OUTCOME" != "success" ]');
  const download = requireStep(errors, synthesisSteps, "Download specialist session artifacts");
  requireWith(errors, download, "pattern", "pr-review-specialist-*");
  requireWith(errors, download, "path", "pr-workdir/.pr-review-advisor-sessions");
  requireWith(errors, download, "merge-multiple", true);
  if (JSON.stringify(synthesisJob).includes("pull-requests: write")) {
    errors.push("shadow synthesis must not receive PR-write permission");
  }
}

export function validatePrReviewAdvisorWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  packageLockPath = DEFAULT_PACKAGE_LOCK_PATH,
  openshellPolicyPath = DEFAULT_OPENSHELL_POLICY_PATH,
): string[] {
  const errors: string[] = [];
  let workflow: WorkflowRecord;
  try {
    workflow = asRecord(YAML.parse(readFileSync(workflowPath, "utf-8")));
  } catch {
    return [`failed to read or parse workflow: ${workflowPath}`];
  }

  if (workflow.name !== "Automation / PR Review Advisor") {
    errors.push("workflow name must remain Automation / PR Review Advisor");
  }
  checkAdvisorRuntimePackageLock(errors, packageLockPath);
  checkOpenShellPolicy(errors, openshellPolicyPath);
  checkTargetTriggers(errors, workflow);
  const concurrencyGroup = stringValue(asRecord(workflow.concurrency).group);
  if (!concurrencyGroup.includes("github.event_name")) {
    errors.push("workflow concurrency must distinguish event types");
  }

  const jobs = asRecord(workflow.jobs);
  const reviewJob = asRecord(jobs.review);
  const specialistJob = asRecord(jobs["review-specialists"]);
  const synthesisJob = asRecord(jobs["review-synthesis-shadow"]);
  const publishJob = asRecord(jobs.publish);
  if (Object.keys(reviewJob).length === 0) errors.push("workflow must declare the review job");
  if (Object.keys(specialistJob).length === 0)
    errors.push("workflow must declare the specialist matrix");
  if (Object.keys(synthesisJob).length === 0) errors.push("workflow must declare shadow synthesis");
  if (Object.keys(publishJob).length === 0) errors.push("workflow must declare the publish job");
  checkPrivilegeDomains(errors, workflow, reviewJob, publishJob);
  checkSandboxNames(errors, [
    { name: "advisor", job: reviewJob },
    { name: "specialist", job: specialistJob },
    { name: "synthesis", job: synthesisJob },
  ]);
  checkAnalysisJob(errors, reviewJob);
  checkShadowTopology(errors, reviewJob, specialistJob, synthesisJob);
  checkPublishJob(errors, publishJob);
  return errors;
}
