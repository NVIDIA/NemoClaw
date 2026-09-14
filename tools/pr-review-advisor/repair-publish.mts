// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createVerifiedCommit,
  type GitHubRequest,
  type GraphqlRequest,
  githubClient,
  updateVerifiedRef,
} from "../pull-requests/publication.mts";
import { canonicalJson } from "../advisors/canonical-json.mts";
import {
  assertRepairArtifactDirectory,
  assertLiveRepairState,
  assertValidatedRepair,
  digest,
  fullSha,
  parseSelection,
  parseValidationReceipt,
  readJson,
  REPAIR_REPOSITORY,
  RepairError,
  validateRepairPatch,
} from "./repair-contract.mts";

export type RepairPublicationAuthorization = {
  version: 1;
  environment: "advisor-repair-publish";
  workflowRunId: number;
  workflowRunAttempt: number;
  attemptKey: string;
  selectionDigest: string;
  stateDigest: string;
  reviewDigest: string;
  commitSha: string;
};

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function authorizePreparedAdvisorRepair(input: {
  commitSha: string;
  selectionPath: string;
  state: unknown;
  reviews: unknown;
  workflowRunId: number;
  workflowRunAttempt: number;
}): RepairPublicationAuthorization {
  const selection = parseSelection(readJson(input.selectionPath));
  assertLiveRepairState(selection, input.state, input.reviews);
  if (!positiveInteger(input.workflowRunId) || !positiveInteger(input.workflowRunAttempt))
    throw new RepairError("protected publication run identity is invalid");
  return {
    version: 1,
    environment: "advisor-repair-publish",
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    attemptKey: selection.attemptKey,
    selectionDigest: digest(canonicalJson(selection)),
    stateDigest: selection.stateDigest,
    reviewDigest: selection.reviewDigest,
    commitSha: fullSha(input.commitSha, "prepared SHA"),
  };
}

function assertPublicationAuthorization(
  authorization: unknown,
  selection: ReturnType<typeof parseSelection>,
  input: {
    commitSha: string;
    state: unknown;
    reviews: unknown;
    workflowRunId: number;
    workflowRunAttempt: number;
  },
): void {
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    (authorization as RepairPublicationAuthorization).version !== 1 ||
    (authorization as RepairPublicationAuthorization).environment !== "advisor-repair-publish" ||
    !positiveInteger((authorization as RepairPublicationAuthorization).workflowRunId) ||
    !positiveInteger((authorization as RepairPublicationAuthorization).workflowRunAttempt) ||
    (authorization as RepairPublicationAuthorization).workflowRunId !== input.workflowRunId ||
    (authorization as RepairPublicationAuthorization).workflowRunAttempt !==
      input.workflowRunAttempt ||
    (authorization as RepairPublicationAuthorization).attemptKey !== selection.attemptKey ||
    (authorization as RepairPublicationAuthorization).selectionDigest !==
      digest(canonicalJson(selection)) ||
    (authorization as RepairPublicationAuthorization).stateDigest !== selection.stateDigest ||
    (authorization as RepairPublicationAuthorization).reviewDigest !== selection.reviewDigest ||
    (authorization as RepairPublicationAuthorization).commitSha !== input.commitSha
  )
    throw new RepairError("protected publication authorization does not match the repair");
  assertLiveRepairState(selection, input.state, input.reviews);
}

export async function prepareAdvisorRepair(input: {
  request: GitHubRequest;
  sourceRepository: string;
  selectionPath: string;
  patchPath: string;
  receiptPath: string;
  workDirectory: string;
}): Promise<string> {
  assertRepairArtifactDirectory(path.dirname(input.selectionPath), {
    "model-context.json": 5 * 1024 * 1024,
    "selection.json": 1024 * 1024,
  });
  assertRepairArtifactDirectory(path.dirname(input.receiptPath), {
    "repair.patch": 2 * 1024 * 1024,
    "validation.json": 1024 * 1024,
  });
  const selection = parseSelection(readJson(input.selectionPath));
  const receipt = parseValidationReceipt(readJson(input.receiptPath));
  const candidate = validateRepairPatch({
    sourceCheckout: input.sourceRepository,
    destination: input.workDirectory,
    selection,
    patchFile: input.patchPath,
    expectedChangedPaths: receipt.changedPaths.map(({ path }) => path),
  });
  assertValidatedRepair(selection, receipt, candidate);
  return createVerifiedCommit({
    finalTree: candidate.candidateTreeSha,
    headSha: selection.sourceHeadSha,
    message: `fix: address PR Review Advisor findings\n\n${selection.findingIds.join("\n")}\n\nAdvisor-Repair-Attempt: ${selection.attemptKey}`,
    repository: candidate.repository,
    repositoryName: REPAIR_REPOSITORY,
    request: input.request,
  });
}

export async function publishPreparedAdvisorRepair(input: {
  authorization: unknown;
  commitSha: string;
  graphql: GraphqlRequest;
  request: GitHubRequest;
  selectionPath: string;
  state: unknown;
  reviews: unknown;
  workflowRunId: number;
  workflowRunAttempt: number;
}): Promise<void> {
  const selection = parseSelection(readJson(input.selectionPath));
  assertPublicationAuthorization(input.authorization, selection, input);
  const commit = (await input.request(
    "GET",
    `/repos/${REPAIR_REPOSITORY}/git/commits/${input.commitSha}`,
  )) as {
    sha?: unknown;
    parents?: Array<{ sha?: unknown }>;
    verification?: { verified?: unknown };
  };
  if (
    commit.sha !== input.commitSha ||
    commit.parents?.length !== 1 ||
    commit.parents[0]?.sha !== selection.sourceHeadSha ||
    commit.verification?.verified !== true
  ) {
    throw new RepairError("prepared Advisor repair commit is invalid");
  }
  await updateVerifiedRef({
    commitSha: input.commitSha,
    graphql: input.graphql,
    headRef: selection.headRef,
    headSha: selection.sourceHeadSha,
    repositoryId: selection.repositoryId,
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new RepairError(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const client = githubClient(token);
  if (process.argv[2] === "prepare") {
    const commitSha = await prepareAdvisorRepair({
      request: client.request,
      sourceRepository: required(process.env.SOURCE_REPOSITORY, "SOURCE_REPOSITORY"),
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      patchPath: required(process.env.PATCH_FILE, "PATCH_FILE"),
      receiptPath: required(process.env.RECEIPT_FILE, "RECEIPT_FILE"),
      workDirectory: required(process.env.WORK_DIRECTORY, "WORK_DIRECTORY"),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `prepared-sha=${commitSha}\n`);
    return;
  }
  if (process.argv[2] === "publish") {
    const commitSha = fullSha(required(process.env.PREPARED_SHA, "PREPARED_SHA"), "prepared SHA");
    await publishPreparedAdvisorRepair({
      authorization: readJson(required(process.env.AUTHORIZATION_FILE, "AUTHORIZATION_FILE")),
      commitSha,
      graphql: client.graphql,
      request: client.request,
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      state: readJson(required(process.env.STATE_FILE, "STATE_FILE")),
      reviews: readJson(required(process.env.REVIEWS_FILE, "REVIEWS_FILE")),
      workflowRunId: Number(required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")),
      workflowRunAttempt: Number(required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT")),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `published-sha=${commitSha}\n`);
    return;
  }
  if (process.argv[2] === "authorize") {
    const authorizationFile = required(process.env.AUTHORIZATION_FILE, "AUTHORIZATION_FILE");
    const authorization = authorizePreparedAdvisorRepair({
      commitSha: fullSha(required(process.env.PREPARED_SHA, "PREPARED_SHA"), "prepared SHA"),
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      state: readJson(required(process.env.STATE_FILE, "STATE_FILE")),
      reviews: readJson(required(process.env.REVIEWS_FILE, "REVIEWS_FILE")),
      workflowRunId: Number(required(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID")),
      workflowRunAttempt: Number(required(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT")),
    });
    writeFileSync(authorizationFile, `${canonicalJson(authorization)}\n`, { mode: 0o600 });
    return;
  }
  throw new RepairError(`unsupported repair publication command: ${process.argv[2] ?? ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
