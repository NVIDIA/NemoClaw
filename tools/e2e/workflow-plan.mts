// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  buildLiveTargetInventory,
  buildLiveTargetMatrix,
  type LiveTargetMatrixEntry,
} from "../../test/e2e/registry/run.ts";
import { buildRiskPlan } from "../advisors/risk-plan.mts";
import {
  type CredentialFreeTestMatrixRow,
  credentialFreeTestCoverage,
  discoverCredentialFreeTests,
  SHARED_E2E_JOB_ID,
} from "./credential-free-tests.mts";
import { JETSON_DISPATCH_TARGET } from "./jetson-dispatch-contract.mts";
import { selectedRetiredControllerJobs } from "./retired-selector-compatibility.mts";
import { normalizeE2eSelectorIds } from "./selector-aliases.mts";
import {
  catalogueExclusionReason,
  catalogueMatrix,
  catalogueTarget,
  catalogueTargetsForChangedFiles,
  E2E_EXECUTION_PROFILES,
  E2E_OPTIONAL_CREDENTIALS,
  E2E_TARGET_CATALOGUE,
  type E2eCatalogueMatrixRow,
  type E2eCatalogueTarget,
  type E2eExecutionProfile,
  type E2eOptionalCredential,
  isPrCandidateCatalogueTarget,
  pathMatches,
} from "./target-catalogue.mts";
import {
  focusedE2eJobsForChangedFiles,
  readFreeStandingJobsInventory,
} from "./workflow-boundary.mts";
import {
  e2eExecutionLabel,
  type E2eExecutionRow,
  validateE2eExecutionRows,
  validateE2eExecutionMetadata,
} from "./execution-coverage.mts";

export type WorkflowPlanSelectors = {
  jobs?: string;
  targets?: string;
};

export type E2eWorkflowPlan = {
  matrix: LiveTargetMatrixEntry[];
  testMatrix: CredentialFreeTestMatrixRow[];
  catalogueMatrices: Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]>;
  coverageMatrix: E2eExecutionRow[];
  selectedJobs: string[];
  hermesSelected: boolean;
  explicitOnlyJobs: string[];
};

type WorkflowPlanOptions = {
  changedFiles?: readonly string[];
};

type WorkflowPlanCliOptions = WorkflowPlanSelectors & {
  ciOutput: boolean;
  summary: boolean;
};

type TrustedControllerSelectorMap = {
  retiredSelectorSelected: boolean;
  selectors: WorkflowPlanSelectors;
};

const SAFE_SELECTOR_LIST_PATTERN = /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/;
const HERMES_JOB_ID = "hermes-e2e";
const STAGING_BREV_IDENTITY_JOB_ID = "staging-brev-launchable-identity";
const LEGACY_BOOTSTRAP_INSTALL_JOB_ID = "launchable-smoke";
const BOOTSTRAP_INSTALL_JOB_ID = "bootstrap-install-smoke";
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const INFERENCE_MODES = new Set(["mock", "internal-nvidia", "public-nvidia"]);
const CATALOGUE_JOB_BY_PROFILE: Record<E2eExecutionProfile, string> = {
  standard: "catalogue-standard",
  "nvidia-api": "catalogue-nvidia-api",
  "nvidia-inference": "catalogue-nvidia-inference",
  "github-read": "catalogue-github-read",
  "brave-nvidia-inference": "catalogue-brave-nvidia-inference",
};
const REGISTRY_OWNING_PATHS = [
  "nemoclaw-blueprint/",
  "src/lib/onboard/",
  "test/e2e/fixtures/",
  "test/e2e/live/openclaw-agent-assertion.ts",
  "test/e2e/live/personal-egress-live-proof.ts",
  "test/e2e/live/registry-targets.test.ts",
  "test/e2e/registry/",
] as const;
const FULL_SUITE_OWNING_PATHS = [
  ".github/actions/docker-auth-setup/",
  ".github/actions/prepare-e2e/",
  ".github/actions/restore-e2e-cli-artifact/",
  ".github/actions/upload-e2e-artifacts/",
  ".github/scripts/docker-auth-cleanup.sh",
  ".github/workflows/e2e.yaml",
  "test/e2e/fixtures/",
  "tools/e2e/live-vitest-invocation.mts",
  "tools/e2e/workflow-plan.mts",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasValidExecutionMetadata(value: Record<string, unknown>): boolean {
  if (
    typeof value.agentRuntime !== "string" ||
    typeof value.observableOutcome !== "string" ||
    typeof value.environmentOrInferenceEndpoint !== "string" ||
    typeof value.unresolvedReason !== "string"
  ) {
    return false;
  }
  try {
    validateE2eExecutionMetadata(
      {
        agentRuntime: value.agentRuntime as E2eExecutionRow["agentRuntime"],
        observableOutcome: value.observableOutcome,
        environmentOrInferenceEndpoint: value.environmentOrInferenceEndpoint,
        unresolvedReason: value.unresolvedReason,
      },
      "E2E workflow plan row",
    );
    return true;
  } catch {
    return false;
  }
}

function isLiveTargetMatrixEntry(value: unknown): value is LiveTargetMatrixEntry {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "agentRuntime",
      "environmentOrInferenceEndpoint",
      "expectedStateId",
      "id",
      "install",
      "label",
      "onboarding",
      "observableOutcome",
      "pendingRuntimeSuites",
      "platform",
      "requiredSecrets",
      "runner",
      "runtime",
      "suites",
      "supportReasons",
      "supported",
      "timeout_minutes",
      "unresolvedReason",
    ])
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) &&
    typeof value.runner === "string" &&
    /^[A-Za-z0-9_-]+$/u.test(value.runner) &&
    typeof value.label === "string" &&
    typeof value.platform === "string" &&
    typeof value.install === "string" &&
    typeof value.runtime === "string" &&
    typeof value.onboarding === "string" &&
    typeof value.expectedStateId === "string" &&
    typeof value.agentRuntime === "string" &&
    typeof value.observableOutcome === "string" &&
    typeof value.environmentOrInferenceEndpoint === "string" &&
    typeof value.unresolvedReason === "string" &&
    typeof value.supported === "boolean" &&
    typeof value.timeout_minutes === "number" &&
    Number.isSafeInteger(value.timeout_minutes) &&
    value.timeout_minutes > 0 &&
    isStringArray(value.suites) &&
    isStringArray(value.requiredSecrets) &&
    isStringArray(value.supportReasons) &&
    isStringArray(value.pendingRuntimeSuites) &&
    hasValidExecutionMetadata(value)
  );
}

function isCredentialFreeTestMatrixRow(value: unknown): value is CredentialFreeTestMatrixRow {
  if (!isRecord(value) || !hasExactKeys(value, ["file", "id", "project"])) return false;
  if (
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
    typeof value.file !== "string" ||
    value.file.split("/").some((segment) => segment === "." || segment === "..") ||
    !/^test\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+[.]test[.](?:js|ts)$/u.test(value.file) ||
    typeof value.project !== "string"
  ) {
    return false;
  }
  return (
    (value.project === "e2e-live" && value.file.startsWith("test/e2e/live/")) ||
    (value.project === "integration" &&
      value.file.startsWith("test/") &&
      !value.file.startsWith("test/e2e/"))
  );
}

function hasUniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length;
}

function isCatalogueMatrixRow(value: unknown): value is E2eCatalogueMatrixRow {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "artifact_layout",
      "agent_runtime",
      "cloudflared",
      "compatible_api_key",
      "id",
      "display_name",
      "environment_or_inference_endpoint",
      "host_preparation",
      "host_packages",
      "install_mode",
      "install_non_interactive",
      "restore_cli",
      "observable_outcome",
      "runner",
      "runner_comparison",
      "runner_key",
      "runner_pressure",
      "shard",
      "target_id",
      "test_file",
      "timeout_minutes",
      "unresolved_reason",
    ]) &&
    typeof value.id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) &&
    typeof value.display_name === "string" &&
    /^[A-Z][A-Za-z0-9 .'+()-]+: [^/\r\n]{1,72}$/u.test(value.display_name) &&
    typeof value.agent_runtime === "string" &&
    typeof value.observable_outcome === "string" &&
    typeof value.environment_or_inference_endpoint === "string" &&
    typeof value.unresolved_reason === "string" &&
    typeof value.runner === "string" &&
    /^[A-Za-z0-9._-]+$/u.test(value.runner) &&
    typeof value.runner_key === "string" &&
    /^(?:|[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(value.runner_key) &&
    typeof value.target_id === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.target_id) &&
    typeof value.test_file === "string" &&
    /^test\/e2e\/live\/[A-Za-z0-9._-]+[.]test[.]ts$/u.test(value.test_file) &&
    typeof value.timeout_minutes === "number" &&
    Number.isInteger(value.timeout_minutes) &&
    value.timeout_minutes > 0 &&
    typeof value.host_packages === "string" &&
    /^(?:|expect|iptables|expect iptables)$/u.test(value.host_packages) &&
    typeof value.install_non_interactive === "boolean" &&
    typeof value.cloudflared === "boolean" &&
    typeof value.runner_comparison === "boolean" &&
    typeof value.runner_pressure === "boolean" &&
    typeof value.compatible_api_key === "boolean" &&
    typeof value.shard === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.shard) &&
    (value.artifact_layout === "target-shard" || value.artifact_layout === "flat-shard") &&
    (value.host_preparation === "none" ||
      value.host_preparation === "hermes-swap" ||
      value.host_preparation === "rebuild-swap") &&
    (value.install_mode === "none" ||
      value.install_mode === "authenticated" ||
      value.install_mode === "credential-free") &&
    typeof value.restore_cli === "boolean" &&
    hasValidExecutionMetadata({
      agentRuntime: value.agent_runtime,
      observableOutcome: value.observable_outcome,
      environmentOrInferenceEndpoint: value.environment_or_inference_endpoint,
      unresolvedReason: value.unresolved_reason,
    })
  );
}

function isE2eExecutionRow(value: unknown): value is E2eExecutionRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "agentRuntime",
      "environmentOrInferenceEndpoint",
      "id",
      "observableOutcome",
      "source",
      "unresolvedReason",
      "variant",
    ]) ||
    typeof value.id !== "string" ||
    typeof value.variant !== "string" ||
    typeof value.source !== "string" ||
    !hasValidExecutionMetadata(value)
  ) {
    return false;
  }
  try {
    validateE2eExecutionRows([value as unknown as E2eExecutionRow]);
    return true;
  } catch {
    return false;
  }
}

function isE2eExecutionRows(value: unknown): value is E2eExecutionRow[] {
  if (!Array.isArray(value) || !value.every(isE2eExecutionRow)) return false;
  try {
    validateE2eExecutionRows(value);
    return true;
  } catch {
    return false;
  }
}

function isCatalogueMatrixRowForProfile(
  value: unknown,
  profile: E2eExecutionProfile,
): value is E2eCatalogueMatrixRow {
  if (!isCatalogueMatrixRow(value)) return false;
  const target = E2E_TARGET_CATALOGUE.find((entry) => entry.id === value.id);
  return (
    target?.profile === profile &&
    target.targetId === value.target_id &&
    target.displayName === value.display_name &&
    target.agentRuntime === value.agent_runtime &&
    target.displayName === value.observable_outcome &&
    target.environmentOrInferenceEndpoint === value.environment_or_inference_endpoint &&
    target.unresolvedReason === value.unresolved_reason &&
    target.runner === value.runner &&
    target.runnerKey === value.runner_key &&
    target.testFile === value.test_file &&
    target.timeoutMinutes === value.timeout_minutes &&
    target.installMode === value.install_mode &&
    target.installNonInteractive === value.install_non_interactive &&
    target.restoreCli === value.restore_cli &&
    target.cloudflared === value.cloudflared &&
    target.hostPackages.join(" ") === value.host_packages &&
    target.hostPreparation === value.host_preparation &&
    target.runnerComparison === value.runner_comparison &&
    target.runnerPressure === value.runner_pressure &&
    target.compatibleApiKey === value.compatible_api_key &&
    target.shard === value.shard &&
    target.artifactLayout === value.artifact_layout
  );
}

function isCatalogueMatrices(
  value: unknown,
): value is Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]> {
  return (
    isRecord(value) &&
    hasExactKeys(value, E2E_EXECUTION_PROFILES) &&
    E2E_EXECUTION_PROFILES.every(
      (profile) =>
        Array.isArray(value[profile]) &&
        value[profile].every((row) => isCatalogueMatrixRowForProfile(row, profile)),
    )
  );
}

function emptyCatalogueMatrices(): Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]> {
  return {
    standard: [],
    "nvidia-api": [],
    "nvidia-inference": [],
    "github-read": [],
    "brave-nvidia-inference": [],
  };
}

function catalogueMatrices(
  targets: readonly E2eCatalogueTarget[],
): Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]> {
  return Object.fromEntries(
    E2E_EXECUTION_PROFILES.map((profile) => [profile, catalogueMatrix(profile, targets)]),
  ) as Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]>;
}

function registryTargetsForChangedFiles(changedFiles: readonly string[]): LiveTargetMatrixEntry[] {
  return changedFiles.some((file) =>
    REGISTRY_OWNING_PATHS.some((owner) => pathMatches(file, owner)),
  )
    ? buildLiveTargetMatrix()
    : [];
}

function changedFilesFromEnvironment(environment: NodeJS.ProcessEnv): string[] | undefined {
  if (environment.EVENT_NAME !== "push") return undefined;
  const declared = environment.CHANGED_FILES;
  if (declared === undefined) {
    throw new Error("E2E planner requires CHANGED_FILES for a push event");
  }
  return [...new Set(declared.split("\n").filter(Boolean))].sort();
}

function selectorIds(value: string | undefined, label: "jobs" | "targets"): string[] {
  if (!value) return [];
  if (!SAFE_SELECTOR_LIST_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${label} input; use comma-separated ids containing only letters, numbers, underscores, and hyphens`,
    );
  }
  return normalizeE2eSelectorIds(value.split(","));
}

function selectTestRows(
  rows: readonly CredentialFreeTestMatrixRow[],
  ids: readonly string[],
): CredentialFreeTestMatrixRow[] {
  if (ids.length === 0) return [...rows];
  const selected = new Set(ids);
  return rows.filter((row) => selected.has(row.id));
}

function mapTrustedControllerJobs(
  selectors: WorkflowPlanSelectors,
  environment: NodeJS.ProcessEnv,
): TrustedControllerSelectorMap {
  if (!COMMIT_SHA_PATTERN.test(environment.NEMOCLAW_E2E_EXPECTED_SHA ?? "")) {
    return { retiredSelectorSelected: false, selectors };
  }

  const inventory = readFreeStandingJobsInventory();
  const jobs = selectorIds(selectors.jobs, "jobs").map((job) =>
    job === LEGACY_BOOTSTRAP_INSTALL_JOB_ID &&
    E2E_TARGET_CATALOGUE.some((target) => target.targetId === BOOTSTRAP_INSTALL_JOB_ID)
      ? BOOTSTRAP_INSTALL_JOB_ID
      : job,
  );
  const targets = selectorIds(selectors.targets, "targets");
  const retiredJobs = new Set<string>(
    selectedRetiredControllerJobs({
      allowedJobs: inventory.allowedJobs,
      expectedSha: environment.NEMOCLAW_E2E_EXPECTED_SHA,
      jobs: jobs.join(","),
    }),
  );
  const retiredTargets = new Set<string>(
    selectedRetiredControllerJobs({
      allowedJobs: inventory.allowedJobs,
      expectedSha: environment.NEMOCLAW_E2E_EXPECTED_SHA,
      targets: targets.join(","),
    }),
  );
  const compatibleJobs = jobs.filter((job) => !retiredJobs.has(job));
  const compatibleTargets = targets.filter((target) => !retiredTargets.has(target));

  // Trusted main can select a renamed or newly retired job until the candidate
  // workflow becomes the controller. Keep the raw IDs for evidence, but plan
  // only jobs that still execute in the candidate.
  return {
    retiredSelectorSelected: retiredJobs.size > 0 || retiredTargets.size > 0,
    selectors: {
      ...selectors,
      jobs: compatibleJobs.join(","),
      targets: compatibleTargets.join(","),
    },
  };
}

function emptyE2eWorkflowPlan(): E2eWorkflowPlan {
  return {
    matrix: [],
    testMatrix: [],
    catalogueMatrices: emptyCatalogueMatrices(),
    coverageMatrix: [],
    selectedJobs: [],
    hermesSelected: false,
    explicitOnlyJobs: readFreeStandingJobsInventory().explicitOnlyJobs,
  };
}

type E2eWorkflowPlanWithoutCoverage = Omit<E2eWorkflowPlan, "coverageMatrix">;

function coverageMatrixForPlan(
  plan: E2eWorkflowPlanWithoutCoverage,
  inventory: ReturnType<typeof readFreeStandingJobsInventory>,
): E2eExecutionRow[] {
  const catalogueRows = E2E_EXECUTION_PROFILES.flatMap((profile) =>
    plan.catalogueMatrices[profile].map((row) => ({
      id: row.id,
      variant: "",
      source: "catalogue" as const,
      agentRuntime: row.agent_runtime,
      observableOutcome: row.observable_outcome,
      environmentOrInferenceEndpoint: row.environment_or_inference_endpoint,
      unresolvedReason: row.unresolved_reason,
    })),
  );
  const registryRows = plan.matrix.map((row) => ({
    id: row.id,
    variant: "",
    source: "typed-registry" as const,
    agentRuntime: row.agentRuntime,
    observableOutcome: row.observableOutcome,
    environmentOrInferenceEndpoint: row.environmentOrInferenceEndpoint,
    unresolvedReason: row.unresolvedReason,
  }));
  const sharedRows = plan.testMatrix.map((row) => ({
    id: row.id,
    variant: "",
    source: "shared-e2e" as const,
    ...credentialFreeTestCoverage(row.id),
  }));
  const selectedJobs = new Set(plan.selectedJobs);
  const workflowRows = inventory.coverageRows.filter((row) => selectedJobs.has(row.id));
  const rows = [...catalogueRows, ...registryRows, ...sharedRows, ...workflowRows];
  validateE2eExecutionRows(rows);
  return rows;
}

function withCoverageMatrix(
  plan: E2eWorkflowPlanWithoutCoverage,
  inventory: ReturnType<typeof readFreeStandingJobsInventory>,
): E2eWorkflowPlan {
  return {
    ...plan,
    coverageMatrix: coverageMatrixForPlan(plan, inventory),
  };
}

export function releaseRequiredWorkflowJobs(): string[] {
  const inventory = readFreeStandingJobsInventory();
  const sharedTestsRun = discoverCredentialFreeTests().length > 0;
  const liveTargetsRun = buildLiveTargetMatrix().length > 0;
  const catalogueJobs = E2E_EXECUTION_PROFILES.filter((profile) =>
    E2E_TARGET_CATALOGUE.some((target) => target.profile === profile && target.releaseRequired),
  ).map((profile) => CATALOGUE_JOB_BY_PROFILE[profile]);
  return [
    ...new Set([
      ...inventory.workflowJobs,
      ...catalogueJobs,
      ...(liveTargetsRun ? ["live"] : []),
      "staging-brev-launchable",
    ]),
  ]
    .filter((job) => !inventory.explicitOnlyJobs.includes(job))
    .filter((job) => job !== SHARED_E2E_JOB_ID || sharedTestsRun)
    .sort();
}

export function selectedWorkflowJobs(plan: E2eWorkflowPlan): string[] {
  const jobs = new Set(plan.selectedJobs);
  if (plan.matrix.length > 0) jobs.add("live");
  if (plan.testMatrix.length > 0) jobs.add(SHARED_E2E_JOB_ID);
  for (const profile of E2E_EXECUTION_PROFILES) {
    if (plan.catalogueMatrices[profile].length > 0) {
      jobs.add(CATALOGUE_JOB_BY_PROFILE[profile]);
    }
  }
  return [...jobs].sort();
}

export function buildE2eWorkflowPlan(
  selectors: WorkflowPlanSelectors = {},
  options: WorkflowPlanOptions = {},
): E2eWorkflowPlan {
  const jobs = selectorIds(selectors.jobs, "jobs");
  const targets = selectorIds(selectors.targets, "targets");

  if (jobs.includes(STAGING_BREV_IDENTITY_JOB_ID) && (jobs.length !== 1 || targets.length !== 0)) {
    throw new Error(`${STAGING_BREV_IDENTITY_JOB_ID} must be selected by itself`);
  }

  for (const id of [...jobs, ...targets]) {
    const reason = catalogueExclusionReason(id);
    if (reason) {
      throw new Error(`E2E catalogue target ${id} is not scheduled: ${reason}`);
    }
  }

  const inventory = readFreeStandingJobsInventory();
  const jetsonDispatchSelected =
    (jobs.length === 1 && jobs[0] === JETSON_DISPATCH_TARGET && targets.length === 0) ||
    (targets.length === 1 && targets[0] === JETSON_DISPATCH_TARGET && jobs.length === 0);
  if (jetsonDispatchSelected) {
    return withCoverageMatrix(
      {
        matrix: [],
        testMatrix: [],
        catalogueMatrices: emptyCatalogueMatrices(),
        selectedJobs: [JETSON_DISPATCH_TARGET],
        hermesSelected: false,
        explicitOnlyJobs: [...inventory.explicitOnlyJobs],
      },
      inventory,
    );
  }
  const credentialFreeTests = discoverCredentialFreeTests();
  const catalogueIds = new Set(
    E2E_TARGET_CATALOGUE.flatMap((target) => [target.id, target.targetId]),
  );

  if (jobs.length > 0) {
    const allowedJobs = new Set([...inventory.allowedJobs, ...catalogueIds]);
    for (const job of jobs) {
      if (!allowedJobs.has(job)) {
        throw new Error(
          `Unknown E2E test ID: ${job}\nAllowed test IDs: ${inventory.allowedJobs.join(",")}`,
        );
      }
    }
  }

  if (jobs.length > 0 || targets.length > 0) {
    const selectedIds = new Set([...jobs, ...targets]);
    const selectedCatalogueTargets = E2E_TARGET_CATALOGUE.filter(
      (target) => selectedIds.has(target.id) || selectedIds.has(target.targetId),
    );
    const registryTargets = targets.filter(
      (target) => !inventory.targetToJob.has(target) && !catalogueIds.has(target),
    );
    const selectedJobSet = new Set(
      [...selectedIds]
        .map((id) => inventory.targetToJob.get(id) ?? id)
        .filter((id) => inventory.workflowJobs.includes(id)),
    );
    if (selectedJobSet.has("mcp-bridge")) {
      selectedJobSet.add("openshell-credential-generation-window");
    }
    const selectedJobs = [...selectedJobSet];
    return withCoverageMatrix(
      {
        matrix: registryTargets.length > 0 ? buildLiveTargetMatrix(registryTargets) : [],
        testMatrix: selectTestRows(credentialFreeTests, [...jobs, ...targets]),
        catalogueMatrices: catalogueMatrices(selectedCatalogueTargets),
        selectedJobs,
        hermesSelected: selectedJobs.includes(HERMES_JOB_ID),
        explicitOnlyJobs: [...inventory.explicitOnlyJobs],
      },
      inventory,
    );
  }

  if (options.changedFiles) {
    const changedFiles = [...options.changedFiles];
    if (
      changedFiles.some((file) => FULL_SUITE_OWNING_PATHS.some((owner) => pathMatches(file, owner)))
    ) {
      const plan = buildE2eWorkflowPlan(selectors);
      return {
        ...plan,
        selectedJobs: [...new Set([...plan.selectedJobs, JETSON_DISPATCH_TARGET])],
      };
    }
    const focusedLegacyJobs = focusedE2eJobsForChangedFiles(changedFiles, inventory);
    const directlySelectedCatalogueTargets = catalogueTargetsForChangedFiles(changedFiles);
    const riskPlan = buildRiskPlan({
      headSha: "0".repeat(40),
      changedFiles,
      focusedE2eJobs: [
        ...focusedLegacyJobs,
        ...directlySelectedCatalogueTargets.map((target) => {
          const matchedFiles = changedFiles.filter((file) =>
            target.owningPaths.some((owner) => pathMatches(file, owner)),
          );
          return {
            id: target.id,
            matchedFiles: matchedFiles.length > 0 ? matchedFiles : changedFiles,
          };
        }),
      ],
    });
    const riskJobIds = riskPlan.requiredJobs.map((job) => job.id);
    const selectedJobSet = new Set(
      riskJobIds
        .map((id) => inventory.targetToJob.get(id) ?? id)
        .filter((id) => inventory.workflowJobs.includes(id)),
    );
    if (selectedJobSet.has("mcp-bridge")) {
      selectedJobSet.add("openshell-credential-generation-window");
    }
    selectedJobSet.add(JETSON_DISPATCH_TARGET);
    const selectedJobs = [...selectedJobSet];
    const selectedTests = credentialFreeTests.filter((row) => changedFiles.includes(row.file));
    const selectedCatalogueIds = new Set([
      ...directlySelectedCatalogueTargets.map((target) => target.id),
      ...riskJobIds,
    ]);
    const selectedCatalogueTargets = E2E_TARGET_CATALOGUE.filter(
      (target) => selectedCatalogueIds.has(target.id) || selectedCatalogueIds.has(target.targetId),
    );
    const riskTargetIds = riskPlan.requiredTargets.map((target) => target.id);
    const registryMatrix = [
      ...registryTargetsForChangedFiles(changedFiles),
      ...(riskTargetIds.length > 0 ? buildLiveTargetMatrix(riskTargetIds) : []),
    ].filter((entry, index, rows) => rows.findIndex((row) => row.id === entry.id) === index);
    return withCoverageMatrix(
      {
        matrix: registryMatrix,
        testMatrix: selectedTests,
        catalogueMatrices: catalogueMatrices(selectedCatalogueTargets),
        selectedJobs,
        hermesSelected: selectedJobs.includes(HERMES_JOB_ID),
        explicitOnlyJobs: [...inventory.explicitOnlyJobs],
      },
      inventory,
    );
  }

  return withCoverageMatrix(
    {
      matrix: buildLiveTargetMatrix(),
      testMatrix: credentialFreeTests,
      catalogueMatrices: catalogueMatrices(E2E_TARGET_CATALOGUE),
      selectedJobs: inventory.workflowJobs.filter(
        (job) => !inventory.explicitOnlyJobs.includes(job),
      ),
      hermesSelected: true,
      explicitOnlyJobs: [...inventory.explicitOnlyJobs],
    },
    inventory,
  );
}

export function validateE2eWorkflowPlan(plan: unknown): E2eWorkflowPlan {
  if (
    !isRecord(plan) ||
    !hasExactKeys(plan, [
      "catalogueMatrices",
      "explicitOnlyJobs",
      "hermesSelected",
      "matrix",
      "coverageMatrix",
      "selectedJobs",
      "testMatrix",
    ])
  ) {
    throw new Error("E2E planner returned an invalid output schema");
  }
  const catalogueMatricesValue = plan.catalogueMatrices;
  if (!isCatalogueMatrices(catalogueMatricesValue)) {
    throw new Error("E2E planner returned an invalid output schema");
  }
  const catalogueMatrixRows = E2E_EXECUTION_PROFILES.flatMap(
    (profile) => catalogueMatricesValue[profile],
  );
  if (
    !Array.isArray(plan.matrix) ||
    !plan.matrix.every(isLiveTargetMatrixEntry) ||
    !Array.isArray(plan.testMatrix) ||
    !plan.testMatrix.every(isCredentialFreeTestMatrixRow) ||
    !isE2eExecutionRows(plan.coverageMatrix) ||
    !hasUniqueIds([...plan.matrix, ...plan.testMatrix, ...catalogueMatrixRows]) ||
    !isStringArray(plan.selectedJobs) ||
    !plan.selectedJobs.every((job) => /^[A-Za-z0-9_-]+$/u.test(job)) ||
    !hasUniqueIds(plan.selectedJobs.map((id) => ({ id }))) ||
    typeof plan.hermesSelected !== "boolean" ||
    !isStringArray(plan.explicitOnlyJobs) ||
    !plan.explicitOnlyJobs.every((job) => /^[A-Za-z0-9_-]+$/u.test(job)) ||
    new Set(plan.explicitOnlyJobs).size !== plan.explicitOnlyJobs.length
  ) {
    throw new Error("E2E planner returned an invalid output schema");
  }
  const { coverageMatrix, ...planWithoutCoverage } = plan as E2eWorkflowPlan;
  const expectedCoverageMatrix = coverageMatrixForPlan(
    planWithoutCoverage,
    readFreeStandingJobsInventory(),
  );
  if (!isDeepStrictEqual(coverageMatrix, expectedCoverageMatrix)) {
    throw new Error(
      "E2E planner returned execution coverage that does not match its execution plan",
    );
  }
  return plan as E2eWorkflowPlan;
}

function expectedHermesSelection(
  selectors: WorkflowPlanSelectors,
  retiredSelectorSelected: boolean,
): boolean {
  const selected = [
    ...selectorIds(selectors.jobs, "jobs"),
    ...selectorIds(selectors.targets, "targets"),
  ];
  return (selected.length === 0 && !retiredSelectorSelected) || selected.includes(HERMES_JOB_ID);
}

export function withoutCredentialedCatalogueProfiles(plan: E2eWorkflowPlan): E2eWorkflowPlan {
  const eligibleRows = (rows: E2eCatalogueMatrixRow[]) =>
    rows.filter((row) => isPrCandidateCatalogueTarget(catalogueTarget(row.id)));
  const catalogueMatrices = Object.fromEntries(
    E2E_EXECUTION_PROFILES.map((profile) => [
      profile,
      eligibleRows(plan.catalogueMatrices[profile]),
    ]),
  ) as Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]>;
  const eligibleCatalogueIds = new Set(
    E2E_EXECUTION_PROFILES.flatMap((profile) => catalogueMatrices[profile].map((row) => row.id)),
  );
  return {
    ...plan,
    catalogueMatrices,
    coverageMatrix: plan.coverageMatrix.filter(
      (row) => row.source !== "catalogue" || eligibleCatalogueIds.has(row.id),
    ),
  };
}

export function withoutUnavailableOptionalCredentialTargets(
  plan: E2eWorkflowPlan,
  availableCredentials: ReadonlySet<E2eOptionalCredential>,
): E2eWorkflowPlan {
  const catalogueMatrices = Object.fromEntries(
    E2E_EXECUTION_PROFILES.map((profile) => [
      profile,
      plan.catalogueMatrices[profile].filter((row) =>
        catalogueTarget(row.id).requiredOptionalCredentials.every((credential) =>
          availableCredentials.has(credential),
        ),
      ),
    ]),
  ) as Record<E2eExecutionProfile, E2eCatalogueMatrixRow[]>;
  const { coverageMatrix: _coverageMatrix, ...planWithoutCoverage } = plan;
  return withCoverageMatrix(
    { ...planWithoutCoverage, catalogueMatrices },
    readFreeStandingJobsInventory(),
  );
}

function restrictUnauthorizedCandidatePlan(
  plan: E2eWorkflowPlan,
  hasPlannerSelectors: boolean,
): E2eWorkflowPlan {
  const candidatePlan = withoutCredentialedCatalogueProfiles(plan);
  const { coverageMatrix: _coverageMatrix, ...planWithoutCoverage } = candidatePlan;
  return withCoverageMatrix(
    {
      ...planWithoutCoverage,
      selectedJobs: hasPlannerSelectors ? plan.selectedJobs : [],
      hermesSelected: hasPlannerSelectors && plan.hermesSelected,
    },
    readFreeStandingJobsInventory(),
  );
}

export function renderE2eWorkflowPlanSummary(
  plan: E2eWorkflowPlan,
  options: { includeCoverageAudit?: boolean } = {},
): string {
  const lines = [
    "## E2E Execution Plan",
    "",
    "| Target or job | Agent runtime | Observable outcome | Environment or inference endpoint | Source | Unresolved reason |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of plan.coverageMatrix) {
    lines.push(
      `| \`${e2eExecutionLabel(row)}\` | ${row.agentRuntime} | ${row.observableOutcome} | ${row.environmentOrInferenceEndpoint} | ${row.source} | ${row.unresolvedReason} |`,
    );
  }
  if (options.includeCoverageAudit === false) {
    return `${lines.join("\n")}\n`;
  }
  const inventory = readFreeStandingJobsInventory();
  const explicitOnlyRows = inventory.coverageRows.filter((row) =>
    plan.explicitOnlyJobs.includes(row.id),
  );
  const unsupportedDeclarations = buildLiveTargetInventory().filter((row) => !row.supported);
  const outcomeRows = new Map<string, E2eExecutionRow[]>();
  for (const row of plan.coverageMatrix) {
    const rows = outcomeRows.get(row.observableOutcome) ?? [];
    rows.push(row);
    outcomeRows.set(row.observableOutcome, rows);
  }
  const repeatedOutcomes = [...outcomeRows].filter(([, rows]) => rows.length > 1);
  lines.push(
    "",
    "### Repeated outcomes with distinct evidence",
    "",
    "| Observable outcome | Rows | Distinguishing dimensions |",
    "| --- | --- | --- |",
  );
  for (const [outcome, rows] of repeatedOutcomes) {
    const dimensions = [
      new Set(rows.map((row) => row.agentRuntime)).size > 1 ? "agent runtime" : "",
      new Set(rows.map((row) => row.environmentOrInferenceEndpoint)).size > 1
        ? "environment or inference endpoint"
        : "",
    ].filter(Boolean);
    lines.push(
      `| ${outcome} | ${rows.map((row) => `\`${e2eExecutionLabel(row)}\``).join(", ")} | ${dimensions.join(" and ")} |`,
    );
  }
  lines.push(
    "",
    "### Intentional exclusions",
    "",
    "| Target or job | Agent runtime | Observable outcome | Environment or inference endpoint | Exclusion | Unresolved reason |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const row of explicitOnlyRows) {
    lines.push(
      `| \`${e2eExecutionLabel(row)}\` | ${row.agentRuntime} | ${row.observableOutcome} | ${row.environmentOrInferenceEndpoint} | Explicit dispatch only; excluded from the default release matrix | ${row.unresolvedReason} |`,
    );
  }
  lines.push(
    "",
    "### Unsupported or unresolved typed declarations",
    "",
    "| Declaration | Agent runtime | Observable outcome | Environment or inference endpoint | Missing executable ownership |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const row of unsupportedDeclarations) {
    lines.push(
      `| \`${row.id}\` | ${row.agentRuntime} | ${row.observableOutcome} | ${row.environmentOrInferenceEndpoint} | ${row.supportReasons.join("; ")} |`,
    );
  }
  lines.push(
    "",
    "### Combinatorial gaps",
    "",
    `The ${unsupportedDeclarations.length} inert typed declarations above are not executable matrix cells. #8285 owns the decision on the inert cross-runtime foundation, and #8286 owns executable-only registry cleanup after that decision. Unlisted Cartesian-product cells are not required without an accepted supported combination. This migration removes no execution, so no duplicate-to-retained-evidence mapping is required.`,
  );
  return `${lines.join("\n")}\n`;
}

export function writeE2eWorkflowPlanCiOutput(
  selectors: WorkflowPlanSelectors,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const inferenceMode = environment.INFERENCE_MODE ?? "";
  if (!INFERENCE_MODES.has(inferenceMode)) {
    throw new Error(`Invalid inference_mode: ${inferenceMode}`);
  }
  const controllerMap = mapTrustedControllerJobs(selectors, environment);
  const plannerSelectors = controllerMap.selectors;
  const hasPlannerSelectors = Boolean(plannerSelectors.jobs || plannerSelectors.targets);
  const changedFiles = hasPlannerSelectors ? undefined : changedFilesFromEnvironment(environment);
  const planned =
    controllerMap.retiredSelectorSelected && !hasPlannerSelectors
      ? emptyE2eWorkflowPlan()
      : buildE2eWorkflowPlan(plannerSelectors, { changedFiles });
  const availableOptionalCredentials = new Set<E2eOptionalCredential>(
    E2E_OPTIONAL_CREDENTIALS.filter(
      (credential) => environment[`NEMOCLAW_E2E_${credential}_AVAILABLE`] !== "false",
    ),
  );
  const availabilityScopedPlan = hasPlannerSelectors
    ? planned
    : withoutUnavailableOptionalCredentialTargets(planned, availableOptionalCredentials);
  const candidateRevision = COMMIT_SHA_PATTERN.test(environment.NEMOCLAW_E2E_EXPECTED_SHA ?? "");
  const credentialsAllowed = environment.NEMOCLAW_E2E_CREDENTIALS_ALLOWED === "true";
  const plan = validateE2eWorkflowPlan(
    candidateRevision && !credentialsAllowed
      ? restrictUnauthorizedCandidatePlan(availabilityScopedPlan, hasPlannerSelectors)
      : availabilityScopedPlan,
  );
  const expectedHermes =
    candidateRevision && !credentialsAllowed && !hasPlannerSelectors
      ? false
      : expectedHermesSelection(plannerSelectors, controllerMap.retiredSelectorSelected);
  if (!changedFiles && plan.hermesSelected !== expectedHermes) {
    throw new Error("E2E planner changed the trusted Hermes selection");
  }
  const output = environment.GITHUB_OUTPUT;
  const summary = environment.GITHUB_STEP_SUMMARY;
  if (!output || !summary) throw new Error("GitHub output paths are required");
  appendFileSync(
    output,
    [
      `matrix=${JSON.stringify(plan.matrix)}`,
      `test_matrix=${JSON.stringify(plan.testMatrix)}`,
      `catalogue_standard_matrix=${JSON.stringify(plan.catalogueMatrices.standard)}`,
      `catalogue_nvidia_api_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-api"])}`,
      `catalogue_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-inference"])}`,
      `catalogue_github_read_matrix=${JSON.stringify(plan.catalogueMatrices["github-read"])}`,
      `catalogue_brave_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["brave-nvidia-inference"])}`,
      `selected_jobs=${JSON.stringify(plan.selectedJobs)}`,
      `selected_workflow_jobs=${JSON.stringify(selectedWorkflowJobs(plan))}`,
      `hermes_selected=${plan.hermesSelected}`,
      `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
      `release_required_jobs=${JSON.stringify(releaseRequiredWorkflowJobs())}`,
      "",
    ].join("\n"),
  );
  appendFileSync(
    summary,
    renderE2eWorkflowPlanSummary(plan, {
      includeCoverageAudit: !hasPlannerSelectors && changedFiles === undefined,
    }),
  );
}

function parseArgs(argv: readonly string[]): WorkflowPlanCliOptions {
  const options: WorkflowPlanCliOptions = { ciOutput: false, summary: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ci-output") {
      options.ciOutput = true;
      continue;
    }
    if (arg === "--summary") {
      options.summary = true;
      continue;
    }
    if (arg !== "--jobs" && arg !== "--targets") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--jobs") options.jobs = value;
    else options.targets = value;
    index += 1;
  }
  if (options.ciOutput && options.summary) {
    throw new Error("--ci-output and --summary cannot be combined");
  }
  return options;
}

export function runE2eWorkflowPlanCli(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  if (options.ciOutput) {
    writeE2eWorkflowPlanCiOutput(
      { jobs: process.env.JOBS, targets: process.env.TARGETS },
      process.env,
    );
    return;
  }
  const plan = buildE2eWorkflowPlan(options);
  process.stdout.write(
    options.summary
      ? renderE2eWorkflowPlanSummary(plan, {
          includeCoverageAudit: !options.jobs && !options.targets,
        })
      : `${JSON.stringify(plan)}\n`,
  );
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    runE2eWorkflowPlanCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n")) console.error(`::error::${line}`);
    process.exitCode = 1;
  }
}
