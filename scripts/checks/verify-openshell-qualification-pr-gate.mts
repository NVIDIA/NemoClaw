// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  authenticateQualificationAuthorityPaths,
  authenticateQualificationReceiptSources,
  authenticateQualificationRetirement,
  loadQualificationContractFromRoot,
  parseQualificationReceiptArchive,
} from "./openshell-qualification-contract.mts";
import {
  qualificationAuthorityPaths,
  qualificationReceiptContract,
  validateQualificationLifecycleTransition,
} from "./openshell-qualification-core.mts";
import {
  classifyQualification,
  type GitHubReader,
  loadPullRequestFiles,
  type PullRequestFile,
  pathsForFile,
} from "./openshell-qualification-paths.mts";
import {
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_REQUIRED_WORKFLOW_PATH,
  QUALIFICATION_REQUIRED_WORKFLOW_REF,
  QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID,
  type QualificationArtifactReader,
  type QualificationContract,
  type QualificationExecutionContext,
  type QualificationGitHubReader,
  type QualificationReceipt,
  type QualificationReceiptExpectation,
} from "./openshell-qualification-schema.mts";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOW_RUNS = 100;
const MAX_WORKFLOW_ARTIFACTS = 100;
const REQUIRED_STATUS_CONTEXTS = new Set([
  "check-hash",
  "changes",
  "checks",
  "commit-lint",
  "dco-check",
]);
const GITHUB_ACTIONS_APP_ID = 15368;

type PullRequestIdentity = {
  baseSha: string;
  candidateRepository: string;
  candidateSha: string;
  number: number;
  repository: string;
};

type GateReceiptContext = Extract<QualificationExecutionContext, "final-promotion" | "selector">;

export type QualificationGatePlan = {
  authorityContract: QualificationContract | null;
  authorityRequired: boolean;
  candidateContract: QualificationContract | null;
  receiptContexts: GateReceiptContext[];
  retirement?: {
    contract: QualificationContract;
    includeFinalContractInAuthority: boolean;
  };
};

export function retirementIncludesFinalContractInAuthority(
  baseLifecycle: QualificationContract["lifecycle"],
  candidateLifecycle: QualificationContract["lifecycle"] | null,
): boolean {
  if (baseLifecycle === "final" && candidateLifecycle === "retired") return true;
  if (
    baseLifecycle === "retired" &&
    (candidateLifecycle === "retired" || candidateLifecycle === null)
  ) {
    return false;
  }
  fail("retirement authority was requested for an invalid lifecycle transition");
}

export function classifyQualificationGateFiles(
  files: readonly PullRequestFile[],
  baseContract: QualificationContract | null,
): { required: boolean; sensitivePaths: string[] } {
  const staticClassification = classifyQualification(files);
  const dynamicAuthority = new Set(
    baseContract ? qualificationAuthorityPaths(baseContract, true) : [],
  );
  const dynamicSensitive = files
    .flatMap(pathsForFile)
    .filter((candidatePath) => dynamicAuthority.has(candidatePath));
  const sensitivePaths = [
    ...new Set([...staticClassification.sensitivePaths, ...dynamicSensitive]),
  ].sort();
  return { required: sensitivePaths.length > 0, sensitivePaths };
}

type WorkflowIdentity = {
  id: number;
  path: string;
};

type WorkflowRun = {
  attempt: number;
  conclusion: "success";
  displayTitle: string;
  headSha: string;
  id: number;
  path: string;
  status: "completed";
  url: string;
  workflowId: number;
};

function fail(message: string): never {
  throw new Error(`OpenShell qualification PR gate failed: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 40-character SHA`);
  }
  return value;
}

function validateRepository(value: unknown): string {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    fail("repository identity is invalid");
  }
  return value;
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (!value || !RUN_ID_PATTERN.test(value)) fail(`${label} is invalid`);
  const parsed = Number(value);
  if (!positiveInteger(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function parseCli(argv: readonly string[]): { command: string; values: Map<string, string> } {
  const command = argv[0] ?? "";
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("CLI arguments are malformed or duplicated");
    }
    values.set(key, value);
  }
  return { command, values };
}

function requireCliValues(values: Map<string, string>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    fail(`CLI requires exactly: ${expected.join(", ")}`);
  }
}

function createGitHubReader(token: string): QualificationGitHubReader & GitHubReader {
  if (!token) fail("GITHUB_TOKEN is unavailable");
  const request = async (apiPath: string): Promise<Response> => {
    if (!apiPath.startsWith("repos/NVIDIA/NemoClaw/")) {
      fail("GitHub API path is outside the qualification repository boundary");
    }
    return fetch(`https://api.github.com/${apiPath}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "nemoclaw-openshell-qualification-pr-gate",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  };
  return {
    async getBytes(apiPath: string): Promise<Buffer> {
      const response = await request(apiPath);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
        fail("GitHub artifact response is oversized");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) fail(`GitHub API request failed with HTTP ${response.status}`);
      if (bytes.length > MAX_ARTIFACT_BYTES) fail("GitHub artifact response is oversized");
      return bytes;
    },
    async getJson(apiPath: string): Promise<unknown> {
      const response = await request(apiPath);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
        fail("GitHub JSON response is oversized");
      }
      const source = await response.text();
      if (Buffer.byteLength(source, "utf8") > MAX_JSON_BYTES) {
        fail("GitHub JSON response is oversized");
      }
      if (!response.ok) fail(`GitHub API request failed with HTTP ${response.status}`);
      try {
        return JSON.parse(source) as unknown;
      } catch {
        fail("GitHub API returned malformed JSON");
      }
    },
  };
}

export function validatePullRequestIdentity(
  value: unknown,
  expected: PullRequestIdentity,
): PullRequestIdentity {
  if (
    !isRecord(value) ||
    value.number !== expected.number ||
    value.state !== "open" ||
    !isRecord(value.head) ||
    !isRecord(value.head.repo) ||
    !isRecord(value.base) ||
    !isRecord(value.base.repo) ||
    value.head.sha !== expected.candidateSha ||
    value.base.sha !== expected.baseSha ||
    value.base.ref !== "main" ||
    value.base.repo.full_name !== expected.repository ||
    typeof value.head.repo.full_name !== "string"
  ) {
    fail("live pull-request identity is closed, stale, malformed, or not based on main");
  }
  const candidateRepository = validateRepository(value.head.repo.full_name);
  if (candidateRepository !== expected.candidateRepository) {
    fail("live pull-request head repository changed during authentication");
  }
  return expected;
}

async function loadExactPullRequest(
  api: GitHubReader,
  expected: Omit<PullRequestIdentity, "candidateRepository">,
): Promise<PullRequestIdentity> {
  const value = await api.getJson(`repos/${expected.repository}/pulls/${expected.number}`);
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.head.repo)) {
    fail("live pull-request identity is malformed");
  }
  const candidateRepository = validateRepository(value.head.repo.full_name);
  return validatePullRequestIdentity(value, { ...expected, candidateRepository });
}

function outputLine(filePath: string, key: string, value: string): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(key) || /[\r\n]/u.test(value)) {
    fail("GitHub output is malformed");
  }
  fs.appendFileSync(filePath, `${key}=${value}\n`, { encoding: "utf8" });
}

export function contractExists(root: string): boolean {
  const contractPath = path.join(root, QUALIFICATION_CONTRACT_PATH);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(contractPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    fail("qualification contract path cannot be authenticated");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("qualification contract must be a regular file, not a link or special path");
  }
  return true;
}

function readBlueprintVersion(root: string): string {
  const blueprintPath = path.join(root, "nemoclaw-blueprint/blueprint.yaml");
  const stat = fs.lstatSync(blueprintPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) {
    fail("OpenShell version blueprint is not a bounded regular file");
  }
  const source = fs.readFileSync(blueprintPath, "utf8");
  const minimum = [
    ...source.matchAll(/^min_openshell_version:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gmu),
  ];
  const maximum = [
    ...source.matchAll(/^max_openshell_version:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/gmu),
  ];
  if (minimum.length !== 1 || maximum.length !== 1 || minimum[0]?.[1] !== maximum[0]?.[1]) {
    fail("OpenShell version blueprint does not pin one exact supported version");
  }
  const version = minimum[0][1];
  if (!VERSION_PATTERN.test(version)) fail("OpenShell version blueprint is malformed");
  return version;
}

function exactContractOnlyChange(files: readonly PullRequestFile[], status: string): boolean {
  return (
    files.length === 1 &&
    files[0]?.filename === QUALIFICATION_CONTRACT_PATH &&
    files[0].previousFilename === undefined &&
    files[0].status === status
  );
}

export function planQualificationGate(options: {
  baseContract: QualificationContract | null;
  baseVersion: string;
  candidateContract: QualificationContract | null;
  candidateVersion: string;
  files: readonly PullRequestFile[];
}): QualificationGatePlan {
  const { baseContract: base, candidateContract: candidate } = options;
  if (!base) {
    if (candidate)
      fail("qualification contract cannot be reintroduced after authenticated teardown");
    return {
      authorityContract: null,
      authorityRequired: false,
      candidateContract: null,
      receiptContexts: [],
    };
  }
  if (!candidate) {
    if (base.lifecycle !== "retired" || !exactContractOnlyChange(options.files, "removed")) {
      fail("qualification contract removal requires a separate retired contract-only teardown");
    }
    if (
      options.baseVersion !== base.openshellTargetVersion ||
      options.candidateVersion !== options.baseVersion
    ) {
      fail("qualification teardown cannot change the target OpenShell version");
    }
    return {
      authorityContract: base,
      authorityRequired: true,
      candidateContract: null,
      receiptContexts: [],
      retirement: {
        contract: base,
        includeFinalContractInAuthority: retirementIncludesFinalContractInAuthority(
          base.lifecycle,
          null,
        ),
      },
    };
  }
  const transitioned = validateQualificationLifecycleTransition(base, candidate, {
    baselineVersion: options.baseVersion,
    targetVersion: options.candidateVersion,
  });
  if (base.lifecycle === "bootstrap" && base.inventoryState === "draft") {
    if (transitioned.lifecycle !== "bootstrap") {
      fail("draft qualification inventory must freeze before selector activation");
    }
    if (transitioned.inventoryState === "draft") {
      return {
        authorityContract: null,
        authorityRequired: false,
        candidateContract: transitioned,
        receiptContexts: [],
      };
    }
    if (!exactContractOnlyChange(options.files, "modified")) {
      fail("qualification inventory freeze must be a contract-only state transition");
    }
    return {
      authorityContract: transitioned,
      authorityRequired: true,
      candidateContract: transitioned,
      receiptContexts: [],
    };
  }
  if (base.lifecycle === "bootstrap") {
    if (transitioned.lifecycle !== "selector") {
      fail("frozen bootstrap permits only exact selector activation");
    }
    return {
      authorityContract: transitioned,
      authorityRequired: true,
      candidateContract: transitioned,
      receiptContexts: ["selector"],
    };
  }
  if (base.lifecycle === "selector") {
    return {
      authorityContract: base,
      authorityRequired: true,
      candidateContract: transitioned,
      receiptContexts:
        transitioned.lifecycle === "final" ? ["selector", "final-promotion"] : ["selector"],
    };
  }
  if (base.lifecycle === "final") {
    if (
      transitioned.lifecycle !== "retired" ||
      !exactContractOnlyChange(options.files, "modified")
    ) {
      fail("final qualification lifecycle is sealed until contract-only retirement");
    }
    return {
      authorityContract: transitioned,
      authorityRequired: true,
      candidateContract: transitioned,
      receiptContexts: [],
      retirement: {
        contract: transitioned,
        includeFinalContractInAuthority: retirementIncludesFinalContractInAuthority(
          base.lifecycle,
          transitioned.lifecycle,
        ),
      },
    };
  }
  if (base.lifecycle === "retired") {
    if (transitioned.lifecycle !== "retired") {
      fail("retired qualification lifecycle is immutable before separate teardown");
    }
    return {
      authorityContract: transitioned,
      authorityRequired: true,
      candidateContract: transitioned,
      receiptContexts: [],
      retirement: {
        contract: transitioned,
        includeFinalContractInAuthority: retirementIncludesFinalContractInAuthority(
          base.lifecycle,
          transitioned.lifecycle,
        ),
      },
    };
  }
  fail("qualification lifecycle is unsupported by the PR gate");
}

export async function authenticateQualificationGateAuthority(options: {
  api: QualificationGitHubReader;
  baseContract: QualificationContract | null;
  baseSha: string;
  candidateContract: QualificationContract | null;
  candidateSha: string;
  repository: string;
}): Promise<void> {
  const { baseContract: base, candidateContract: candidate } = options;
  if (!base) return;
  if (base.inventoryState === "draft") {
    if (candidate?.inventoryState !== "frozen") return;
    await authenticateQualificationAuthorityPaths(
      options.api,
      options.repository,
      options.baseSha,
      options.candidateSha,
      qualificationAuthorityPaths(candidate),
    );
    return;
  }
  const contractIsIntentionallyChanging =
    candidate === null ||
    candidate.lifecycle !== base.lifecycle ||
    candidate.inventoryState !== base.inventoryState;
  await authenticateQualificationAuthorityPaths(
    options.api,
    options.repository,
    options.baseSha,
    options.candidateSha,
    qualificationAuthorityPaths(base, !contractIsIntentionallyChanging),
  );
}

function validateWorkflowIdentity(value: unknown, expectedPath: string): WorkflowIdentity {
  if (
    !isRecord(value) ||
    !positiveInteger(value.id) ||
    value.path !== expectedPath ||
    value.state !== "active"
  ) {
    fail("trusted qualification producer workflow is missing, mismatched, or inactive");
  }
  return { id: value.id, path: expectedPath };
}

function validateWorkflowRun(
  value: unknown,
  workflow: WorkflowIdentity,
  contract: QualificationContract,
  identity: PullRequestIdentity,
  executionContext: GateReceiptContext,
): WorkflowRun | null {
  if (!isRecord(value) || typeof value.display_title !== "string") return null;
  const expectedTitle = `OpenShell 0.0.101 ${executionContext} candidate ${identity.candidateSha} base ${identity.baseSha}`;
  if (value.display_title !== expectedTitle || value.workflow_id !== workflow.id) return null;
  if (
    !positiveInteger(value.id) ||
    !positiveInteger(value.run_attempt) ||
    value.event !== "workflow_dispatch" ||
    value.head_branch !== "main" ||
    value.head_sha !== identity.baseSha ||
    value.path !== contract.trustedProducerWorkflowPath ||
    value.status !== "completed" ||
    value.conclusion !== "success" ||
    typeof value.html_url !== "string" ||
    value.html_url !== `https://github.com/${identity.repository}/actions/runs/${value.id}` ||
    !isRecord(value.repository) ||
    value.repository.full_name !== identity.repository
  ) {
    fail(`newest exact ${executionContext} producer run is stale or identity-mismatched`);
  }
  return {
    attempt: value.run_attempt,
    conclusion: "success",
    displayTitle: value.display_title,
    headSha: identity.baseSha,
    id: value.id,
    path: contract.trustedProducerWorkflowPath,
    status: "completed",
    url: value.html_url,
    workflowId: workflow.id,
  };
}

export async function loadNewestProducerRun(options: {
  api: QualificationGitHubReader;
  contract: QualificationContract;
  executionContext: GateReceiptContext;
  identity: PullRequestIdentity;
  workflow: WorkflowIdentity;
}): Promise<WorkflowRun> {
  const workflowFile = path.posix.basename(options.contract.trustedProducerWorkflowPath);
  const value = await options.api.getJson(
    `repos/${options.identity.repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&head_sha=${options.identity.baseSha}&per_page=${MAX_WORKFLOW_RUNS}&page=1`,
  );
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    (value.total_count as number) > MAX_WORKFLOW_RUNS ||
    !Array.isArray(value.workflow_runs) ||
    value.workflow_runs.length !== value.total_count
  ) {
    fail("qualification producer workflow-runs response is malformed or oversized");
  }
  const seen = new Set<number>();
  const matching: Record<string, unknown>[] = [];
  for (const item of value.workflow_runs) {
    if (
      !isRecord(item) ||
      !positiveInteger(item.id) ||
      typeof item.display_title !== "string" ||
      !positiveInteger(item.workflow_id) ||
      seen.has(item.id)
    ) {
      fail("qualification producer workflow-runs response has a malformed or duplicate run");
    }
    seen.add(item.id);
    const expectedTitle = `OpenShell 0.0.101 ${options.executionContext} candidate ${options.identity.candidateSha} base ${options.identity.baseSha}`;
    if (item.display_title === expectedTitle && item.workflow_id === options.workflow.id) {
      matching.push(item);
    }
  }
  matching.sort((left, right) => (right.id as number) - (left.id as number));
  const newest = matching[0];
  if (!newest) fail(`no exact ${options.executionContext} qualification receipt run exists`);
  const run = validateWorkflowRun(
    newest,
    options.workflow,
    options.contract,
    options.identity,
    options.executionContext,
  );
  if (!run) fail(`newest exact ${options.executionContext} producer run is identity-mismatched`);
  return run;
}

async function loadReceiptArchive(
  api: QualificationGitHubReader,
  repository: string,
  run: WorkflowRun,
  executionContext: GateReceiptContext,
): Promise<Buffer> {
  const value = await api.getJson(
    `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=${MAX_WORKFLOW_ARTIFACTS}&page=1`,
  );
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    (value.total_count as number) > MAX_WORKFLOW_ARTIFACTS ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== value.total_count
  ) {
    fail("qualification producer artifact response is malformed or oversized");
  }
  const expectedName = `openshell-0.0.101-qualification-${executionContext}-${run.id}-${run.attempt}`;
  const matching = value.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.name === expectedName,
  );
  const artifact = matching[0];
  if (
    matching.length !== 1 ||
    !isRecord(artifact) ||
    !positiveInteger(artifact.id) ||
    artifact.expired !== false ||
    typeof artifact.archive_download_url !== "string" ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== run.id ||
    artifact.workflow_run.head_sha !== run.headSha
  ) {
    fail(`${executionContext} qualification receipt artifact is missing, duplicated, or stale`);
  }
  const archivePath = `repos/${artifact.archive_download_url.split("/repos/")[1] ?? ""}`;
  if (archivePath !== `repos/${repository}/actions/artifacts/${artifact.id}/zip`) {
    fail(`${executionContext} qualification receipt artifact URL is mismatched`);
  }
  return api.getBytes(archivePath);
}

async function authenticateReceipt(options: {
  api: QualificationGitHubReader;
  baseContract: QualificationContract;
  candidateContract: QualificationContract;
  executionContext: GateReceiptContext;
  identity: PullRequestIdentity;
}): Promise<QualificationReceipt> {
  const phase = options.executionContext === "selector" ? "selector" : "final";
  const contract = qualificationReceiptContract(
    options.baseContract,
    options.candidateContract,
    phase,
    options.executionContext,
  );
  const workflowFile = path.posix.basename(contract.trustedProducerWorkflowPath);
  const workflow = validateWorkflowIdentity(
    await options.api.getJson(
      `repos/${options.identity.repository}/actions/workflows/${workflowFile}`,
    ),
    contract.trustedProducerWorkflowPath,
  );
  const loadNewest = () =>
    loadNewestProducerRun({
      api: options.api,
      contract,
      executionContext: options.executionContext,
      identity: options.identity,
      workflow,
    });
  const run = await loadNewest();
  const expected: QualificationReceiptExpectation = {
    baseSha: options.identity.baseSha,
    candidateSha: options.identity.candidateSha,
    executionContext: options.executionContext,
    phase,
    prNumber: options.identity.number,
    repository: options.identity.repository,
  };
  const receipt = await authenticateQualificationReceiptSources(
    parseQualificationReceiptArchive(
      await loadReceiptArchive(
        options.api,
        options.identity.repository,
        run,
        options.executionContext,
      ),
    ),
    contract,
    expected,
    options.api,
  );
  if (
    receipt.trustedProducerRunId !== String(run.id) ||
    receipt.trustedProducerRunAttempt !== run.attempt ||
    receipt.trustedProducerWorkflowPath !== run.path ||
    receipt.trustedProducerWorkflowSha !== run.headSha ||
    receipt.trustedProducerRunUrl !== `${run.url}/attempts/${run.attempt}`
  ) {
    fail(`${options.executionContext} qualification receipt producer identity is mismatched`);
  }
  const refreshed = await loadNewest();
  if (refreshed.id !== run.id || refreshed.attempt !== run.attempt) {
    fail(`${options.executionContext} qualification producer changed during authentication`);
  }
  return receipt;
}

function validateRequiredStatusRule(
  value: unknown,
  repository: string,
  rulesetId: number,
): boolean {
  if (
    !isRecord(value) ||
    value.type !== "required_status_checks" ||
    value.ruleset_source_type !== "Repository" ||
    value.ruleset_source !== repository ||
    value.ruleset_id !== rulesetId ||
    !isRecord(value.parameters) ||
    value.parameters.strict_required_status_checks_policy !== true ||
    value.parameters.do_not_enforce_on_create !== false ||
    !Array.isArray(value.parameters.required_status_checks)
  ) {
    return false;
  }
  const contexts = new Map<string, number>();
  for (const check of value.parameters.required_status_checks) {
    if (
      !isRecord(check) ||
      typeof check.context !== "string" ||
      !positiveInteger(check.integration_id) ||
      contexts.has(check.context)
    ) {
      return false;
    }
    contexts.set(check.context, check.integration_id);
  }
  return (
    contexts.size === REQUIRED_STATUS_CONTEXTS.size &&
    [...REQUIRED_STATUS_CONTEXTS].every(
      (context) => contexts.get(context) === GITHUB_ACTIONS_APP_ID,
    )
  );
}

function validateRequiredWorkflowRule(value: unknown, rulesetId: number): boolean {
  if (
    !isRecord(value) ||
    value.type !== "workflows" ||
    value.ruleset_source_type !== "Organization" ||
    value.ruleset_source !== "NVIDIA" ||
    value.ruleset_id !== rulesetId ||
    !isRecord(value.parameters) ||
    value.parameters.do_not_enforce_on_create !== false ||
    !Array.isArray(value.parameters.workflows) ||
    value.parameters.workflows.length !== 1
  ) {
    return false;
  }
  const workflow = value.parameters.workflows[0];
  return (
    isRecord(workflow) &&
    Object.keys(workflow).sort().join(",") === "path,ref,repository_id" &&
    workflow.repository_id === QUALIFICATION_REQUIRED_WORKFLOW_REPOSITORY_ID &&
    workflow.path === QUALIFICATION_REQUIRED_WORKFLOW_PATH &&
    workflow.ref === QUALIFICATION_REQUIRED_WORKFLOW_REF
  );
}

export function validateEffectiveQualificationRules(
  value: unknown,
  expected: {
    organizationRulesetId: number;
    repository: string;
    requiredStatusRulesetId: number;
  },
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    fail("effective branch rules response is malformed or oversized");
  }
  if (value.some((rule) => isRecord(rule) && rule.type === "merge_queue")) {
    fail("qualification authority does not support an effective merge queue");
  }
  const statusRules = value.filter((rule) =>
    validateRequiredStatusRule(rule, expected.repository, expected.requiredStatusRulesetId),
  );
  const workflowRules = value.filter((rule) =>
    validateRequiredWorkflowRule(rule, expected.organizationRulesetId),
  );
  if (statusRules.length !== 1) {
    fail("strict repository required-status authority is missing or ambiguous");
  }
  if (workflowRules.length !== 1) {
    fail("organization required-workflow authority is missing or ambiguous");
  }
}

async function classifyCommand(values: Map<string, string>): Promise<void> {
  requireCliValues(values, [
    "--repository",
    "--pr-number",
    "--candidate-sha",
    "--base-sha",
    "--base-root",
    "--github-output",
  ]);
  const repository = validateRepository(values.get("--repository"));
  const number = parsePositiveInteger(values.get("--pr-number"), "pull-request number");
  const candidateSha = validateSha(values.get("--candidate-sha"), "candidate SHA");
  const baseSha = validateSha(values.get("--base-sha"), "base SHA");
  const baseRoot = values.get("--base-root") ?? "";
  const output = values.get("--github-output") ?? "";
  const api = createGitHubReader(process.env.GITHUB_TOKEN ?? "");
  const identity = await loadExactPullRequest(api, {
    baseSha,
    candidateSha,
    number,
    repository,
  });
  const files = await loadPullRequestFiles(api, repository, number);
  const baseContract = contractExists(baseRoot)
    ? loadQualificationContractFromRoot(baseRoot)
    : null;
  const classification = classifyQualificationGateFiles(files, baseContract);
  validatePullRequestIdentity(await api.getJson(`repos/${repository}/pulls/${number}`), identity);
  outputLine(output, "required", String(classification.required));
  outputLine(output, "same-repository", String(identity.candidateRepository === repository));
}

async function verifyCommand(values: Map<string, string>): Promise<void> {
  requireCliValues(values, [
    "--repository",
    "--pr-number",
    "--candidate-sha",
    "--base-sha",
    "--base-root",
    "--candidate-root",
    "--github-output",
  ]);
  const repository = validateRepository(values.get("--repository"));
  const number = parsePositiveInteger(values.get("--pr-number"), "pull-request number");
  const candidateSha = validateSha(values.get("--candidate-sha"), "candidate SHA");
  const baseSha = validateSha(values.get("--base-sha"), "base SHA");
  const baseRoot = values.get("--base-root") ?? "";
  const candidateRoot = values.get("--candidate-root") ?? "";
  const output = values.get("--github-output") ?? "";
  const api = createGitHubReader(process.env.GITHUB_TOKEN ?? "");
  const identity = await loadExactPullRequest(api, {
    baseSha,
    candidateSha,
    number,
    repository,
  });
  if (identity.candidateRepository !== repository) {
    fail("qualification-sensitive fork pull requests fail closed");
  }
  const baseContract = contractExists(baseRoot)
    ? loadQualificationContractFromRoot(baseRoot)
    : null;
  const files = await loadPullRequestFiles(api, repository, number);
  if (!classifyQualificationGateFiles(files, baseContract).required) {
    fail("qualification receipt verification was invoked for a non-sensitive pull request");
  }
  const candidateContract = contractExists(candidateRoot)
    ? loadQualificationContractFromRoot(candidateRoot)
    : null;
  const plan = planQualificationGate({
    baseContract,
    baseVersion: readBlueprintVersion(baseRoot),
    candidateContract,
    candidateVersion: readBlueprintVersion(candidateRoot),
    files,
  });
  if (plan.authorityRequired && !plan.authorityContract?.requiredWorkflowGate) {
    fail("qualification authority is required but no required-workflow ruleset is frozen");
  }
  await authenticateQualificationGateAuthority({
    api,
    baseContract,
    baseSha,
    candidateContract,
    candidateSha,
    repository,
  });
  if (plan.receiptContexts.length > 0) {
    if (!baseContract || !plan.candidateContract) {
      fail("qualification receipt plan has no exact base and candidate contracts");
    }
    for (const executionContext of plan.receiptContexts) {
      await authenticateReceipt({
        api,
        baseContract,
        candidateContract: plan.candidateContract,
        executionContext,
        identity,
      });
    }
  }
  if (plan.retirement) {
    await authenticateQualificationRetirement(
      plan.retirement.contract,
      {
        authoritySha: baseSha,
        includeFinalContractInAuthority: plan.retirement.includeFinalContractInAuthority,
        repository,
      },
      api as QualificationArtifactReader,
    );
  }
  validatePullRequestIdentity(await api.getJson(`repos/${repository}/pulls/${number}`), identity);
  outputLine(output, "authority-required", String(plan.authorityRequired));
  outputLine(output, "receipt-required", String(plan.receiptContexts.length > 0));
  outputLine(
    output,
    "organization-ruleset-id",
    plan.authorityContract?.requiredWorkflowGate
      ? String(plan.authorityContract.requiredWorkflowGate.organizationRulesetId)
      : "",
  );
  outputLine(
    output,
    "required-status-ruleset-id",
    plan.authorityContract ? String(plan.authorityContract.requiredStatusRulesetId) : "",
  );
}

async function authorityCommand(values: Map<string, string>): Promise<void> {
  requireCliValues(values, [
    "--repository",
    "--organization-ruleset-id",
    "--required-status-ruleset-id",
  ]);
  const repository = validateRepository(values.get("--repository"));
  const organizationRulesetId = parsePositiveInteger(
    values.get("--organization-ruleset-id"),
    "organization ruleset ID",
  );
  const requiredStatusRulesetId = parsePositiveInteger(
    values.get("--required-status-ruleset-id"),
    "required-status ruleset ID",
  );
  const api = createGitHubReader(process.env.GITHUB_TOKEN ?? "");
  validateEffectiveQualificationRules(
    await api.getJson(`repos/${repository}/rules/branches/main`),
    { organizationRulesetId, repository, requiredStatusRulesetId },
  );
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, values } = parseCli(argv);
  if (command === "classify") return classifyCommand(values);
  if (command === "verify") return verifyCommand(values);
  if (command === "authority") return authorityCommand(values);
  fail("CLI command must be classify, verify, or authority");
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
