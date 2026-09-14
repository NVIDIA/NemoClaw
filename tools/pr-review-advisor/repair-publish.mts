// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createVerifiedCommit,
  type GitHubRequest,
  type GraphqlRequest,
  githubClient,
  updateVerifiedRef,
} from "../pull-requests/publication.mts";
import {
  assertRepairArtifactDirectory,
  assertLiveRepairState,
  assertValidatedRepair,
  fullSha,
  parseSelection,
  parseValidationReceipt,
  readJson,
  REPAIR_REPOSITORY,
  RepairError,
  validateRepairPatch,
} from "./repair-contract.mts";

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
  commitSha: string;
  graphql: GraphqlRequest;
  request: GitHubRequest;
  selectionPath: string;
  state: unknown;
  reviews: unknown;
}): Promise<void> {
  const selection = parseSelection(readJson(input.selectionPath));
  assertLiveRepairState(selection, input.state, input.reviews);
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
      commitSha,
      graphql: client.graphql,
      request: client.request,
      selectionPath: required(process.env.SELECTION_FILE, "SELECTION_FILE"),
      state: readJson(required(process.env.STATE_FILE, "STATE_FILE")),
      reviews: readJson(required(process.env.REVIEWS_FILE, "REVIEWS_FILE")),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `published-sha=${commitSha}\n`);
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
