// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";

import { canonicalJson } from "../advisors/canonical-json.mts";
import { readBoundedFile } from "../post-merge-docs/contract.mts";
import { applyResolutionPatch, requireSha, writeTree } from "../pr-merge-conflict-fixer/merge.mts";
import type { AdvisorFinding } from "./finding-ledger.mts";
import {
  advisorFindingLedgerDigest,
  type AdvisorFindingLedger,
  parseAdvisorFindingLedger,
} from "./finding-ledger.mts";
import { ADVISOR_INTERESTS } from "./specialist-catalog.mts";

export const REPAIR_REPOSITORY = "NVIDIA/NemoClaw";
export const MAX_REPAIR_FILES = 20;
export const MAX_REPAIR_FILE_BYTES = 1024 * 1024;
export const MAX_REPAIR_PATCH_BYTES = 2 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/u;
const ATTEMPT = /^sha256:[0-9a-f]{64}$/u;

export type RepairSelection = {
  version: 1;
  attemptKey: string;
  repository: typeof REPAIR_REPOSITORY;
  prNumber: number;
  sourceHeadSha: string;
  baseSha: string;
  headRef: string;
  repositoryId: string;
  author: string;
  actor: string;
  triggeringActor: string;
  workflowSha: string;
  advisor: {
    runId: number;
    runAttempt: number;
    workflowSha: string;
    artifactIds: number[];
    ledgerDigest: string;
  };
  stateDigest: string;
  reviewDigest: string;
  findingIds: string[];
  selectedFindings: AdvisorFinding[];
  selectedPaths: string[];
  decisions: Array<{ id: string; selected: boolean; reason: string }>;
  productScope: "accepted:#10791";
  optIn: "manual-exact-head";
};

export type RepairProposal = {
  version: 1;
  findingIds: string[];
  unresolvedFindingIds: string[];
  changedPaths: string[];
  summary: string;
  outcome: "proposed" | "blocked";
};

export type ValidationReceipt = {
  version: 1;
  attemptKey: string;
  repository: typeof REPAIR_REPOSITORY;
  prNumber: number;
  headRef: string;
  sourceHeadSha: string;
  baseSha: string;
  workflowSha: string;
  advisor: RepairSelection["advisor"];
  findingIds: string[];
  selectedPaths: string[];
  changedPaths: Array<{
    path: string;
    status: "A" | "D" | "M";
    mode: "100644";
    type: "blob";
    bytes: number;
  }>;
  patchSha256: string;
  candidateTreeSha: string;
  candidateDigestBefore: string;
  candidateDigestAfter: string;
  commands: Array<{ command: string; exitCode: number }>;
  stateDigest: string;
  reviewDigest: string;
  productScope: "accepted:#10791";
  optIn: "manual-exact-head";
  outcome: "validated";
};

export type ValidatedCandidate = {
  repository: string;
  patchSha256: string;
  candidateTreeSha: string;
  candidateDigest: string;
  changedPaths: ValidationReceipt["changedPaths"];
};

type PullRequestSnapshot = {
  state?: unknown;
  draft?: unknown;
  user?: { login?: unknown };
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
  base?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown; node_id?: unknown } };
};

type AdvisorRunSnapshot = {
  id?: unknown;
  run_attempt?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  path?: unknown;
  workflow_sha?: unknown;
  repository?: { full_name?: unknown };
  pull_requests?: Array<{ number?: unknown; base?: { sha?: unknown }; head?: { sha?: unknown } }>;
};

type SourceCommitSnapshot = {
  commit?: { message?: unknown };
};

type ArtifactSnapshot = {
  id?: unknown;
  name?: unknown;
  expired?: unknown;
  workflow_run?: { id?: unknown };
};

export class RepairError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepairError";
  }
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  return env[name] || fail(`${name} is required`);
}

export function fullSha(value: unknown, label: string): string {
  return typeof value === "string" && SHA.test(value)
    ? value
    : fail(`${label} must be a full lowercase SHA`);
}

export function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) > 0
    ? Number(parsed)
    : fail(`${label} must be a positive integer`);
}

export function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function attemptKey(input: {
  repository: string;
  prNumber: number;
  sourceHeadSha: string;
  baseSha: string;
  advisorRunId: number;
  advisorRunAttempt: number;
  findingIds: string[];
}): string {
  return digest(
    canonicalJson({
      ...input,
      findingIds: [...input.findingIds].sort(),
    }),
  );
}

export function allowedRepairPath(file: string): boolean {
  if (
    !/^[A-Za-z0-9._/-]+$/u.test(file) ||
    file.startsWith("/") ||
    file.endsWith("/") ||
    file.includes("//") ||
    path.posix.normalize(file) !== file ||
    /(?:^|\/)(?:\.{1,2}|\.git|node_modules)(?:\/|$)/u.test(file)
  )
    return false;
  if (
    /(?:^|\/)(?:AGENTS|CODEOWNERS|SECURITY|WRITING)[.]?[^/]*$/iu.test(file) ||
    /(?:^|\/)(?:package-lock|npm-shrinkwrap|pnpm-lock|yarn[.]lock)(?:[.]json|[.]yaml|[.]yml)?$/iu.test(
      file,
    ) ||
    /(?:^|\/)(?:package[.]json|Dockerfile(?:[.].*)?|[.]gitmodules|[.]gitattributes)$/u.test(file) ||
    /(?:^|\/)(?:generated|_build)(?:\/|$)/iu.test(file) ||
    file.startsWith(".github/") ||
    file.startsWith(".agents/") ||
    file.startsWith("test/e2e/")
  )
    return false;
  return (
    /^(?:src|nemoclaw\/src)\/.+[.](?:[cm]?[jt]s)$/u.test(file) ||
    /^test\/(?!e2e\/).+[.](?:[cm]?[jt]s)$/u.test(file) ||
    /^docs\/.+[.]mdx?$/u.test(file)
  );
}

export function readJson(file: string, maximum = 1024 * 1024): unknown {
  try {
    return JSON.parse(readBoundedFile(file, maximum).toString("utf8"));
  } catch (error) {
    throw new RepairError(`${path.basename(file)} is not valid bounded JSON`, { cause: error });
  }
}

export function assertRepairArtifactDirectory(
  directory: string,
  expectedFiles: Readonly<Record<string, number>>,
): void {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    fail("repair artifact must be a regular directory");
  const expected = Object.keys(expectedFiles).sort();
  const actual = fs.readdirSync(directory).sort();
  if (!sameStrings(actual, expected)) fail("repair artifact contains an unexpected file set");
  for (const file of expected) {
    const maximum = expectedFiles[file];
    if (!maximum) fail("repair artifact file limit is invalid");
    try {
      readBoundedFile(path.join(directory, file), maximum);
    } catch (error) {
      throw new RepairError(`repair artifact file is not a bounded regular file: ${file}`, {
        cause: error,
      });
    }
  }
}

export function parseSelection(value: unknown): RepairSelection {
  if (!record(value)) fail("selection is invalid");
  const selection = value as RepairSelection;
  if (
    selection.version !== 1 ||
    selection.repository !== REPAIR_REPOSITORY ||
    !ATTEMPT.test(selection.attemptKey) ||
    !SHA.test(selection.sourceHeadSha) ||
    !SHA.test(selection.baseSha) ||
    !SHA.test(selection.workflowSha) ||
    !selection.headRef ||
    !/^(?![-/])(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+(?<![/.])$/u.test(selection.headRef) ||
    !selection.repositoryId ||
    !selection.author ||
    !selection.actor ||
    !selection.triggeringActor ||
    !Number.isSafeInteger(selection.prNumber) ||
    selection.prNumber < 1 ||
    !record(selection.advisor) ||
    !Number.isSafeInteger(selection.advisor.runId) ||
    !Number.isSafeInteger(selection.advisor.runAttempt) ||
    !SHA.test(selection.advisor.workflowSha) ||
    !Array.isArray(selection.advisor.artifactIds) ||
    selection.advisor.artifactIds.length !== ADVISOR_INTERESTS.length + 1 ||
    new Set(selection.advisor.artifactIds).size !== selection.advisor.artifactIds.length ||
    !selection.advisor.artifactIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
    !ATTEMPT.test(selection.advisor.ledgerDigest) ||
    !ATTEMPT.test(selection.stateDigest) ||
    !ATTEMPT.test(selection.reviewDigest) ||
    selection.productScope !== "accepted:#10791" ||
    selection.optIn !== "manual-exact-head" ||
    !sortedUniqueStrings(selection.findingIds) ||
    !sortedUniqueStrings(selection.selectedPaths) ||
    !selection.selectedPaths.every(allowedRepairPath) ||
    selection.selectedPaths.length > MAX_REPAIR_FILES ||
    !Array.isArray(selection.selectedFindings) ||
    selection.selectedFindings.length !== selection.findingIds.length ||
    selection.selectedFindings.some(
      (finding, index) =>
        !record(finding) ||
        finding.id !== selection.findingIds[index] ||
        !selection.selectedPaths.includes(finding.path),
    ) ||
    !Array.isArray(selection.decisions) ||
    selection.decisions.some(
      (decision) =>
        !record(decision) ||
        typeof decision.id !== "string" ||
        typeof decision.selected !== "boolean" ||
        typeof decision.reason !== "string",
    ) ||
    selection.findingIds.some(
      (id) => !selection.decisions.some((decision) => decision.id === id && decision.selected),
    ) ||
    selection.attemptKey !==
      attemptKey({
        repository: selection.repository,
        prNumber: selection.prNumber,
        sourceHeadSha: selection.sourceHeadSha,
        baseSha: selection.baseSha,
        advisorRunId: selection.advisor.runId,
        advisorRunAttempt: selection.advisor.runAttempt,
        findingIds: selection.findingIds,
      })
  )
    fail("selection does not match the Advisor repair contract");
  return selection;
}

function findingSkipReason(finding: AdvisorFinding): string | null {
  if (finding.exclusions.length) return `excluded:${[...finding.exclusions].sort()[0]}`;
  if (finding.interest === "security-built-in-quality" || finding.kind === "security")
    return "excluded:security-sensitive";
  if (finding.kind === "dependency") return "excluded:dependency-change";
  if (finding.kind === "product-scope") return "excluded:product-scope";
  if (["design", "migration", "operations"].includes(finding.kind))
    return "excluded:maintainer-decision";
  return allowedRepairPath(finding.path) ? null : "excluded:unsupported-path";
}

export function selectRepairFindings(
  input: Omit<
    RepairSelection,
    "attemptKey" | "advisor" | "decisions" | "findingIds" | "selectedFindings" | "selectedPaths"
  > & {
    advisor: Omit<RepairSelection["advisor"], "ledgerDigest">;
    ledgers: readonly AdvisorFindingLedger[];
    optedFindingIds: readonly string[];
  },
): RepairSelection {
  const findings = input.ledgers
    .flatMap(({ findings }) => findings)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length)
    fail("Advisor ledgers contain duplicate finding IDs");
  if (input.optedFindingIds.some((id) => !findings.some((finding) => finding.id === id)))
    fail("opt-in references a finding absent from the Advisor ledgers");
  const decisions = findings.map((finding) => {
    const reason = input.optedFindingIds.includes(finding.id)
      ? findingSkipReason(finding)
      : "not-opted-in";
    return { id: finding.id, selected: reason === null, reason: reason ?? "eligible" };
  });
  const selectedFindings = findings.filter(
    ({ id }) => decisions.find((decision) => decision.id === id)?.selected,
  );
  if (!selectedFindings.length) fail("no opted-in finding is eligible for repair");
  const findingIds = selectedFindings.map(({ id }) => id);
  const selectedPaths = [...new Set(selectedFindings.map(({ path: file }) => file))].sort();
  const advisor = {
    ...input.advisor,
    ledgerDigest: advisorFindingLedgerDigest(input.ledgers),
  };
  return parseSelection({
    ...input,
    advisor,
    attemptKey: attemptKey({
      repository: input.repository,
      prNumber: input.prNumber,
      sourceHeadSha: input.sourceHeadSha,
      baseSha: input.baseSha,
      advisorRunId: advisor.runId,
      advisorRunAttempt: advisor.runAttempt,
      findingIds,
    }),
    decisions,
    findingIds,
    selectedFindings,
    selectedPaths,
  });
}

function expectedArtifactNames(runId: number, runAttempt: number): string[] {
  return [
    `pr-review-advisor-context-${runId}`,
    ...ADVISOR_INTERESTS.map((interest) => `pr-review-specialist-${interest}-${runAttempt}`),
  ].sort();
}

export function bindRepairSelection(input: {
  repository: string;
  prNumber: number;
  sourceHeadSha: string;
  sourceBaseSha: string;
  workflowSha: string;
  actor: string;
  triggeringActor: string;
  currentRunId?: number;
  currentRunAttempt?: number;
  optedFindingIds: string[];
  pullRequest: PullRequestSnapshot;
  sourceCommit: SourceCommitSnapshot;
  advisorRun: AdvisorRunSnapshot;
  artifacts: ArtifactSnapshot[];
  ledgers: AdvisorFindingLedger[];
  state: unknown;
  reviews: unknown;
  permissions: { actor: unknown; triggeringActor: unknown };
}): RepairSelection {
  const pull = input.pullRequest;
  const advisorRunId = positiveInteger(input.advisorRun.id, "Advisor run ID");
  const advisorRunAttempt = positiveInteger(input.advisorRun.run_attempt, "Advisor run attempt");
  const baseSha = fullSha(pull.base?.sha, "PR base SHA");
  const headRef = typeof pull.head?.ref === "string" ? pull.head.ref : "";
  const author = typeof pull.user?.login === "string" ? pull.user.login : "";
  const repositoryId = typeof pull.base?.repo?.node_id === "string" ? pull.base.repo.node_id : "";
  const permission = (value: unknown): unknown => (record(value) ? value.permission : undefined);
  const sourceMessage = input.sourceCommit.commit?.message;
  if (
    input.repository !== REPAIR_REPOSITORY ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== input.repository ||
    pull.head?.repo?.full_name !== input.repository ||
    pull.head?.sha !== input.sourceHeadSha ||
    baseSha !== fullSha(input.sourceBaseSha, "source base SHA") ||
    !headRef ||
    !author ||
    !repositoryId ||
    typeof sourceMessage !== "string" ||
    /^Advisor-Repair-Attempt:/mu.test(sourceMessage) ||
    !["admin", "maintain"].includes(String(permission(input.permissions.actor))) ||
    !["admin", "maintain"].includes(String(permission(input.permissions.triggeringActor)))
  )
    fail("pull request is not eligible for maintainer-owned Advisor repair");
  const exactDispatch =
    input.advisorRun.event === "workflow_dispatch" &&
    advisorRunId === input.currentRunId &&
    advisorRunAttempt === input.currentRunAttempt &&
    input.advisorRun.pull_requests?.length === 0;
  const exactTargetRun =
    input.advisorRun.event === "pull_request_target" &&
    input.advisorRun.pull_requests?.length === 1 &&
    input.advisorRun.pull_requests[0]?.number === input.prNumber &&
    input.advisorRun.pull_requests[0]?.head?.sha === input.sourceHeadSha &&
    input.advisorRun.pull_requests[0]?.base?.sha === baseSha;
  if (
    input.advisorRun.repository?.full_name !== input.repository ||
    (exactDispatch
      ? input.advisorRun.status !== "in_progress"
      : input.advisorRun.status !== "completed" || input.advisorRun.conclusion !== "success") ||
    input.advisorRun.path !== ".github/workflows/pr-review-advisor.yaml" ||
    input.advisorRun.workflow_sha !== input.workflowSha ||
    (!exactDispatch && !exactTargetRun)
  )
    fail("Advisor run is not the successful trusted workflow revision");

  const artifacts = input.artifacts.map((artifact) => ({
    id: positiveInteger(artifact.id, "Advisor artifact ID"),
    name: typeof artifact.name === "string" ? artifact.name : "",
    expired: artifact.expired,
    runId: artifact.workflow_run?.id,
  }));
  const expected = expectedArtifactNames(advisorRunId, advisorRunAttempt);
  const selectedArtifacts = expected.map((name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (matches.length !== 1 || matches[0]?.expired !== false || matches[0]?.runId !== advisorRunId)
      fail(`Advisor artifact set is incomplete: ${name}`);
    return matches[0];
  });
  if (new Set(selectedArtifacts.map(({ id }) => id)).size !== selectedArtifacts.length)
    fail("Advisor artifact identities are not unique");
  return selectRepairFindings({
    version: 1,
    repository: REPAIR_REPOSITORY,
    prNumber: input.prNumber,
    sourceHeadSha: fullSha(input.sourceHeadSha, "source head SHA"),
    baseSha,
    headRef,
    repositoryId,
    author,
    actor: input.actor,
    triggeringActor: input.triggeringActor,
    workflowSha: fullSha(input.workflowSha, "workflow SHA"),
    advisor: {
      runId: advisorRunId,
      runAttempt: advisorRunAttempt,
      workflowSha: fullSha(input.advisorRun.workflow_sha, "Advisor workflow SHA"),
      artifactIds: selectedArtifacts.map(({ id }) => id).sort((left, right) => left - right),
    },
    stateDigest: digest(canonicalJson(input.state)),
    reviewDigest: digest(canonicalJson(input.reviews)),
    productScope: "accepted:#10791",
    optIn: "manual-exact-head",
    ledgers: input.ledgers,
    optedFindingIds: input.optedFindingIds,
  });
}

function modelText(value: unknown, selection: RepairSelection, maximumCharacters: number): string {
  if (typeof value !== "string") return "";
  let result = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .slice(0, maximumCharacters);
  const identities = [
    selection.repository,
    selection.repositoryId,
    selection.headRef,
    selection.sourceHeadSha,
    selection.baseSha,
    selection.workflowSha,
    selection.attemptKey,
    selection.advisor.workflowSha,
    selection.advisor.ledgerDigest,
    selection.stateDigest,
    selection.reviewDigest,
    selection.author,
    selection.actor,
    selection.triggeringActor,
    String(selection.prNumber),
    String(selection.advisor.runId),
    ...selection.advisor.artifactIds.map(String),
  ].filter((identity) => identity.length >= 3);
  for (const identity of identities) result = result.split(identity).join("[identity removed]");
  return result
    .replace(/(?:github_pat_|ghp_|nvapi-|sk-)[A-Za-z0-9_-]{20,}/gu, "[credential removed]")
    .replace(
      /((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/giu,
      "$1[credential removed]",
    )
    .replace(/\bbearer\s+\S+/giu, "bearer [credential removed]")
    .replace(/sha256:[0-9a-f]{64}/giu, "[digest removed]")
    .replace(/\b[0-9a-f]{40}\b/giu, "[revision removed]");
}

function modelBodies(value: unknown, selection: RepairSelection): Array<{ body: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .map((item) => ({ body: modelText(record(item) ? item.body : "", selection, 4_000) }))
    .filter(({ body }) => body.length > 0);
}

export function repairModelContext(
  selection: RepairSelection,
  input: {
    state: unknown;
    reviews: unknown;
    specialistSummaries: Record<string, string>;
  },
): unknown {
  assertLiveRepairState(selection, input.state, input.reviews);
  const state = record(input.state) ? input.state : {};
  const pull = record(state.pull) ? state.pull : {};
  const labels = Array.isArray(pull.labels)
    ? pull.labels
        .slice(0, 100)
        .map((label) => modelText(record(label) ? label.name : "", selection, 100))
        .filter(Boolean)
    : [];
  const specialistReports = ADVISOR_INTERESTS.map((interest) => {
    const summary = input.specialistSummaries[interest];
    if (typeof summary !== "string" || summary.length === 0)
      fail(`missing complete Advisor specialist summary: ${interest}`);
    return { interest, summary: modelText(summary, selection, 512 * 1024) };
  });
  const context = {
    productScope: selection.productScope,
    repairRules:
      "Make only the selected mechanical repair. Do not make product, ownership, dependency, credential, or external-system decisions.",
    currentPullRequest: {
      title: modelText(pull.title, selection, 2_000),
      body: modelText(pull.body, selection, 20_000),
      labels,
      issueComments: modelBodies(state.comments, selection),
      reviews: modelBodies(input.reviews, selection),
      reviewComments: Array.isArray(state.reviewComments)
        ? state.reviewComments.slice(0, 100).map((item) => ({
            path: modelText(record(item) ? item.path : "", selection, 512),
            line:
              record(item) && Number.isSafeInteger(item.line) && Number(item.line) > 0
                ? Number(item.line)
                : null,
            body: modelText(record(item) ? item.body : "", selection, 4_000),
          }))
        : [],
    },
    specialistReports,
    findings: selection.selectedFindings.map(
      ({
        id,
        interest,
        severity,
        kind,
        summary,
        path: file,
        line,
        impact,
        smallestSafeFix,
        regressionTest,
      }) => ({
        id,
        interest,
        severity,
        kind,
        summary: modelText(summary, selection, 1_000),
        path: file,
        line,
        impact: modelText(impact, selection, 2_000),
        smallestSafeFix: modelText(smallestSafeFix, selection, 2_000),
        regressionTest: modelText(regressionTest, selection, 2_000),
      }),
    ),
  };
  if (Buffer.byteLength(canonicalJson(context), "utf8") > 5 * 1024 * 1024)
    fail("identity-free repair model context exceeds five MiB");
  return context;
}

export function assertLiveRepairState(
  selection: RepairSelection,
  state: unknown,
  reviews: unknown,
): void {
  if (
    selection.stateDigest !== digest(canonicalJson(state)) ||
    selection.reviewDigest !== digest(canonicalJson(reviews))
  )
    fail("pull request state changed after repair selection");
}

export function parseProposal(value: unknown, selection: RepairSelection): RepairProposal {
  if (!record(value)) fail("proposal is invalid");
  const proposal = value as RepairProposal;
  if (
    proposal.version !== 1 ||
    !sortedUniqueStrings(proposal.findingIds) ||
    !sortedUniqueStrings(proposal.unresolvedFindingIds) ||
    !sortedUniqueStrings(proposal.changedPaths) ||
    !proposal.changedPaths.every((file) => selection.selectedPaths.includes(file)) ||
    !sameStrings(proposal.findingIds, selection.findingIds) ||
    !proposal.unresolvedFindingIds.every((id) => proposal.findingIds.includes(id)) ||
    typeof proposal.summary !== "string" ||
    !proposal.summary.trim() ||
    Buffer.byteLength(proposal.summary) > 2_000 ||
    !["proposed", "blocked"].includes(proposal.outcome)
  )
    fail("proposal does not match the selected findings");
  if (proposal.outcome === "proposed" && proposal.unresolvedFindingIds.length)
    fail("a proposed repair cannot leave a selected finding unresolved");
  return proposal;
}

const schema = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "repair-validation.schema.json"),
    "utf8",
  ),
) as AnySchema;
const validateReceipt = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export function parseValidationReceipt(value: unknown): ValidationReceipt {
  if (!validateReceipt(value)) fail("validation receipt does not match its committed schema");
  return value as ValidationReceipt;
}

export function validationReceipt(input: {
  selection: RepairSelection;
  candidate: ValidatedCandidate;
  candidateDigestAfter: string;
  commands: ValidationReceipt["commands"];
}): ValidationReceipt {
  if (input.candidate.candidateDigest !== input.candidateDigestAfter)
    fail("validation changed the approved candidate");
  const expectedCommands = [
    "npm ci --ignore-scripts",
    "npm run check:diff",
    "npm run test:changed",
    ...(input.selection.selectedPaths.some((file) => file.startsWith("docs/"))
      ? ["npm run docs"]
      : []),
  ].map((command) => ({ command, exitCode: 0 }));
  if (canonicalJson(input.commands) !== canonicalJson(expectedCommands))
    fail("validation receipt does not contain the required trusted commands");
  return parseValidationReceipt({
    version: 1,
    attemptKey: input.selection.attemptKey,
    repository: input.selection.repository,
    prNumber: input.selection.prNumber,
    headRef: input.selection.headRef,
    sourceHeadSha: input.selection.sourceHeadSha,
    baseSha: input.selection.baseSha,
    workflowSha: input.selection.workflowSha,
    advisor: input.selection.advisor,
    findingIds: input.selection.findingIds,
    selectedPaths: input.selection.selectedPaths,
    changedPaths: input.candidate.changedPaths,
    patchSha256: input.candidate.patchSha256,
    candidateTreeSha: input.candidate.candidateTreeSha,
    candidateDigestBefore: input.candidate.candidateDigest,
    candidateDigestAfter: input.candidateDigestAfter,
    commands: input.commands,
    stateDigest: input.selection.stateDigest,
    reviewDigest: input.selection.reviewDigest,
    productScope: input.selection.productScope,
    optIn: input.selection.optIn,
    outcome: "validated",
  });
}

export function assertValidatedRepair(
  selection: RepairSelection,
  receipt: ValidationReceipt,
  candidate: ValidatedCandidate,
): void {
  if (
    receipt.attemptKey !== selection.attemptKey ||
    receipt.repository !== selection.repository ||
    receipt.prNumber !== selection.prNumber ||
    receipt.headRef !== selection.headRef ||
    receipt.sourceHeadSha !== selection.sourceHeadSha ||
    receipt.baseSha !== selection.baseSha ||
    receipt.workflowSha !== selection.workflowSha ||
    canonicalJson(receipt.advisor) !== canonicalJson(selection.advisor) ||
    !sameStrings(receipt.findingIds, selection.findingIds) ||
    !sameStrings(receipt.selectedPaths, selection.selectedPaths) ||
    receipt.patchSha256 !== candidate.patchSha256 ||
    receipt.candidateTreeSha !== candidate.candidateTreeSha ||
    receipt.candidateDigestBefore !== candidate.candidateDigest ||
    receipt.candidateDigestAfter !== candidate.candidateDigest ||
    canonicalJson(receipt.changedPaths) !== canonicalJson(candidate.changedPaths) ||
    receipt.stateDigest !== selection.stateDigest ||
    receipt.reviewDigest !== selection.reviewDigest
  )
    fail("validated repair does not match its exact selection and candidate");
}

export function sanitizeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]?\s*\S+/giu, "[REDACTED]")
      .trim()
      .slice(0, 1_000) || "unknown failure"
  );
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: string[], buffer = false): string | Buffer {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "submodule.recurse=false",
      ...args,
    ],
    {
      cwd,
      env: GIT_ENV,
      encoding: buffer ? undefined : "utf8",
      maxBuffer: MAX_REPAIR_PATCH_BYTES + 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function nameStatuses(repository: string): Array<{ path: string; status: "A" | "D" | "M" }> {
  if (
    (
      git(
        repository,
        [
          "diff",
          "--cached",
          "--diff-filter=RC",
          "--name-only",
          "-z",
          "--find-renames",
          "HEAD",
          "--",
        ],
        true,
      ) as Buffer
    ).length
  )
    fail("repair patch contains a rename or copy");
  const fields = (
    git(
      repository,
      ["diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD", "--"],
      true,
    ) as Buffer
  )
    .toString("utf8")
    .split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2) fail("Git returned malformed changed paths");
  const result: Array<{ path: string; status: "A" | "D" | "M" }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (!file || !status || !["A", "D", "M"].includes(status))
      fail("repair patch contains an unsupported change type");
    result.push({ path: file, status: status as "A" | "D" | "M" });
  }
  return result;
}

function changedPath(repository: string, change: { path: string; status: "A" | "D" | "M" }) {
  const object = change.status === "D" ? `HEAD:${change.path}` : `:${change.path}`;
  const oldStage = String(git(repository, ["ls-tree", "-z", "HEAD", "--", change.path]));
  const newStage = String(git(repository, ["ls-files", "--stage", "-z", "--", change.path]));
  const safeOld = oldStage.startsWith("100644 ");
  const safeNew = newStage.startsWith("100644 ");
  if (
    (change.status === "A" && (oldStage || !safeNew)) ||
    (change.status === "D" && (!safeOld || newStage)) ||
    (change.status === "M" && (!safeOld || !safeNew))
  )
    fail(`repair patch uses an unsafe object at ${change.path}`);
  const bytes = Number.parseInt(String(git(repository, ["cat-file", "-s", object])), 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_REPAIR_FILE_BYTES)
    fail(`repair patch exceeds the file limit at ${change.path}`);
  const content = git(repository, ["show", object], true) as Buffer;
  if (content.includes(0)) fail(`repair patch contains binary data at ${change.path}`);
  if (
    /(?:github_pat_|ghp_|nvapi-|sk-)[A-Za-z0-9_-]{20,}/u.test(content.toString("utf8")) ||
    /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"']{16,}["']/iu.test(
      content.toString("utf8"),
    )
  )
    fail(`repair patch contains possible credential material at ${change.path}`);
  return { ...change, mode: "100644" as const, type: "blob" as const, bytes };
}

export function candidateDigest(repository: string, sourceHeadSha: string): string {
  const patch = git(
    repository,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      sourceHeadSha,
      "HEAD",
      "--",
    ],
    true,
  ) as Buffer;
  const status = String(
    git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  return digest(Buffer.concat([patch, Buffer.from(status)]));
}

export function validateRepairPatch(input: {
  sourceCheckout: string;
  destination: string;
  selection: RepairSelection;
  patchFile: string;
  proposalFile?: string;
  expectedChangedPaths?: string[];
}): ValidatedCandidate {
  const patch = readBoundedFile(input.patchFile, MAX_REPAIR_PATCH_BYTES);
  if ((input.proposalFile === undefined) === (input.expectedChangedPaths === undefined))
    fail("repair validation requires one changed-path authority");
  const proposal = input.proposalFile
    ? parseProposal(readJson(input.proposalFile, 512 * 1024), input.selection)
    : undefined;
  fs.rmSync(input.destination, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(input.destination), { recursive: true, mode: 0o700 });
  git(path.dirname(input.destination), [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "--no-checkout",
    input.sourceCheckout,
    input.destination,
  ]);
  git(input.destination, ["checkout", "--detach", input.selection.sourceHeadSha]);
  const sourcePaths = String(
    git(input.destination, [
      "diff",
      "--name-only",
      "-z",
      `${input.selection.baseSha}...${input.selection.sourceHeadSha}`,
      "--",
    ]),
  )
    .split("\0")
    .filter(Boolean);
  if (sourcePaths.some((file) => !allowedRepairPath(file)))
    fail("pull request changes a path outside the Advisor repair allowlist");
  applyResolutionPatch(input.destination, input.patchFile);
  const statuses = nameStatuses(input.destination);
  if (!statuses.length || statuses.length > MAX_REPAIR_FILES)
    fail("repair patch must change between one and twenty files");
  if (
    statuses.some(
      ({ path: file }) => !input.selection.selectedPaths.includes(file) || !allowedRepairPath(file),
    )
  )
    fail("repair patch escapes the exact selected path allowlist");
  const paths = statuses.map(({ path: file }) => file).sort();
  const expectedPaths = proposal?.changedPaths ?? input.expectedChangedPaths;
  if (
    (proposal && proposal.outcome !== "proposed") ||
    !expectedPaths ||
    expectedPaths.join("\0") !== paths.join("\0")
  )
    fail("proposal does not match the reconstructed repair patch");
  const changedPaths = statuses.map((change) => changedPath(input.destination, change));
  const candidateTreeSha = requireSha(writeTree(input.destination), "candidate tree");
  const commit = String(
    git(input.destination, [
      "-c",
      "user.name=Advisor Repair Validator",
      "-c",
      "user.email=actions@github.com",
      "commit-tree",
      candidateTreeSha,
      "-p",
      input.selection.sourceHeadSha,
      "-m",
      "chore: validate Advisor repair candidate",
    ]),
  ).trim();
  git(input.destination, ["checkout", "--detach", commit]);
  git(input.destination, ["update-ref", "refs/remotes/origin/main", input.selection.baseSha]);
  return {
    repository: input.destination,
    patchSha256: digest(patch),
    candidateTreeSha,
    candidateDigest: candidateDigest(input.destination, input.selection.sourceHeadSha),
    changedPaths,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    value.every((item, index) => index === 0 || value[index - 1]! < item)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(message: string): never {
  throw new RepairError(message);
}
