#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi, githubGraphql } from "../advisors/github.mts";
import {
  collectPullRequestReviewState,
  pullRequestReviewStateDigest,
  type PullRequestReviewState,
} from "../pr-review-advisor/review-state.mts";
import {
  assertRepairContractSchema,
  CANONICAL_REPOSITORY,
  MAX_PATCH_BYTES,
  PHASE1_PILOT_AUTHOR,
  parseValidatedReceiptForPublication,
  readBoundedJson,
  readBoundedRegularFile,
  RepairContractError,
  sanitizeDiagnostic,
  type ValidationReceipt,
} from "./contract.mts";
import {
  GENERATED_HEAD_VALIDATIONS,
  generatedHeadRunTitle,
  listGeneratedHeadWorkflowRuns,
  TRUSTED_GENERATED_HEAD_REF,
} from "./generated-head-validation.mts";
import { validateMaintainerPermission } from "./select.mts";
import { appendPublicationJobSummary } from "./summary.mts";

const VERIFIED_RETRY_ATTEMPTS = 12;
const VERIFIED_RETRY_DELAY_MS = 5_000;

type GitHubRequest = <T>(
  apiPath: string,
  token: string,
  options?: { method?: string; body?: unknown },
) => Promise<T>;

type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

type PullRequest = {
  number?: unknown;
  state?: unknown;
  draft?: unknown;
  user?: { login?: unknown };
  head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
  base?: {
    sha?: unknown;
    ref?: unknown;
    repo?: { full_name?: unknown; node_id?: unknown };
  };
};

type TreeEntry = {
  path: string;
  status: "A" | "D" | "M";
  mode: "100644";
  type: "blob";
  sha: string | null;
};

export type PublicationReceipt = {
  version: 1;
  attemptKey: string;
  sourceHeadSha: string;
  candidateTreeSha: string;
  commitSha: string;
  headRef: string;
  dispatchedWorkflows: string[];
};

export type PublicationHeadAction = "atomic-update" | "resume-generated-head";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new RepairContractError(`${label} must be a full SHA`);
  }
  return value;
}

export function publicationHeadAction(
  sourceHeadSha: string,
  liveHeadSha: string,
  commitSha: string,
): PublicationHeadAction {
  if (liveHeadSha === sourceHeadSha) return "atomic-update";
  if (liveHeadSha === commitSha) return "resume-generated-head";
  throw new RepairContractError(
    "live pull request head is neither the approved source nor the verified repair commit",
  );
}

export function publisherGitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
}

function git(
  repository: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  buffer = false,
): string | Buffer {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
      "-c",
      "diff.external=",
      ...args,
    ],
    {
      cwd: repository,
      env,
      encoding: buffer ? undefined : "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_PATCH_BYTES + 1024 * 1024,
    },
  );
}

export function assertPublicationPullRequest(
  receipt: ValidationReceipt,
  pull: PullRequest,
): { repositoryId: string } {
  const identity = publicationPullRequestIdentity(receipt, pull);
  if (identity.headSha !== receipt.sourceHeadSha) {
    throw new RepairContractError(
      "live pull request identity or ownership changed before publication",
    );
  }
  return { repositoryId: identity.repositoryId };
}

export async function assertPublicationMaintainerPermissions(
  receipt: ValidationReceipt,
  token: string,
  request: GitHubRequest,
): Promise<void> {
  for (const actor of [receipt.author, receipt.optIn.actor, receipt.optIn.triggeringActor]) {
    const permission = await request<Parameters<typeof validateMaintainerPermission>[0]>(
      `repos/${CANONICAL_REPOSITORY}/collaborators/${encodeURIComponent(actor)}/permission`,
      token,
    );
    validateMaintainerPermission(permission, actor);
  }
}

function publicationPullRequestIdentity(
  receipt: ValidationReceipt,
  pull: PullRequest,
): { repositoryId: string; headSha: string } {
  if (
    pull.number !== receipt.prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.user?.login !== PHASE1_PILOT_AUTHOR ||
    receipt.author !== PHASE1_PILOT_AUTHOR ||
    pull.head?.ref !== receipt.headRef ||
    pull.head?.repo?.full_name !== CANONICAL_REPOSITORY ||
    pull.base?.sha !== receipt.baseSha ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError(
      "live pull request identity or ownership changed before publication",
    );
  }
  const headSha = fullSha(pull.head?.sha, "live pull request head SHA");
  const repositoryId = pull.base.repo.node_id;
  if (typeof repositoryId !== "string" || !repositoryId) {
    throw new RepairContractError("canonical repository node identity is missing");
  }
  return { repositoryId, headSha };
}

export function reconstructValidatedTree(input: {
  sourceCheckout: string;
  receipt: ValidationReceipt;
  patchFile: string;
  stagingDirectory: string;
}): { repository: string; treeSha: string } {
  const home = path.join(input.stagingDirectory, "home");
  const repository = path.join(input.stagingDirectory, "repo");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = publisherGitEnvironment(home);
  git(
    input.stagingDirectory,
    ["clone", "--no-local", "--no-hardlinks", "--no-checkout", input.sourceCheckout, repository],
    env,
  );
  git(repository, ["checkout", "--detach", input.receipt.sourceHeadSha], env);
  git(
    repository,
    ["apply", "--check", "--index", "--binary", "--whitespace=error-all", input.patchFile],
    env,
  );
  git(repository, ["apply", "--index", "--binary", "--whitespace=error-all", input.patchFile], env);
  git(repository, ["diff", "--cached", "--check", "HEAD", "--"], env);
  const treeSha = String(git(repository, ["write-tree"], env)).trim();
  if (treeSha !== input.receipt.candidateTreeSha) {
    throw new RepairContractError("publisher reconstructed a different candidate tree");
  }
  assertCandidateMatchesReceipt(repository, input.receipt, env);
  return { repository, treeSha };
}

function candidateTreeEntries(
  repository: string,
  sourceHeadSha: string,
  candidateTreeSha: string,
  env: NodeJS.ProcessEnv,
): TreeEntry[] {
  const raw = String(
    git(
      repository,
      ["diff", "--name-status", "--no-renames", "-z", sourceHeadSha, candidateTreeSha, "--"],
      env,
    ),
  ).split("\0");
  if (raw.at(-1) === "") raw.pop();
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new RepairContractError("publisher candidate has an invalid changed-path list");
  }
  const entries: TreeEntry[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const status = raw[index];
    const changedPath = raw[index + 1];
    if (!changedPath || !/^[ADM]$/u.test(status ?? "")) {
      throw new RepairContractError("publisher candidate contains an unsupported Git change");
    }
    if (status === "D") {
      entries.push({
        path: changedPath,
        status: "D",
        mode: "100644",
        type: "blob",
        sha: null,
      });
      continue;
    }
    const line = String(
      git(repository, ["ls-tree", candidateTreeSha, "--", changedPath], env),
    ).trim();
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match || match[2] !== changedPath) {
      throw new RepairContractError("publisher candidate contains an unsupported Git object");
    }
    entries.push({
      path: changedPath,
      status: status as "A" | "M",
      mode: "100644",
      type: "blob",
      sha: match[1],
    });
  }
  return entries;
}

function assertCandidateMatchesReceipt(
  repository: string,
  receipt: ValidationReceipt,
  env: NodeJS.ProcessEnv,
): void {
  const entries = candidateTreeEntries(
    repository,
    receipt.sourceHeadSha,
    receipt.candidateTreeSha,
    env,
  ).sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length !== receipt.changedPaths.length) {
    throw new RepairContractError("publisher candidate differs from the validation receipt");
  }
  entries.forEach((entry, index) => {
    const expected = receipt.changedPaths[index];
    const objectName = entry.status === "D" ? `${receipt.sourceHeadSha}:${entry.path}` : entry.sha;
    const bytes = objectName
      ? Number(String(git(repository, ["cat-file", "-s", objectName], env)).trim())
      : Number.NaN;
    if (
      !expected ||
      entry.path !== expected.path ||
      entry.status !== expected.status ||
      entry.mode !== expected.mode ||
      entry.type !== expected.type ||
      !Number.isSafeInteger(bytes) ||
      bytes !== expected.bytes
    ) {
      throw new RepairContractError("publisher candidate differs from the validation receipt");
    }
  });
}

async function createGitHubTree(input: {
  repository: string;
  sourceHeadSha: string;
  candidateTreeSha: string;
  token: string;
  request: GitHubRequest;
}): Promise<string> {
  const env = publisherGitEnvironment(path.join(input.repository, ".publisher-home"));
  const entries = candidateTreeEntries(
    input.repository,
    input.sourceHeadSha,
    input.candidateTreeSha,
    env,
  );
  for (const entry of entries) {
    if (!entry.sha) continue;
    const content = git(input.repository, ["cat-file", "blob", entry.sha], env, true) as Buffer;
    const created = await input.request<{ sha?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/git/blobs`,
      input.token,
      { method: "POST", body: { content: content.toString("base64"), encoding: "base64" } },
    );
    if (created.sha !== entry.sha) {
      throw new RepairContractError(`GitHub returned an unexpected blob for ${entry.path}`);
    }
  }
  const created = await input.request<{ sha?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/git/trees`,
    input.token,
    {
      method: "POST",
      body: {
        base_tree: input.sourceHeadSha,
        tree: entries.map(({ path: entryPath, mode, type, sha: entrySha }) => ({
          path: entryPath,
          mode,
          type,
          sha: entrySha,
        })),
      },
    },
  );
  if (created.sha !== input.candidateTreeSha) {
    throw new RepairContractError("GitHub returned a tree that differs from trusted validation");
  }
  return input.candidateTreeSha;
}

export async function waitForVerifiedCommit(
  expected: {
    commitSha: string;
    message: string;
    parentSha: string;
    treeSha: string;
  },
  token: string,
  request: GitHubRequest = githubApi,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let attempt = 1; attempt <= VERIFIED_RETRY_ATTEMPTS; attempt += 1) {
    const commit = await request<{
      sha?: unknown;
      message?: unknown;
      tree?: { sha?: unknown };
      parents?: Array<{ sha?: unknown }>;
      verification?: { verified?: unknown; reason?: unknown };
    }>(`repos/${CANONICAL_REPOSITORY}/git/commits/${expected.commitSha}`, token);
    if (commit.verification?.verified === true) {
      if (
        commit.sha !== expected.commitSha ||
        commit.message !== expected.message ||
        commit.tree?.sha !== expected.treeSha ||
        !Array.isArray(commit.parents) ||
        commit.parents.length !== 1 ||
        commit.parents[0]?.sha !== expected.parentSha
      ) {
        throw new RepairContractError(
          "verified repair commit does not match the approved one-parent tree",
        );
      }
      return;
    }
    if (attempt < VERIFIED_RETRY_ATTEMPTS) await wait(VERIFIED_RETRY_DELAY_MS);
  }
  throw new RepairContractError("GitHub did not verify the repair commit before publication");
}

export async function ensureVerifiedRepairCommit(input: {
  liveHeadSha: string;
  repository: string;
  receipt: ValidationReceipt;
  candidateTreeSha: string;
  token: string;
  request: GitHubRequest;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<string> {
  const message = `fix(advisor): apply validated review repair\n\nAdvisor-Repair-Attempt: ${input.receipt.attemptKey}`;
  let commitSha: string;
  if (input.liveHeadSha === input.receipt.sourceHeadSha) {
    await createGitHubTree({
      repository: input.repository,
      sourceHeadSha: input.receipt.sourceHeadSha,
      candidateTreeSha: input.candidateTreeSha,
      token: input.token,
      request: input.request,
    });
    const commit = await input.request<{ sha?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/git/commits`,
      input.token,
      {
        method: "POST",
        body: {
          message,
          tree: input.candidateTreeSha,
          parents: [input.receipt.sourceHeadSha],
        },
      },
    );
    commitSha = fullSha(commit.sha, "created repair commit SHA");
  } else {
    commitSha = fullSha(input.liveHeadSha, "live generated repair commit SHA");
  }
  await waitForVerifiedCommit(
    {
      commitSha,
      message,
      parentSha: input.receipt.sourceHeadSha,
      treeSha: input.candidateTreeSha,
    },
    input.token,
    input.request,
    input.wait,
  );
  return commitSha;
}

export async function atomicUpdate(input: {
  repositoryId: string;
  headRef: string;
  beforeOid: string;
  afterOid: string;
  graphql: GraphqlRequest;
}): Promise<void> {
  const result = (await input.graphql(
    `mutation UpdateAdvisorRepairRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) { clientMutationId }
    }`,
    {
      input: {
        clientMutationId: input.afterOid,
        repositoryId: input.repositoryId,
        refUpdates: [
          {
            name: `refs/heads/${input.headRef}`,
            beforeOid: input.beforeOid,
            afterOid: input.afterOid,
            force: false,
          },
        ],
      },
    },
  )) as { data?: { updateRefs?: { clientMutationId?: unknown } } };
  if (result.data?.updateRefs?.clientMutationId !== input.afterOid) {
    throw new RepairContractError("GitHub did not confirm the atomic repair ref update");
  }
}

const GENERATED_HEAD_DISPATCH_CLAIM = "Advisor repair validation dispatch";

async function assertValidationWorkflowsActive(
  token: string,
  request: GitHubRequest,
): Promise<void> {
  for (const { workflow } of GENERATED_HEAD_VALIDATIONS) {
    const metadata = await request<{ state?: unknown; path?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}`,
      token,
    );
    if (metadata.state !== "active" || metadata.path !== `.github/workflows/${workflow}`) {
      throw new RepairContractError(`generated-head workflow is not active: ${workflow}`);
    }
  }
}

export async function assertAdvisorArtifactsCurrent(
  receipt: ValidationReceipt,
  token: string,
  request: GitHubRequest = githubApi,
): Promise<void> {
  const artifacts = await Promise.all(
    receipt.advisor.artifactIds.map((artifactId) =>
      request<{
        id?: unknown;
        expired?: unknown;
        digest?: unknown;
        workflow_run?: { id?: unknown; head_sha?: unknown };
      }>(`repos/${CANONICAL_REPOSITORY}/actions/artifacts/${artifactId}`, token),
    ),
  );
  artifacts.forEach((artifact, index) => {
    if (
      artifact.id !== receipt.advisor.artifactIds[index] ||
      artifact.expired !== false ||
      artifact.digest !== receipt.advisor.artifactDigests[index] ||
      artifact.workflow_run?.id !== receipt.advisor.runId ||
      artifact.workflow_run?.head_sha !== receipt.advisor.workflowSha
    ) {
      throw new RepairContractError("Advisor artifact identity changed before publication");
    }
  });
}

export async function ensureGeneratedHeadValidation(
  receipt: ValidationReceipt,
  commitSha: string,
  token: string,
  request: GitHubRequest = githubApi,
): Promise<string[]> {
  const workflows = GENERATED_HEAD_VALIDATIONS.map(({ workflow }) => workflow);
  const checks = await request<{ total_count?: unknown; check_runs?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/commits/${commitSha}/check-runs?per_page=100`,
    token,
  );
  if (!Array.isArray(checks.check_runs) || checks.total_count !== checks.check_runs.length) {
    throw new RepairContractError("generated-head dispatch claim listing is incomplete");
  }
  for (const workflow of workflows) {
    const externalId = `${receipt.attemptKey}:${workflow}`;
    const claims = (checks.check_runs as Array<Record<string, unknown>>).filter(
      (check) => check.name === GENERATED_HEAD_DISPATCH_CLAIM && check.external_id === externalId,
    );
    if (claims.length > 1) {
      throw new RepairContractError(`${workflow} has duplicate generated-head dispatch claims`);
    }
    const matches = await matchingGeneratedHeadRuns(receipt, commitSha, workflow, token, request);
    if (matches.length > 1) {
      throw new RepairContractError(`${workflow} has duplicate generated-head dispatches`);
    }
    if (matches.length === 1 && claims.length === 1) {
      const claim = claims[0]!;
      if (claim.status === "completed" && claim.conclusion === "neutral") continue;
      if (
        claim.status !== "in_progress" ||
        !Number.isSafeInteger(claim.id) ||
        Number(claim.id) < 1
      ) {
        throw new RepairContractError(`${workflow} generated-head dispatch claim is malformed`);
      }
      await request(`repos/${CANONICAL_REPOSITORY}/check-runs/${Number(claim.id)}`, token, {
        method: "PATCH",
        body: {
          status: "completed",
          conclusion: "neutral",
          output: {
            title: `${workflow} generated-head dispatch accepted`,
            summary: `Attempt: ${receipt.attemptKey}`,
          },
        },
      });
      continue;
    }
    if (matches.length === 0) {
      if (claims.length === 1) {
        throw new RepairContractError(
          `${workflow} dispatch is durably claimed but its exact run is not visible; retry reconciliation later`,
        );
      }
      const claim = await request<{ id?: unknown }>(
        `repos/${CANONICAL_REPOSITORY}/check-runs`,
        token,
        {
          method: "POST",
          body: {
            name: GENERATED_HEAD_DISPATCH_CLAIM,
            head_sha: commitSha,
            status: "in_progress",
            external_id: externalId,
            output: {
              title: `Claim ${workflow} generated-head dispatch`,
              summary: `Attempt: ${receipt.attemptKey}`,
            },
          },
        },
      );
      if (!Number.isSafeInteger(claim.id) || Number(claim.id) < 1) {
        throw new RepairContractError(`${workflow} dispatch claim has no GitHub identity`);
      }
      const afterClaim = await matchingGeneratedHeadRuns(
        receipt,
        commitSha,
        workflow,
        token,
        request,
      );
      if (afterClaim.length > 1) {
        throw new RepairContractError(`${workflow} has duplicate generated-head dispatches`);
      }
      if (afterClaim.length === 0) {
        await dispatchGeneratedHeadWorkflow(receipt, commitSha, workflow, token, request);
      }
      await request(`repos/${CANONICAL_REPOSITORY}/check-runs/${Number(claim.id)}`, token, {
        method: "PATCH",
        body: {
          status: "completed",
          conclusion: "neutral",
          output: {
            title: `${workflow} generated-head dispatch accepted`,
            summary: `Attempt: ${receipt.attemptKey}`,
          },
        },
      });
    }
  }
  return workflows;
}

async function matchingGeneratedHeadRuns(
  receipt: ValidationReceipt,
  commitSha: string,
  workflow: string,
  token: string,
  request: GitHubRequest,
): Promise<Array<Record<string, unknown>>> {
  const validation = GENERATED_HEAD_VALIDATIONS.find((entry) => entry.workflow === workflow);
  if (!validation) {
    throw new RepairContractError(`unsupported generated-head workflow: ${workflow}`);
  }
  const runs = await listGeneratedHeadWorkflowRuns(workflow, token, request);
  return runs.filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      run.head_branch === TRUSTED_GENERATED_HEAD_REF &&
      typeof run.head_sha === "string" &&
      /^[0-9a-f]{40}$/u.test(run.head_sha) &&
      run.path === `.github/workflows/${workflow}` &&
      run.display_title ===
        generatedHeadRunTitle(validation.titlePrefix, receipt.attemptKey, commitSha),
  );
}

async function dispatchGeneratedHeadWorkflow(
  receipt: ValidationReceipt,
  commitSha: string,
  workflow: string,
  token: string,
  request: GitHubRequest,
): Promise<void> {
  const common = {
    pr_number: String(receipt.prNumber),
    source_head_sha: commitSha,
    base_sha: receipt.baseSha,
    repair_attempt_key: receipt.attemptKey,
  };
  if (workflow === "pr-review-advisor.yaml") {
    await request(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/pr-review-advisor.yaml/dispatches`,
      token,
      {
        method: "POST",
        body: {
          ref: TRUSTED_GENERATED_HEAD_REF,
          inputs: {
            target_repo: CANONICAL_REPOSITORY,
            target_pr: String(receipt.prNumber),
            target_base: "main",
            source_head_sha: commitSha,
            base_sha: receipt.baseSha,
            repair_attempt_key: receipt.attemptKey,
          },
        },
      },
    );
    return;
  }
  await request(`repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}/dispatches`, token, {
    method: "POST",
    body: { ref: TRUSTED_GENERATED_HEAD_REF, inputs: common },
  });
}

export async function publishValidatedRepair(input: {
  sourceCheckout: string;
  receipt: ValidationReceipt;
  patchFile: string;
  stagingDirectory: string;
  token: string;
  request?: GitHubRequest;
  graphql?: GraphqlRequest;
  wait?: (milliseconds: number) => Promise<void>;
  collectReviewState?: (
    repository: string,
    prNumber: number,
    token: string,
  ) => Promise<PullRequestReviewState>;
}): Promise<PublicationReceipt> {
  const request = input.request ?? githubApi;
  const graphql =
    input.graphql ?? ((query, variables) => githubGraphql(input.token, query, variables));
  const pull = await request<PullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${input.receipt.prNumber}`,
    input.token,
  );
  const initialIdentity = publicationPullRequestIdentity(input.receipt, pull);
  const { repositoryId } = initialIdentity;
  await assertPublicationMaintainerPermissions(input.receipt, input.token, request);
  const collectReviewState = input.collectReviewState ?? collectPullRequestReviewState;
  if (initialIdentity.headSha === input.receipt.sourceHeadSha) {
    const initialReviewState = await collectReviewState(
      CANONICAL_REPOSITORY,
      input.receipt.prNumber,
      input.token,
    );
    if (
      initialReviewState.headSha !== input.receipt.sourceHeadSha ||
      pullRequestReviewStateDigest(initialReviewState) !== input.receipt.advisor.reviewStateDigest
    ) {
      throw new RepairContractError("live review-thread state changed before publication");
    }
  }
  await assertValidationWorkflowsActive(input.token, request);
  const reconstructed = reconstructValidatedTree({
    sourceCheckout: input.sourceCheckout,
    receipt: input.receipt,
    patchFile: input.patchFile,
    stagingDirectory: input.stagingDirectory,
  });
  const commitSha = await ensureVerifiedRepairCommit({
    liveHeadSha: initialIdentity.headSha,
    repository: reconstructed.repository,
    receipt: input.receipt,
    candidateTreeSha: reconstructed.treeSha,
    token: input.token,
    request,
    wait: input.wait,
  });
  const current = await request<PullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${input.receipt.prNumber}`,
    input.token,
  );
  const currentIdentity = publicationPullRequestIdentity(input.receipt, current);
  await assertAdvisorArtifactsCurrent(input.receipt, input.token, request);
  const headAction = publicationHeadAction(
    input.receipt.sourceHeadSha,
    currentIdentity.headSha,
    commitSha,
  );
  if (headAction === "atomic-update") {
    await assertPublicationMaintainerPermissions(input.receipt, input.token, request);
    const currentReviewState = await collectReviewState(
      CANONICAL_REPOSITORY,
      input.receipt.prNumber,
      input.token,
    );
    if (
      currentReviewState.headSha !== input.receipt.sourceHeadSha ||
      pullRequestReviewStateDigest(currentReviewState) !== input.receipt.advisor.reviewStateDigest
    ) {
      throw new RepairContractError("live review-thread state changed at the publication boundary");
    }
    await atomicUpdate({
      repositoryId,
      headRef: input.receipt.headRef,
      beforeOid: input.receipt.sourceHeadSha,
      afterOid: commitSha,
      graphql,
    });
  }
  const dispatchedWorkflows = await ensureGeneratedHeadValidation(
    input.receipt,
    commitSha,
    input.token,
    request,
  );
  const publication: PublicationReceipt = {
    version: 1,
    attemptKey: input.receipt.attemptKey,
    sourceHeadSha: input.receipt.sourceHeadSha,
    candidateTreeSha: input.receipt.candidateTreeSha,
    commitSha,
    headRef: input.receipt.headRef,
    dispatchedWorkflows,
  };
  assertRepairContractSchema("publication-receipt", publication);
  return publication;
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.ADVISOR_REPAIR_PHASE1_ENABLED !== "true") {
    throw new RepairContractError("Phase 1 publication is disabled");
  }
  const patchFile = required(env, "VALIDATED_PATCH_FILE");
  const patch = readBoundedRegularFile(patchFile, MAX_PATCH_BYTES);
  const receipt = parseValidatedReceiptForPublication(
    readBoundedJson(required(env, "VALIDATION_RECEIPT_FILE"), 1024 * 1024),
    patch,
  );
  const stagingRoot = required(env, "PUBLISH_STAGING_ROOT");
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = fs.mkdtempSync(path.join(stagingRoot, "candidate-"));
  try {
    const publication = await publishValidatedRepair({
      sourceCheckout: required(env, "SOURCE_CHECKOUT"),
      receipt,
      patchFile,
      stagingDirectory,
      token: required(env, "GITHUB_TOKEN"),
    });
    const outputDirectory = required(env, "PUBLICATION_OUTPUT_DIR");
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(outputDirectory, "publication-receipt.json"),
      `${JSON.stringify(publication, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.appendFileSync(
      required(env, "GITHUB_OUTPUT"),
      `commit_sha=${publication.commitSha}\nhead_ref=${publication.headRef}\n`,
    );
    appendPublicationJobSummary(env.GITHUB_STEP_SUMMARY, publication);
  } finally {
    fs.rmSync(stagingDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
