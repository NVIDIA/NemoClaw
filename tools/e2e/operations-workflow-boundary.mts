// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";
import YAML from "yaml";
import { RISK_RULES } from "../advisors/risk-plan.mts";
import { validateStandardProfileWorkflowBoundary } from "./standard-profile-workflow-boundary.mts";
import { catalogueTarget, E2E_TARGET_CATALOGUE } from "./target-catalogue.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "e2e.yaml");
const DEFAULT_ADVISOR_PATH = join(REPO_ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const META_JOBS = new Set([
  "native-runtime-qualification-podman-toolchain",
  "native-runtime-qualification-producer-plan",
  "release-qualification",
  "relevant-e2e",
  "report-to-pr",
  "scorecard",
]);
const FULL_SHA_ACTION = /^[^\s@]+@[0-9a-f]{40}$/u;
const GITHUB_SCRIPT_NODE24_ACTION =
  "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3";
const DOWNLOAD_ARTIFACT_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const PR_GATE_REPORTER = "test/e2e/risk-signal-reporter.ts";
const LIVE_VITEST_HELPER = "tools/e2e/live-vitest-invocation.mts run --test-path";
const E2E_ARTIFACT_ACTION = "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@";
const COLD_ONBOARD_PERFORMANCE_EVIDENCE_PATH =
  "e2e-artifacts/live/${{ matrix.id }}/onboard-progress-budget.json";
const PUBLICATION_REQUIRED_CONDITION = "${{ steps.publication_mode.outputs.required == '1' }}";
const PUBLICATION_REUSE_CONDITION = "${{ steps.publication_mode.outputs.reuse == '1' }}";
const PUBLICATION_REQUIRED_OR_REUSE_CONDITION =
  "${{ steps.publication_mode.outputs.required == '1' || steps.publication_mode.outputs.reuse == '1' }}";
const PUBLICATION_CLASSIFIER_SCRIPT =
  [
    "set -euo pipefail",
    "reuse=0",
    'case "${REPOSITORY}:${REF}:${EVENT_NAME}:${CHECKOUT_SHA:+controller}" in',
    "  NVIDIA/NemoClaw:refs/heads/main:push:|NVIDIA/NemoClaw:refs/heads/main:workflow_dispatch:)",
    "    required=1",
    "    ;;",
    "  NVIDIA/NemoClaw:refs/heads/*:workflow_dispatch:controller)",
    "    required=0",
    "    reuse=1",
    "    ;;",
    "  *)",
    '    echo "::error::base-image publication mode is not trusted" >&2',
    "    exit 1",
    "    ;;",
    "esac",
    'printf \'required=%s\\n\' "${required}" >> "${GITHUB_OUTPUT}"',
    'printf \'reuse=%s\\n\' "${reuse}" >> "${GITHUB_OUTPUT}"',
  ].join("\n") + "\n";
const ISSUE_API_REFERENCE = /\bgithub\.rest\.issues\b/u;
const ISSUE_MUTATION_BEYOND_COMMENT =
  /github\.rest\.issues\.(?:addAssignees|addLabels|create|deleteComment|lock|removeAssignees|removeLabel|setLabels|unlock|update|updateComment)\s*\(/u;
const GENERIC_GITHUB_WRITE_SURFACE =
  /github\s*(?:(?:\?\.|\.)\s*(?:graphql|request)\b|\[\s*["'](?:graphql|request)["']\s*\])|\b(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*\s*=\s*github\b|\{[^}]*\b(?:graphql|request)\b[^}]*\}\s*=\s*github(?:\.rest)?\b)|\bfetch\b|\bgh\s+api\b/u;
const GH_API_WRITE_METHOD =
  /\bgh\s+api\b[\s\S]{0,160}?(?:(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)\b|graphql\b[\s\S]{0,160}?\bmutation\b)/iu;
const NATIVE_RUNTIME_QUALIFICATION_READ_JOBS = new Set([
  "native-runtime-qualification-producer-plan",
  "native-runtime-qualification-producer-aggregate",
]);
const GENERIC_ISSUE_REST_MUTATION =
  /github\.request\s*\(\s*["'`](?:POST|PATCH|PUT|DELETE)\s+\/repos\/[^/\s]+\/[^/\s]+\/issues(?:\/|\b)/u;
const GENERIC_ISSUE_GRAPHQL_MUTATION =
  /github\.graphql\s*\(\s*["'`]\s*mutation\b[\s\S]*?\b(?:addComment|closeIssue|createIssue|reopenIssue|updateIssue)\b/u;
const NEEDS_INTERPOLATION = /\$\{\{\s*toJSON\s*\(\s*needs\s*\)\s*\}\}/iu;

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowPermissions = Record<string, unknown> | string;

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  name?: unknown;
  needs?: unknown;
  outputs?: Record<string, unknown>;
  permissions?: WorkflowPermissions;
  "runs-on"?: unknown;
  steps?: WorkflowStep[];
  "timeout-minutes"?: unknown;
};

export type OperationsWorkflow = {
  concurrency?: {
    "cancel-in-progress"?: unknown;
    group?: unknown;
  };
  env?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
  permissions?: WorkflowPermissions;
  "run-name"?: unknown;
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

function isNeedsEnvironmentAccess(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "NEEDS_JSON") {
    return false;
  }
  const environment = expression.expression;
  return (
    ts.isPropertyAccessExpression(environment) &&
    environment.name.text === "env" &&
    ts.isIdentifier(environment.expression) &&
    environment.expression.text === "process"
  );
}

function isNeedsEnvironmentParse(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return false;
  }
  const parser = expression.expression;
  const input = expression.arguments[0];
  return (
    ts.isPropertyAccessExpression(parser) &&
    ts.isIdentifier(parser.expression) &&
    parser.expression.text === "JSON" &&
    parser.name.text === "parse" &&
    ts.isBinaryExpression(input) &&
    input.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    isNeedsEnvironmentAccess(input.left) &&
    ts.isStringLiteral(input.right) &&
    input.right.text === "{}"
  );
}

function assignsNeedsFromEnvironment(script: string): boolean {
  const source = ts.createSourceFile(
    "github-script.js",
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "needs" &&
      node.initializer !== undefined &&
      isNeedsEnvironmentParse(node.initializer)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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

function passesNeedsAsEnvironmentData(step: WorkflowStep): boolean {
  const script = String(step.with?.script ?? "");
  return (
    step.env?.NEEDS_JSON === "${{ toJSON(needs) }}" &&
    !NEEDS_INTERPOLATION.test(script) &&
    assignsNeedsFromEnvironment(script)
  );
}

function validateManualPrDispatch(errors: string[], workflow: OperationsWorkflow): void {
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  for (const name of [
    "jobs",
    "pr_number",
    "checkout_sha",
    "checkout_repository",
    "base_sha",
    "workflow_sha",
    "correlation_id",
  ]) {
    const input = inputs[name];
    if (input?.type !== "string" || input.default !== "") {
      errors.push(`workflow_dispatch ${name} must be an optional string with an empty default`);
    }
  }
  const expectedEnvironment = {
    NEMOCLAW_E2E_CORRELATION_ID: "${{ inputs.correlation_id }}",
    NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
    NEMOCLAW_E2E_SHARD: "default",
  };
  for (const [name, value] of Object.entries(expectedEnvironment)) {
    if (workflow.env?.[name] !== value) errors.push(`E2E workflow must bind ${name}`);
  }
  const runName = String(workflow["run-name"] ?? "");
  for (const fragment of ["inputs.checkout_sha", "inputs.pr_number"]) {
    if (!runName.includes(fragment)) errors.push(`Manual PR E2E run name must include ${fragment}`);
  }
  const concurrencyGroup = String(workflow.concurrency?.group ?? "");
  if (
    !concurrencyGroup.includes("inputs.checkout_sha") ||
    !concurrencyGroup.includes("inputs.pr_number") ||
    !concurrencyGroup.includes("manual-pr")
  ) {
    errors.push("Manual PR E2E concurrency must be scoped to its pull request");
  }
  if (
    workflow.concurrency?.["cancel-in-progress"] !==
    "${{ inputs.checkout_sha != '' && !inputs.allow_jetson_dispatch && !contains(format(',{0},', inputs.jobs), ',staging-brev-launchable,') && !contains(format(',{0},', inputs.jobs), ',staging-brev-launchable-identity,') && !inputs.include_staging_brev_launchable }}"
  ) {
    errors.push(
      "Manual PR E2E concurrency must not cancel an active Jetson or Launchable dispatch",
    );
  }

  const matrixJob = workflow.jobs["generate-matrix"] ?? {};
  const steps = matrixJob.steps ?? [];
  const authenticationIndex = steps.findIndex(
    (step) => step.name === "Authenticate manual PR dispatch",
  );
  const checkoutIndex = steps.findIndex((step) => step.name === "Check out E2E candidate");
  const validationIndex = steps.findIndex((step) => step.name === "Validate manual PR checkout");
  const credentialAuthorizationIndex = steps.findIndex(
    (step) => step.name === "Authorize E2E credentials",
  );
  const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
  if (
    authenticationIndex < 0 ||
    checkoutIndex < 0 ||
    validationIndex < 0 ||
    credentialAuthorizationIndex < 0 ||
    prepareIndex < 0 ||
    authenticationIndex >= checkoutIndex ||
    checkoutIndex >= validationIndex ||
    validationIndex >= credentialAuthorizationIndex ||
    credentialAuthorizationIndex >= prepareIndex
  ) {
    errors.push("Manual PR authorization and validation must surround checkout before preparation");
  }

  const authentication = authenticationIndex >= 0 ? steps[authenticationIndex] : {};
  if (
    authentication.id !== "candidate_authorization" ||
    authentication.if !==
      "${{ inputs.pr_number != '' || inputs.checkout_sha != '' || inputs.checkout_repository != '' || inputs.base_sha != '' || inputs.workflow_sha != '' }}"
  ) {
    errors.push("Manual PR authentication must run when any candidate identity input is present");
  }
  const authEnvironment = {
    BASE_SHA: "${{ inputs.base_sha }}",
    CHECKOUT_REPOSITORY: "${{ inputs.checkout_repository }}",
    CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
    EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
    GITHUB_TOKEN: "${{ github.token }}",
    INCLUDE_LAUNCHABLE: "${{ inputs.include_staging_brev_launchable && 'true' || 'false' }}",
    JOBS: "${{ inputs.jobs }}",
    PR_NUMBER: "${{ inputs.pr_number }}",
    WORKFLOW_EVENT: "${{ github.event_name }}",
    WORKFLOW_REF: "${{ github.ref }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  };
  for (const [name, value] of Object.entries(authEnvironment)) {
    if (authentication.env?.[name] !== value)
      errors.push(`Manual PR authentication must bind ${name}`);
  }
  const authSource = String(authentication.run ?? "");
  for (const fragment of [
    '"$WORKFLOW_EVENT" == "workflow_dispatch"',
    '"$WORKFLOW_REF" == refs/heads/*',
    '"$PR_NUMBER" =~ ^[1-9][0-9]*$',
    '"$CHECKOUT_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
    '"$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$',
    '"$BASE_SHA" =~ ^[a-f0-9]{40}$',
    '"$EXPECTED_WORKFLOW_SHA" == "$WORKFLOW_SHA"',
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}",
    `[[ "$(jq -r '.base.repo.full_name // ""' <<< "$pull_json")" == "NVIDIA/NemoClaw" ]]`,
    `[[ "$(jq -r '.base.ref // ""' <<< "$pull_json")" == "main" ]]`,
    `[[ "$(jq -r '.head.repo.full_name // ""' <<< "$pull_json")" == "$CHECKOUT_REPOSITORY" ]]`,
    `[[ "$(jq -r '.head.sha' <<< "$pull_json")" == "$CHECKOUT_SHA" ]]`,
    `[[ "$(jq -r '.base.sha' <<< "$pull_json")" == "$BASE_SHA" ]]`,
    '"$INCLUDE_LAUNCHABLE" == "true"',
    '",${JOBS}," == *",staging-brev-launchable,"*',
    '",${JOBS}," == *",staging-brev-launchable-identity,"*',
    "Launchable identity smoke runs only against trusted main",
    '"$nvidia_owned" == "true"',
    "Launchable PR E2E requires an NVIDIA-owned source repository",
    '"$CHECKOUT_REPOSITORY" == "NVIDIA/NemoClaw"',
    "Launchable PR E2E requires a branch in NVIDIA/NemoClaw",
    `"$(jq -r '.head.repo.owner.login // ""' <<< "$pull_json")" == "NVIDIA"`,
    `"$(jq -r '.head.repo.owner.type // ""' <<< "$pull_json")" == "Organization"`,
    "nvidia_owned=false",
    "nvidia_owned=true",
    `printf 'nvidia_owned=%s\\n' "$nvidia_owned" >> "$GITHUB_OUTPUT"`,
  ]) {
    if (!authSource.includes(fragment))
      errors.push(`Manual PR authentication must retain ${fragment}`);
  }

  const qualificationPlanName = "native-runtime-qualification-producer-plan";
  const qualificationPlan = workflow.jobs[qualificationPlanName] ?? {};
  const trustedMainPlanCondition =
    "${{ github.event_name == 'workflow_dispatch' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha != '' && inputs.jobs == 'native-runtime-qualification-producer' && inputs.targets == '' }}";
  if (qualificationPlan.if !== trustedMainPlanCondition) {
    errors.push("Native runtime qualification producer plan must execute only from trusted main");
  }
  for (const jobName of [
    "native-runtime-qualification-podman-toolchain",
    "native-runtime-qualification-producer",
    "native-runtime-qualification-producer-aggregate",
  ]) {
    if (!needs(workflow.jobs[jobName] ?? {}).includes(qualificationPlanName)) {
      errors.push(`${jobName} must depend on the trusted-main qualification producer plan`);
    }
  }

  const validation = validationIndex >= 0 ? steps[validationIndex] : {};
  if (
    validation.if !==
    "${{ inputs.checkout_sha != '' && (inputs.jobs != 'native-runtime-qualification-producer' || inputs.targets != '') }}"
  ) {
    errors.push("Manual PR checkout validation must skip qualification producer dispatches");
  }
  const validationSource = String(validation.run ?? "");
  if (
    validation.env?.NVIDIA_OWNED !== "${{ steps.candidate_authorization.outputs.nvidia_owned }}"
  ) {
    errors.push("Manual PR checkout validation must bind authenticated NVIDIA ownership");
  }
  for (const fragment of [
    '"$(git rev-parse --verify HEAD)" == "$CHECKOUT_SHA"',
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}",
    "pull request must still be open",
    "pull request base repository changed before execution",
    "pull request base branch changed before execution",
    "checkout_repository changed before execution",
    "checkout_sha changed before execution",
    "base_sha changed before execution",
    '"$NVIDIA_OWNED" == "true"',
    "PR source repository ownership changed before execution",
  ]) {
    if (!validationSource.includes(fragment)) {
      errors.push(`Manual PR checkout validation must retain ${fragment}`);
    }
  }

  const credentialAuthorization =
    credentialAuthorizationIndex >= 0 ? steps[credentialAuthorizationIndex] : {};
  if (
    matrixJob.outputs?.e2e_credentials_allowed !== "${{ steps.e2e_credentials.outputs.allowed }}" ||
    credentialAuthorization.id !== "e2e_credentials" ||
    credentialAuthorization.if !==
      "${{ inputs.checkout_sha != '' && (inputs.jobs != 'native-runtime-qualification-producer' || inputs.targets != '') }}" ||
    credentialAuthorization.shell !== "bash"
  ) {
    errors.push("Manual PR credential authorization must expose only the authorization result");
  }
  const expectedCredentialAuthorizationEnvironment = {
    CHECKOUT_REPOSITORY: "${{ inputs.checkout_repository }}",
    CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
    EVENT_NAME: "${{ github.event_name }}",
    EXPECTED_WORKFLOW_SHA: "${{ inputs.workflow_sha }}",
    NVIDIA_OWNED: "${{ steps.candidate_authorization.outputs.nvidia_owned }}",
    REF: "${{ github.ref }}",
    WORKFLOW_REPOSITORY: "${{ github.repository }}",
    WORKFLOW_SHA: "${{ github.workflow_sha }}",
  };
  if (!isDeepStrictEqual(credentialAuthorization.env, expectedCredentialAuthorizationEnvironment)) {
    errors.push(
      "Manual PR credential authorization must bind the workflow and checkout identities",
    );
  }
  const authorizationSource = String(credentialAuthorization.run ?? "");
  for (const fragment of [
    '"$WORKFLOW_REPOSITORY" == "NVIDIA/NemoClaw"',
    '"$NVIDIA_OWNED" == "true"',
    '"$EVENT_NAME" == "workflow_dispatch"',
    '"$REF" == refs/heads/*',
    '"$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$',
    '"$WORKFLOW_SHA" =~ ^[a-f0-9]{40}$',
    '"$EXPECTED_WORKFLOW_SHA" == "$WORKFLOW_SHA"',
    '"$(git rev-parse --verify HEAD)" == "$CHECKOUT_SHA"',
    "credentials_allowed=false",
    "credentials_allowed=true",
    'printf \'allowed=%s\\n\' "$credentials_allowed" >> "$GITHUB_OUTPUT"',
  ]) {
    if (!authorizationSource.includes(fragment)) {
      errors.push(`Manual PR credential authorization must retain ${fragment}`);
    }
  }

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const trustedHermesFixtureCheckout =
        jobName === "hermes-gpu-startup" &&
        step.name === "Checkout trusted Hermes GPU runtime fixture" &&
        step.with?.repository === "NVIDIA/NemoClaw" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedE2ePlannerCheckout =
        jobName === "generate-matrix" &&
        step.name === "Check out trusted E2E planner" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedReportHelperCheckout =
        jobName === "report-to-pr" &&
        step.name === "Check out the trusted E2E reporting helper" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedReleaseQualificationCheckout =
        jobName === "release-qualification" &&
        step.name === "Check out the qualification evaluator" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedRelevantE2eCheckout =
        jobName === "relevant-e2e" &&
        step.name === "Check out the E2E result evaluator" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedLaunchableLaneCheckout =
        ((jobName === "staging-brev-launchable" &&
          step.name === "Checkout trusted Launchable lane") ||
          (jobName === "staging-brev-launchable-identity" &&
            step.name === "Checkout trusted Launchable identity lane")) &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedPublicationCheckout =
        jobName === "base-image-publication" &&
        step.name === "Check out trusted E2E workflow" &&
        step.if === PUBLICATION_REQUIRED_OR_REUSE_CONDITION &&
        step.with?.ref === "${{ inputs.checkout_sha || github.sha }}";
      const trustedManagedImageRuntimeCheckout =
        jobName === "managed-image-protected-runtime" &&
        step.name === "Checkout trusted protected runtime qualification" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ inputs.workflow_sha || github.workflow_sha }}";
      const trustedManagedImageMultiarchResolverCheckout =
        jobName === "managed-image-multiarch-startup" &&
        step.name === "Checkout trusted Hermes resolver" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ inputs.workflow_sha || github.workflow_sha }}";
      const trustedLlamaCppPlanCheckout =
        jobName === "llama-cpp-dgx-spark-plan" &&
        step.name === "Checkout trusted llama.cpp plan compiler" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ inputs.workflow_sha || github.workflow_sha }}";
      const trustedLlamaCppQualificationCheckout =
        jobName === "llama-cpp-dgx-spark-qualification" &&
        step.name === "Checkout trusted llama.cpp qualification" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ inputs.workflow_sha || github.workflow_sha }}";
      const trustedJetsonControllerCheckout =
        jobName === "jetson-nvmap-gpu" &&
        step.name === "Check out trusted Jetson controller" &&
        step.with?.repository === "NVIDIA/NemoClaw" &&
        step.with?.ref === "${{ github.workflow_sha }}";
      const trustedOpenShellDevToolingCheckout =
        ["mcp-bridge-dev", "openshell-dev-artifact"].includes(jobName) &&
        step.name === "Checkout trusted OpenShell dev tooling" &&
        step.with?.repository === "${{ github.repository }}" &&
        step.with?.ref === "${{ inputs.workflow_sha || github.workflow_sha }}" &&
        step.with?.path === ".trusted-openshell-dev-artifact";
      const nativeRuntimeQualificationCheckout =
        (jobName === "native-runtime-qualification-podman-toolchain" &&
          step.name === "Check out the pinned Podman source" &&
          step.with?.repository === "podman-container-tools/podman" &&
          step.with?.ref === "cade97a52ebdf9dbf9e81de8009015776837a074" &&
          step.with?.path === ".podman-source" &&
          step.with?.["fetch-depth"] === 1 &&
          step.with?.["persist-credentials"] === false) ||
        (jobName === "native-runtime-qualification-podman-toolchain" &&
          step.name === "Check out the pinned Netavark source" &&
          step.with?.repository === "containers/netavark" &&
          step.with?.ref === "8e91ad1d947ed325327b638f0cb906bea1f7d0ab" &&
          step.with?.path === ".netavark-source" &&
          step.with?.["fetch-depth"] === 1 &&
          step.with?.["persist-credentials"] === false) ||
        (jobName === "native-runtime-qualification-podman-toolchain" &&
          step.name === "Check out the pinned Aardvark DNS source" &&
          step.with?.repository === "containers/aardvark-dns" &&
          step.with?.ref === "cd7417681229219059939bdd9f0b3bd9ac9abb08" &&
          step.with?.path === ".aardvark-source" &&
          step.with?.["fetch-depth"] === 1 &&
          step.with?.["persist-credentials"] === false) ||
        (jobName === "native-runtime-qualification-producer-plan" &&
          step.name === "Check out the trusted qualification producer" &&
          step.with?.ref === "${{ github.workflow_sha }}") ||
        (jobName === "native-runtime-qualification-producer" &&
          step.name === "Check out the trusted qualification harness" &&
          step.with?.ref === "${{ matrix.source.workflowSha }}") ||
        (jobName === "native-runtime-qualification-producer" &&
          step.name === "Check out the candidate commit" &&
          step.with?.repository === "${{ matrix.source.candidateRepository }}" &&
          step.with?.ref === "${{ matrix.source.candidateSha }}") ||
        (jobName === "native-runtime-qualification-producer-aggregate" &&
          step.name === "Check out the qualification aggregator" &&
          step.with?.repository === "${{ github.repository }}" &&
          step.with?.ref === "${{ github.workflow_sha }}");
      const trustedCheckout =
        trustedHermesFixtureCheckout ||
        trustedE2ePlannerCheckout ||
        trustedReportHelperCheckout ||
        trustedReleaseQualificationCheckout ||
        trustedRelevantE2eCheckout ||
        trustedLaunchableLaneCheckout ||
        trustedPublicationCheckout ||
        trustedManagedImageMultiarchResolverCheckout ||
        trustedManagedImageRuntimeCheckout ||
        trustedLlamaCppPlanCheckout ||
        trustedLlamaCppQualificationCheckout ||
        trustedJetsonControllerCheckout ||
        nativeRuntimeQualificationCheckout ||
        trustedOpenShellDevToolingCheckout;
      if (
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.ref !== "${{ inputs.checkout_sha || github.sha }}" &&
        !trustedCheckout
      ) {
        errors.push(`${jobName} checkout must use the selected PR commit`);
      }
      if (
        step.uses?.startsWith("actions/checkout@") &&
        !trustedCheckout &&
        step.with?.repository !== "${{ inputs.checkout_repository || github.repository }}"
      ) {
        errors.push(`${jobName} checkout must use the selected PR source repository`);
      }
    }
  }
}

export function validateBaseImagePublicationGate(workflow: OperationsWorkflow): string[] {
  const errors: string[] = [];
  const job = workflow.jobs["base-image-publication"] ?? {};
  const expectedJob = {
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 55,
    outputs: {
      dcode_base_contract:
        "${{ steps.validate_dcode_base.outputs.contract || steps.validate_reused_dcode_base.outputs.contract }}",
      dcode_base_ref:
        "${{ steps.validate_dcode_base.outputs.base_ref || steps.validate_reused_dcode_base.outputs.base_ref }}",
      managed_image_revision:
        "${{ steps.publication.outputs.head_sha || (steps.publication_mode.outputs.reuse == '1' && 'e38db201413b457614904187377ed9fd002d281d') || inputs.checkout_sha || github.sha }}",
    },
    permissions: {
      actions: "read",
      contents: "read",
    },
    steps: [
      {
        id: "publication_mode",
        name: "Classify base-image publication requirement",
        env: {
          CHECKOUT_SHA: "${{ inputs.checkout_sha }}",
          EVENT_NAME: "${{ github.event_name }}",
          REF: "${{ github.ref }}",
          REPOSITORY: "${{ github.repository }}",
        },
        shell: "bash",
        run: PUBLICATION_CLASSIFIER_SCRIPT,
      },
      {
        name: "Check out trusted E2E workflow",
        if: PUBLICATION_REQUIRED_OR_REUSE_CONDITION,
        uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        with: {
          ref: "${{ inputs.checkout_sha || github.sha }}",
          "fetch-depth": 0,
          "persist-credentials": false,
        },
      },
      {
        name: "Set up Node for publication verification",
        if: PUBLICATION_REQUIRED_OR_REUSE_CONDITION,
        uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
        with: {
          "node-version": 22,
        },
      },
      {
        id: "publication",
        name: "Verify applicable base-image publication",
        if: PUBLICATION_REQUIRED_CONDITION,
        env: {
          EXPECTED_SHA: "${{ inputs.checkout_sha || github.sha }}",
          GITHUB_TOKEN: "${{ github.token }}",
          REQUIRE_MANAGED_IMAGE_PUBLICATION: "1",
        },
        shell: "bash",
        run: [
          "set -euo pipefail",
          "export GITHUB_REF=refs/heads/main",
          'export GITHUB_SHA="$EXPECTED_SHA"',
          "node --experimental-strip-types --no-warnings tools/e2e/base-image-publication.mts --wait-seconds 3000 --poll-seconds 30",
          "",
        ].join("\n"),
      },
      {
        name: "Download immutable Deep Agents Code base contract",
        if: PUBLICATION_REQUIRED_CONDITION,
        env: {
          GITHUB_TOKEN: "${{ github.token }}",
          PUBLICATION_HEAD_SHA: "${{ steps.publication.outputs.head_sha }}",
          PUBLICATION_RUN_ATTEMPT: "${{ steps.publication.outputs.run_attempt }}",
          PUBLICATION_RUN_ID: "${{ steps.publication.outputs.run_id }}",
        },
        run: 'node --experimental-strip-types --no-warnings tools/e2e/exact-artifact-download.mts "${RUNNER_TEMP}/dcode-base-contract"',
      },
      {
        name: "Download reused Deep Agents Code base contract",
        if: PUBLICATION_REUSE_CONDITION,
        env: {
          GITHUB_TOKEN: "${{ github.token }}",
          PUBLICATION_HEAD_SHA: "e38db201413b457614904187377ed9fd002d281d",
          PUBLICATION_RUN_ATTEMPT: "1",
          PUBLICATION_RUN_ID: "32544159037",
        },
        run: 'node --experimental-strip-types --no-warnings tools/e2e/exact-artifact-download.mts "${RUNNER_TEMP}/dcode-base-contract-reused"',
      },
      {
        id: "validate_dcode_base",
        name: "Validate immutable Deep Agents Code base",
        if: PUBLICATION_REQUIRED_CONDITION,
        env: {
          PUBLICATION_HEAD_SHA: "${{ steps.publication.outputs.head_sha }}",
          PUBLICATION_RUN_ATTEMPT: "${{ steps.publication.outputs.run_attempt }}",
          PUBLICATION_RUN_ID: "${{ steps.publication.outputs.run_id }}",
        },
        run: 'node --experimental-strip-types --no-warnings tools/e2e/dcode-base-image-contract.mts "${RUNNER_TEMP}/dcode-base-contract/contract.json"',
      },
      {
        id: "validate_reused_dcode_base",
        name: "Validate reused Deep Agents Code base",
        if: PUBLICATION_REUSE_CONDITION,
        env: {
          PUBLICATION_HEAD_SHA: "e38db201413b457614904187377ed9fd002d281d",
          PUBLICATION_RUN_ATTEMPT: "1",
          PUBLICATION_RUN_ID: "32544159037",
        },
        run: 'node --experimental-strip-types --no-warnings tools/e2e/dcode-base-image-contract.mts "${RUNNER_TEMP}/dcode-base-contract-reused/contract.json"',
      },
    ],
  };

  if (!isDeepStrictEqual(job, expectedJob)) {
    errors.push(
      "base-image-publication job must preserve its exact trusted-mode classifier, minimal permissions, pinned checkout, and verifier boundary",
    );
  }
  const matrix = workflow.jobs["generate-matrix"] ?? {};
  if (needs(matrix).includes("base-image-publication")) {
    errors.push("generate-matrix must not wait for base-image-publication");
  }
  const matrixOutputs = matrix.outputs ?? {};
  if ("dcode_base_contract" in matrixOutputs || "dcode_base_ref" in matrixOutputs) {
    errors.push("generate-matrix must not relay Deep Agents Code base outputs");
  }
  const live = workflow.jobs.live ?? {};
  if (!sameMembers(needs(live), ["base-image-publication", "generate-matrix"])) {
    errors.push("live E2E must wait for matrix generation and base-image publication");
  }
  if (
    live.env?.NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF !==
    "${{ needs.base-image-publication.outputs.dcode_base_ref }}"
  ) {
    errors.push("live DCode must use the selected immutable base reference");
  }
  const evidence = findStep(live, "Record immutable Deep Agents Code base evidence");
  const upload = findStep(live, "Upload E2E artifacts");
  const uploadPaths = String(upload.with?.path ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const liveSteps = live.steps ?? [];
  if (
    evidence.if !== "${{ matrix.id == 'ubuntu-repo-cloud-langchain-deepagents-code' }}" ||
    evidence.env?.BASE_CONTRACT !==
      "${{ needs.base-image-publication.outputs.dcode_base_contract }}" ||
    !String(evidence.run ?? "").includes("dcode-base-image.json") ||
    liveSteps.indexOf(evidence) >= liveSteps.indexOf(findStep(live, "Run live E2E tests")) ||
    !String(upload.with?.path ?? "").includes("dcode-base-image.json")
  ) {
    errors.push("live DCode must record its immutable base contract before E2E execution");
  }
  if (!uploadPaths.includes(COLD_ONBOARD_PERFORMANCE_EVIDENCE_PATH)) {
    errors.push("live E2E must upload cold-onboard performance evidence");
  }
  if (!sameMembers(needs(workflow.jobs["staging-brev-launchable"] ?? {}), ["generate-matrix"])) {
    errors.push("staging-brev-launchable must wait only for generate-matrix");
  }
  if (
    !sameMembers(needs(workflow.jobs["staging-brev-launchable-identity"] ?? {}), [
      "generate-matrix",
    ])
  ) {
    errors.push("staging-brev-launchable-identity must wait only for generate-matrix");
  }
  return errors;
}

function validatePrGateEvidenceProducers(errors: string[], workflow: OperationsWorkflow): void {
  const requiredJobs = new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs));
  for (const jobId of requiredJobs) {
    const job = workflow.jobs[jobId];
    if (!job) {
      try {
        const catalogueId = E2E_TARGET_CATALOGUE.find((target) => target.targetId === jobId)?.id;
        catalogueTarget(catalogueId ?? jobId);
      } catch {
        errors.push(`Risk-plan job is missing from E2E workflow or catalogue: ${jobId}`);
      }
      continue;
    }
    if (job.env?.E2E_JOB !== "1" || job.env?.E2E_TARGET_ID !== jobId) {
      errors.push(`${jobId} must expose matching E2E job identity`);
    }
    if (typeof job.env?.E2E_ARTIFACT_DIR !== "string" || !job.env.E2E_ARTIFACT_DIR) {
      errors.push(`${jobId} must expose an evidence artifact directory`);
    }
    const vitestSteps = (job.steps ?? []).filter((step) => {
      const run = String(step.run ?? "");
      return run.includes("npx vitest") || run.includes(LIVE_VITEST_HELPER);
    });
    if (
      vitestSteps.length === 0 ||
      vitestSteps.some((step) => {
        const run = String(step.run);
        return !run.includes(LIVE_VITEST_HELPER) && !run.includes(PR_GATE_REPORTER);
      })
    ) {
      errors.push(`${jobId} must attach the risk-signal reporter to every Vitest invocation`);
    }
    const uploads = (job.steps ?? []).filter((step) => step.uses?.startsWith(E2E_ARTIFACT_ACTION));
    if (uploads.length !== 1 || uploads[0]?.if !== "always()") {
      errors.push(`${jobId} must always upload one evidence artifact`);
    }
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
  const releaseQualificationNeeds = needs(workflow.jobs["release-qualification"] ?? {});
  if (!sameMembers(releaseQualificationNeeds, reportNeeds)) {
    errors.push("release-qualification needs must exactly match report-to-pr needs");
  }
  const relevantE2eNeeds = needs(workflow.jobs["relevant-e2e"] ?? {});
  if (!sameMembers(relevantE2eNeeds, reportNeeds)) {
    errors.push("relevant-e2e needs must exactly match report-to-pr needs");
  }
}

function validateRelevantE2e(errors: string[], workflow: OperationsWorkflow): void {
  const job = workflow.jobs["relevant-e2e"] ?? {};
  const expectedCondition =
    "${{ always() && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'push' }}";
  if (job.name !== "Relevant E2E" || job.if !== expectedCondition) {
    errors.push("relevant-e2e must be the stable aggregate check for main pushes");
  }
  if (!isDeepStrictEqual(permissionMap(job.permissions), { contents: "read" })) {
    errors.push("relevant-e2e permissions must be contents: read");
  }
  const checkout = findStep(job, "Check out the E2E result evaluator");
  const requireResults = findStep(job, "Require every selected E2E result");
  const steps = job.steps ?? [];
  requirePinnedAction(errors, checkout, "relevant-e2e checkout");
  if (
    steps.length !== 3 ||
    steps[0] !== checkout ||
    steps[1] !== requireResults ||
    checkout.with?.ref !== "${{ github.workflow_sha }}" ||
    checkout.with?.["persist-credentials"] !== false ||
    checkout.with?.["sparse-checkout"] !== "tools/e2e/release-qualification.mts" ||
    checkout.with?.["sparse-checkout-cone-mode"] !== false
  ) {
    errors.push("relevant-e2e must check out only the trusted evaluator");
  }
  if (
    requireResults.env?.NEEDS_JSON !== "${{ toJSON(needs) }}" ||
    requireResults.env?.RELEASE_REQUIRED_JOBS !==
      "${{ needs.generate-matrix.outputs.selected_workflow_jobs }}" ||
    requireResults.run !==
      "node --experimental-strip-types --no-warnings tools/e2e/release-qualification.mts"
  ) {
    errors.push("relevant-e2e must evaluate planner-selected jobs from needs");
  }
}

function validateReleaseQualification(errors: string[], workflow: OperationsWorkflow): void {
  const job = workflow.jobs["release-qualification"] ?? {};
  const expectedCondition =
    "${{ always() && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' && inputs.jobs == '' && inputs.targets == '' && inputs.include_staging_brev_launchable && !inputs.allow_jetson_dispatch && !inputs.allow_dgx_spark_runner_queue }}";
  if (job.if !== expectedCondition) {
    errors.push("release-qualification must run only for a full manual run against main");
  }
  if (job["timeout-minutes"] !== 5) {
    errors.push("release-qualification must keep the 5-minute timeout");
  }
  if (!isDeepStrictEqual(permissionMap(job.permissions), { contents: "read" })) {
    errors.push("release-qualification permissions must be contents: read");
  }
  if (job.env && Object.keys(job.env).length > 0) {
    errors.push("release-qualification must not expose credentials at job scope");
  }

  const steps = job.steps ?? [];
  const checkout = findStep(job, "Check out the qualification evaluator");
  const requireResults = findStep(job, "Require every release E2E result");
  requirePinnedAction(errors, checkout, "release-qualification checkout");
  if (
    steps.length !== 2 ||
    steps[0] !== checkout ||
    steps[1] !== requireResults ||
    checkout.with?.ref !== "${{ github.workflow_sha }}" ||
    checkout.with?.["persist-credentials"] !== false ||
    checkout.with?.["sparse-checkout"] !== "tools/e2e/release-qualification.mts" ||
    checkout.with?.["sparse-checkout-cone-mode"] !== false
  ) {
    errors.push("release-qualification must check out only the trusted evaluator");
  }
  if (
    requireResults.env?.NEEDS_JSON !== "${{ toJSON(needs) }}" ||
    requireResults.env?.RELEASE_REQUIRED_JOBS !==
      "${{ needs.generate-matrix.outputs.release_required_jobs }}" ||
    requireResults.run !==
      "node --experimental-strip-types --no-warnings tools/e2e/release-qualification.mts"
  ) {
    errors.push("release-qualification must evaluate planner-selected jobs from needs");
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
        permissions.actions !== "read" ||
        permissions.contents !== "read" ||
        permissions["pull-requests"] !== "write" ||
        Object.keys(permissions).length !== 3
      ) {
        errors.push(
          "report-to-pr must hold only actions: read, contents: read, and pull-requests: write",
        );
      }
      if (
        job.if !==
        "${{ always() && github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '' }}"
      ) {
        errors.push("report-to-pr must run only for manual workflow dispatches");
      }
      const report = findStep(job, "Post E2E target results to PR");
      const steps = job.steps ?? [];
      const reportCheckout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      if (
        steps.length !== 2 ||
        !reportCheckout ||
        steps.indexOf(reportCheckout) !== 0 ||
        reportCheckout.with?.ref !== "${{ github.workflow_sha }}" ||
        reportCheckout.with?.["persist-credentials"] !== false
      ) {
        errors.push(
          "report-to-pr must first check out the trusted workflow revision, then post its PR comment",
        );
      }
      requireNode24GithubScript(errors, report, "report-to-pr");
      const reportScript = String(report.with?.script ?? "");
      if (!passesNeedsAsEnvironmentData(report)) {
        errors.push(
          "report-to-pr must pass needs as environment data without script interpolation",
        );
      }
      const commentCalls = jobSource.match(/github\.rest\.issues\.createComment\s*\(/gu);
      const issueNamespaceReferences = reportScript.match(/github\.rest\.issues\b/gu);
      const prScopedComment =
        /await\s+github\.rest\.issues\.createComment\(\{\s*owner:\s*context\.repo\.owner,\s*repo:\s*context\.repo\.repo,\s*issue_number:\s*prNumber,\s*body:\s*report\.body,?\s*\}\);/u;
      if (commentCalls?.length !== 1 || !prScopedComment.test(reportScript)) {
        errors.push(
          "report-to-pr must limit issue mutation to one validated PR-scoped createComment call",
        );
      }
      if (!/\bconst\s+prNumber\s*=\s*await\s+resolveReportPr\(/u.test(reportScript)) {
        errors.push("report-to-pr must derive prNumber from the trusted resolveReportPr call");
      }
      if (!/\bconst\s+report\s*=\s*renderE2eReport\(/u.test(reportScript)) {
        errors.push("report-to-pr must derive report from the trusted renderE2eReport call");
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
    const trustedQualificationReadJob = NATIVE_RUNTIME_QUALIFICATION_READ_JOBS.has(name);
    if (
      trustedQualificationReadJob &&
      (!isDeepStrictEqual(permissions, {
        actions: "read",
        contents: "read",
        "pull-requests": "read",
      }) ||
        GH_API_WRITE_METHOD.test(jobSource))
    ) {
      errors.push(`${name} must limit GitHub API access to the reviewed read-only contract`);
    }
    const sourceWithoutReviewedReads = trustedQualificationReadJob
      ? sourceWithoutSlackPublisher.replace(/\bgh\s+api\b/gu, "validatedGhRead")
      : sourceWithoutSlackPublisher;

    if (
      ISSUE_API_REFERENCE.test(jobSource) ||
      GENERIC_ISSUE_REST_MUTATION.test(jobSource) ||
      GENERIC_ISSUE_GRAPHQL_MUTATION.test(jobSource)
    ) {
      errors.push(`${name} must not mutate GitHub issues`);
    }
    if (GENERIC_GITHUB_WRITE_SURFACE.test(sourceWithoutReviewedReads)) {
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
    "${{ always() && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '')) }}"
  ) {
    errors.push("scorecard must run after pushes and manual E2E runs dispatched against main");
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
  const sparseCheckout = String(checkout.with?.["sparse-checkout"] ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    sparseCheckout.length !== 3 ||
    !sparseCheckout.includes("ci/onboard-performance-budget.json") ||
    !sparseCheckout.includes("scripts/audit-test-runtime.mts") ||
    !sparseCheckout.includes("scripts/scorecard")
  ) {
    errors.push(
      "scorecard checkout must be limited to runtime and scorecard builders and budget config",
    );
  }

  const download = findStep(job, "Download E2E progress artifacts");
  requirePinnedAction(errors, download, "scorecard artifact download");
  if (
    download.uses !== DOWNLOAD_ARTIFACT_ACTION ||
    download["continue-on-error"] !== true ||
    download.with?.pattern !== "e2e-*" ||
    download.with?.path !== "${{ runner.temp }}/e2e-runtime-audit"
  ) {
    errors.push(
      "scorecard must download this run's E2E artifacts into the runtime audit directory",
    );
  }

  const generate = findStep(job, "Generate E2E scorecard");
  requireNode24GithubScript(errors, generate, "scorecard generator");
  const generateScript = String(generate.with?.script ?? "");
  if (!passesNeedsAsEnvironmentData(generate)) {
    errors.push(
      "scorecard generator must pass needs as environment data without script interpolation",
    );
  }
  for (const fragment of [
    "scripts/scorecard/coordinate-scorecard.mts",
    "buildScorecard",
    "scripts/scorecard/analyze-trace-timing.mts",
    "traceTiming.buildTraceTimingResult",
    "buildTraceTimingResult({ github, context, core })",
    "trace.budgetWarningMessage",
    "core.warning(trace.budgetWarningMessage)",
    "scripts/scorecard/summarize-jobs.mts",
    "scorecardJobs.loadWorkflowRunJobs",
    "scripts/audit-test-runtime.mts",
    "runtimeAudit.auditTestRuntime",
    "runtimeAudit.collectRuntimeHistorySamples",
    "runtimeAudit.formatRuntimeAuditSummary",
    "scripts/scorecard/analyze-runtime-history.mts",
    "runtimeHistory.buildRuntimeHistory",
    "scripts/scorecard/analyze-first-turn-latency.mts",
    "firstTurnLatency.readCurrentFirstTurnLatencySample",
    "currentFirstTurnLatency",
    "scripts/scorecard/analyze-sandbox-phase-tail.mts",
    "sandboxPhaseTail.readCurrentSandboxPhaseTailSample",
    "currentSandboxPhaseTail",
    "runtimeHistory.loadPriorPushHistory",
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
    errors.push(
      "scorecard generator must derive jobs omitted from the manual run from workflow inventory",
    );
  }
  if (generate.env?.RUNTIME_ARTIFACTS !== "${{ runner.temp }}/e2e-runtime-audit") {
    errors.push("scorecard generator must read the downloaded runtime audit directory");
  }
  if (generate.env?.RUNTIME_SUMMARY_FILE !== "${{ runner.temp }}/e2e-runtime-summary.json") {
    errors.push("scorecard generator must write the bounded runtime summary under runner temp");
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

  const runtimeUpload = findStep(job, "Upload E2E runtime summary");
  requirePinnedAction(errors, runtimeUpload, "scorecard runtime summary upload");
  if (
    runtimeUpload.if !== "${{ always() && github.event_name == 'push' }}" ||
    !String(runtimeUpload.uses ?? "").startsWith(E2E_ARTIFACT_ACTION) ||
    runtimeUpload.with?.name !== "e2e-runtime-summary" ||
    runtimeUpload.with?.path !== "${{ runner.temp }}/e2e-runtime-summary.json"
  ) {
    errors.push("scorecard must upload only the bounded push runtime summary");
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
  const sourceGuardIndex = script.indexOf('[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]');
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

function validateUnifiedAdvisorBoundary(errors: string[], advisorPath: string): void {
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
    errors.push("Unified advisor must not hold actions: write");
  }
  if (/createWorkflowDispatch|workflow_dispatches/u.test(source)) {
    errors.push("Unified advisor must not auto-dispatch workflows");
  }
}

export function validateE2eOperationsWorkflow(
  workflow: OperationsWorkflow,
  advisorPath = DEFAULT_ADVISOR_PATH,
): string[] {
  const errors = validateStandardProfileWorkflowBoundary(
    workflow as unknown as Record<string, unknown>,
  );
  errors.push(...validateBaseImagePublicationGate(workflow));
  validateManualPrDispatch(errors, workflow);
  validatePrGateEvidenceProducers(errors, workflow);
  validateAggregation(errors, workflow);
  validateRelevantE2e(errors, workflow);
  validateReleaseQualification(errors, workflow);
  validateIssueRoutingRetirement(errors, workflow);
  validateScorecard(errors, workflow);
  validateTraceTiming(errors, workflow);
  validateUnifiedAdvisorBoundary(errors, advisorPath);
  return errors;
}

export function validateE2eOperationsWorkflowBoundary(
  workflowPath = DEFAULT_WORKFLOW_PATH,
  advisorPath = DEFAULT_ADVISOR_PATH,
): string[] {
  return validateE2eOperationsWorkflow(readE2eOperationsWorkflow(workflowPath), advisorPath);
}
