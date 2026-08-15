#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAllowedDocumentationPath,
  PostMergeDocsError,
  requireSha,
  validateArtifact,
  type ValidatedArtifact,
} from "./artifact.mts";
import { HARDENED_GIT_ENV, hardenedGitArgs, prepareCombinedBase } from "./base.mts";
import {
  BOT_LOGIN,
  BOT_SIGN_OFF,
  MANAGED_END,
  MANAGED_START,
  parseRetirementPendingMarker,
  parseRetiredEmptyMarker,
  ROLLING_BRANCH,
  ROLLING_TITLE,
  retirementPendingMarker,
  retiredEmptyMarker,
  validateManagedBlock,
} from "./contract.mts";
import {
  discoverState,
  latestReachableSemverTag,
  validatePendingRetirementTree,
} from "./discover.mts";

export { BOT_SIGN_OFF, MANAGED_END, MANAGED_START, ROLLING_BRANCH, ROLLING_TITLE };

type GitHubRequest = (
  method: "GET" | "POST" | "PATCH",
  apiPath: string,
  body?: unknown,
) => Promise<unknown>;
type GraphqlRequest = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

type PullRequest = {
  body: string | null;
  draft: boolean;
  html_url: string;
  merged_at: string | null;
  number: number;
  state: string;
  user: { login: string } | null;
  base: { ref: string; repo: { full_name: string } };
  head: { ref: string; repo: { full_name: string } | null; sha: string };
};

type GitRef = { object: { sha: string } };
type GitTreeEntry = { mode: string; path: string; sha: string | null; type: "blob" };

export type PublicationResult = {
  status: "no_changes" | "pr_pending";
  coveredSha: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new PostMergeDocsError(`${name} is required`);
  return value;
}

function git(
  repository: string,
  args: readonly string[],
  options: { allowFailure?: boolean; encoding?: "buffer" | "utf8" } = {},
): Buffer | string {
  const result = spawnSync("git", hardenedGitArgs(args), {
    cwd: repository,
    encoding: options.encoding === "buffer" ? undefined : "utf8",
    env: HARDENED_GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? "").trim();
    throw new PostMergeDocsError(
      `Git ${args[0] ?? "command"} failed: ${detail || "unknown error"}`,
    );
  }
  return result.stdout ?? (options.encoding === "buffer" ? Buffer.alloc(0) : "");
}

function gitText(repository: string, args: readonly string[]): string {
  return String(git(repository, args)).trim();
}

function assertRange(repository: string, rangeStartSha: string, mainSha: string): void {
  for (const sha of [rangeStartSha, mainSha]) {
    const result = spawnSync("git", hardenedGitArgs(["cat-file", "-e", `${sha}^{commit}`]), {
      cwd: repository,
      env: HARDENED_GIT_ENV,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new PostMergeDocsError(`Git repository does not contain ${sha}`);
  }
  const ancestry = spawnSync(
    "git",
    hardenedGitArgs(["merge-base", "--is-ancestor", rangeStartSha, mainSha]),
    {
      cwd: repository,
      env: HARDENED_GIT_ENV,
      stdio: "ignore",
    },
  );
  if (ancestry.status !== 0) {
    throw new PostMergeDocsError("range start commit is not an ancestor of the exact main commit");
  }
}

function changedPaths(repository: string, fromTree: string, toTree: string): string[] {
  const output = git(repository, ["diff", "--name-only", "--no-renames", "-z", fromTree, toTree], {
    encoding: "buffer",
  }) as Buffer;
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function inspectTreeEntry(repository: string, tree: string, filePath: string): GitTreeEntry | null {
  const output = (
    git(repository, ["ls-tree", "-z", tree, "--", filePath], {
      encoding: "buffer",
    }) as Buffer
  ).toString("utf8");
  if (!output) return null;
  const tab = output.indexOf("\t");
  const [mode, type, sha] = output.slice(0, tab).split(" ");
  if (tab < 0 || type !== "blob" || !sha || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new PostMergeDocsError(`Git returned an invalid tree entry for ${filePath}`);
  }
  if (mode !== "100644") {
    throw new PostMergeDocsError(
      `documentation patch may create only regular non-executable files: ${filePath}`,
    );
  }
  return { mode, path: filePath, sha, type: "blob" };
}

export function applyAndValidatePatch(input: {
  artifact: ValidatedArtifact;
  sourceRepository: string;
  destination: string;
}): { repository: string; finalTree: string; paths: string[] } {
  const { result, patchPath } = input.artifact;
  assertRange(input.sourceRepository, result.rangeStartSha, result.mainSha);
  const combined = prepareCombinedBase({
    sourceRepository: input.sourceRepository,
    destination: input.destination,
    mainSha: result.mainSha,
    rollingHeadSha: result.rollingHeadSha,
  });
  if (combined.baseTreeSha !== result.baseTreeSha) {
    throw new PostMergeDocsError("publisher reconstruction does not match the reviewed base tree");
  }
  if (patchPath) {
    git(input.destination, ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath]);
  }
  const finalTree = requireSha(gitText(input.destination, ["write-tree"]), "documentation tree");
  if (finalTree !== result.finalTreeSha) {
    throw new PostMergeDocsError(
      "publisher tree differs from the independently reviewed final tree",
    );
  }
  const paths = changedPaths(input.destination, result.baseTreeSha, finalTree).sort();
  const fullPaths = changedPaths(input.destination, result.mainSha, finalTree).sort();
  if (result.outcome === "changes" && paths.length === 0) {
    throw new PostMergeDocsError("documentation patch does not change the combined base tree");
  }
  if (paths.some((entry) => !isAllowedDocumentationPath(entry))) {
    throw new PostMergeDocsError("documentation patch changes a path outside docs/ or fern/");
  }
  for (const [actual, expected, label] of [
    [paths, result.authorPaths, "author"],
    [fullPaths, result.documentationPaths, "complete documentation"],
  ] as const) {
    if (
      actual.length !== expected.length ||
      actual.some((entry, index) => entry !== expected[index])
    ) {
      throw new PostMergeDocsError(`${label} paths do not match the structured result`);
    }
  }
  let totalBytes = 0;
  for (const filePath of fullPaths) {
    const entry = inspectTreeEntry(input.destination, finalTree, filePath);
    if (!entry) continue;
    const size = Number.parseInt(
      gitText(input.destination, ["cat-file", "-s", entry.sha ?? ""]),
      10,
    );
    if (!Number.isSafeInteger(size) || size > 1_048_576) {
      throw new PostMergeDocsError(`documentation file exceeds 1048576 bytes: ${filePath}`);
    }
    totalBytes += size;
  }
  if (totalBytes > 5_242_880)
    throw new PostMergeDocsError("documentation files exceed 5242880 bytes");
  return { repository: input.destination, finalTree, paths };
}

function managedBody(input: {
  result: ValidatedArtifact["result"];
  commitSha: string;
  agentsBlobSha: string;
}): string {
  const { result } = input;
  const proseType = result.includesCodeSampleChanges
    ? "- [x] Doc only (includes code sample changes)"
    : "- [x] Doc only (prose changes, no code sample modifications)";
  const body = `${MANAGED_START}

## Summary

This draft updates documentation for merged changes from \`${result.rangeStartSha}\` through \`${result.mainSha}\`.

The post-merge documentation workflow will update this PR when more changes merge to \`main\`.

## Changes

${result.documentationPaths.map((file) => `- \`${file}\``).join("\n") || "- Merge the exact main commit into the rolling documentation branch."}

## Type of Change

- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
${proseType}
${result.includesCodeSampleChanges ? "- [ ] Doc only (prose changes, no code sample modifications)" : "- [ ] Doc only (includes code sample changes)"}

## Quality Gates

- [x] Tests not applicable — justification: This PR changes documentation only.
- [x] Docs updated for user-facing behavior changes

## Documentation Writer Review

- [x] Documentation writer subagent reviewed the completed changes
- Result: \`docs-updated\`
- Evidence: ${result.documentationPaths.join(", ") || "The independent reviewer approved the merged documentation tree."} The reviewer checked the writing rules and documentation style. The trusted host docs validation passed.
- Agent: Pi coding agent in GitHub Actions
<!-- docs-review-head-sha: ${input.commitSha.slice(0, 12)} -->
<!-- docs-review-agents-blob-sha: ${input.agentsBlobSha.slice(0, 12)} -->

## Verification

- [ ] PR description includes a \`Signed-off-by:\` line and every commit appears as \`Verified\` in GitHub
- Automation evidence: GitHub verified the workflow-created commit. Maintainer-added commits require separate verification.
- [x] Tests are not applicable because this PR changes documentation only
- [x] Quality Gates section completed with required justifications
- [x] No secrets, API keys, or credentials committed
- [x] \`npm run docs:validate\` passes
- [x] Doc pages follow the documentation style guide

${BOT_SIGN_OFF}
${MANAGED_END}`;
  validateManagedBlock(body);
  return body;
}

function retirementPendingManagedBody(input: {
  result: ValidatedArtifact["result"];
  commitSha: string;
  agentsBlobSha: string;
}): string {
  const { result } = input;
  if (result.documentationPaths.length !== 0) {
    throw new PostMergeDocsError("an empty retirement cannot contain documentation paths");
  }
  const body = `${MANAGED_START}

## Summary

The workflow selected this rolling documentation PR for retirement because its reviewed candidate matches \`main\` at \`${result.mainSha}\`.

Documentation readiness requires the workflow to publish that candidate and confirm this PR is closed.

## Changes

- The reviewed candidate contains no documentation diff against \`main\`.

## Type of Change

- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
- [ ] Doc only (includes code sample changes)
- [ ] Doc only (prose changes, no code sample modifications)

## Quality Gates

- [x] Tests not applicable — justification: The reviewed candidate matches \`main\`.
- [x] Docs not applicable — justification: The reviewed candidate has no documentation diff.

## Documentation Writer Review

- [x] Documentation writer subagent reviewed the completed changes
- Result: \`blocked\`
- Evidence: The reviewed candidate needs no documentation update. Branch publication and PR closure are pending. The trusted host docs validation passed.
- Agent: Pi coding agent in GitHub Actions
<!-- docs-review-head-sha: ${input.commitSha.slice(0, 12)} -->
<!-- docs-review-agents-blob-sha: ${input.agentsBlobSha.slice(0, 12)} -->

## Verification

- [ ] PR description includes a \`Signed-off-by:\` line and every commit appears as \`Verified\` in GitHub
- Automation evidence: GitHub verified the workflow-created commit. Maintainer-added commits require separate verification.
- [x] Tests are not applicable because the reviewed candidate matches \`main\`
- [x] Quality Gates section completed with required justifications
- [x] No secrets, API keys, or credentials committed
- [x] \`npm run docs:validate\` passes

${BOT_SIGN_OFF}
${MANAGED_END}`;
  validateManagedBlock(body);
  return body;
}

function retiredManagedBody(input: {
  result: Pick<ValidatedArtifact["result"], "documentationPaths" | "mainSha">;
  commitSha: string;
  agentsBlobSha: string;
}): string {
  const { result } = input;
  if (result.documentationPaths.length !== 0) {
    throw new PostMergeDocsError("an empty retirement cannot contain documentation paths");
  }
  const body = `${MANAGED_START}

## Summary

This rolling documentation PR is closed because its reviewed tree matches \`main\` at \`${result.mainSha}\`.

The workflow retained the rolling branch for the next merged change.

## Changes

- No documentation diff remains against \`main\`.

## Type of Change

- [ ] Code change (feature, bug fix, or refactor)
- [ ] Code change with doc updates
- [ ] Doc only (includes code sample changes)
- [ ] Doc only (prose changes, no code sample modifications)

## Quality Gates

- [x] Tests not applicable — justification: This closed PR has no diff against \`main\`.
- [x] Docs not applicable — justification: The reviewed tree matches \`main\`.

## Documentation Writer Review

- [x] Documentation writer subagent reviewed the completed changes
- Result: \`no-docs-needed\`
- Evidence: The independent reviewer confirmed that the reviewed rolling tree matches \`main\` at \`${result.mainSha}\`. The trusted host docs validation passed.
- Agent: Pi coding agent in GitHub Actions
<!-- docs-review-head-sha: ${input.commitSha.slice(0, 12)} -->
<!-- docs-review-agents-blob-sha: ${input.agentsBlobSha.slice(0, 12)} -->

## Verification

- [ ] PR description includes a \`Signed-off-by:\` line and every commit appears as \`Verified\` in GitHub
- Automation evidence: GitHub verified the workflow-created commit. Maintainer-added commits require separate verification.
- [x] Tests are not applicable because this closed PR has no diff against \`main\`
- [x] Quality Gates section completed with required justifications
- [x] No secrets, API keys, or credentials committed
- [x] \`npm run docs:validate\` passes

${BOT_SIGN_OFF}
${MANAGED_END}`;
  validateManagedBlock(body);
  return body;
}

function replaceManagedBlock(body: string, block: string): string {
  validateManagedBlock(body);
  const start = body.indexOf(MANAGED_START);
  const end = body.indexOf(MANAGED_END) + MANAGED_END.length;
  const replaced = `${body.slice(0, start)}${block}${body.slice(end)}`;
  validateManagedBlock(replaced);
  return replaced;
}

function validateExistingPull(pull: PullRequest, repository: string): void {
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.html_url !== `https://github.com/${repository}/pull/${pull.number}` ||
    typeof pull.draft !== "boolean" ||
    pull.state !== "open" ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    pull.head.ref !== ROLLING_BRANCH ||
    pull.head.repo?.full_name !== repository ||
    !/^[0-9a-f]{40}$/u.test(pull.head.sha) ||
    pull.user?.login !== BOT_LOGIN
  ) {
    throw new PostMergeDocsError(
      "the rolling documentation PR does not match the trusted draft contract",
    );
  }
  validateManagedBlock(pull.body ?? "");
}

function validateRetiredPull(
  pull: PullRequest,
  repository: string,
  expectedHeadSha: string,
  expectedMainSha: string,
): void {
  const marker = parseRetiredEmptyMarker(pull.body ?? "");
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.html_url !== `https://github.com/${repository}/pull/${pull.number}` ||
    typeof pull.draft !== "boolean" ||
    pull.state !== "closed" ||
    pull.merged_at !== null ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    pull.head.ref !== ROLLING_BRANCH ||
    pull.head.repo?.full_name !== repository ||
    pull.head.sha !== expectedHeadSha ||
    pull.user?.login !== BOT_LOGIN ||
    marker?.mainSha !== expectedMainSha ||
    marker?.headSha !== expectedHeadSha
  ) {
    throw new PostMergeDocsError("GitHub did not confirm the retired empty documentation PR");
  }
  validateManagedBlock(pull.body ?? "");
}

function validatePendingRetiredPull(
  pull: PullRequest,
  repository: string,
  expectedHeadSha: string,
  expectedMainSha: string,
): void {
  const marker = parseRetirementPendingMarker(pull.body ?? "");
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.html_url !== `https://github.com/${repository}/pull/${pull.number}` ||
    typeof pull.draft !== "boolean" ||
    pull.state !== "closed" ||
    pull.merged_at !== null ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    pull.head.ref !== ROLLING_BRANCH ||
    pull.head.repo?.full_name !== repository ||
    pull.head.sha !== expectedHeadSha ||
    pull.user?.login !== BOT_LOGIN ||
    marker?.mainSha !== expectedMainSha ||
    marker?.headSha !== expectedHeadSha
  ) {
    throw new PostMergeDocsError(
      "GitHub did not confirm the closed pending documentation retirement",
    );
  }
  validateManagedBlock(pull.body ?? "");
}

async function publishFinalRetiredBody(input: {
  pull: PullRequest;
  block: string;
  repository: string;
  expectedHeadSha: string;
  expectedMainSha: string;
  request: GitHubRequest;
}): Promise<PullRequest> {
  validatePendingRetiredPull(
    input.pull,
    input.repository,
    input.expectedHeadSha,
    input.expectedMainSha,
  );
  const finalBody = replaceManagedBlock(input.pull.body ?? "", input.block);
  let response: PullRequest;
  try {
    response = (await requestWithRetry(
      input.request,
      "PATCH",
      `/repos/${input.repository}/pulls/${input.pull.number}`,
      { body: finalBody },
    )) as PullRequest;
  } catch (error) {
    response = (await input.request(
      "GET",
      `/repos/${input.repository}/pulls/${input.pull.number}`,
    )) as PullRequest;
    try {
      validateRetiredPull(response, input.repository, input.expectedHeadSha, input.expectedMainSha);
      if (response.body !== finalBody) throw new PostMergeDocsError("retired PR body differs");
    } catch {
      throw error;
    }
  }
  validateRetiredPull(response, input.repository, input.expectedHeadSha, input.expectedMainSha);
  if (response.body !== finalBody) {
    throw new PostMergeDocsError("GitHub did not confirm the final retired PR body");
  }
  return response;
}

type HistoricalPendingRetirement = {
  pull: PullRequest;
  mainSha: string;
  headSha: string;
  mainTreeSha: string;
};

async function finalizeHistoricalPendingRetirement(input: {
  pending: HistoricalPendingRetirement;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<void> {
  const agentsEntry = inspectTreeEntry(input.repository, input.pending.mainTreeSha, "AGENTS.md");
  if (!agentsEntry?.sha) {
    throw new PostMergeDocsError("reviewed historical tree has no regular AGENTS.md blob");
  }
  const finalBlock = retiredManagedBody({
    result: { documentationPaths: [], mainSha: input.pending.mainSha },
    commitSha: input.pending.headSha,
    agentsBlobSha: agentsEntry.sha,
  }).replace(
    MANAGED_END,
    `${retiredEmptyMarker(input.pending.mainSha, input.pending.headSha)}\n${MANAGED_END}`,
  );
  await publishFinalRetiredBody({
    pull: input.pending.pull,
    block: finalBlock,
    repository: input.repositoryName,
    expectedHeadSha: input.pending.headSha,
    expectedMainSha: input.pending.mainSha,
    request: input.request,
  });
}

async function createGitHubTree(input: {
  repository: string;
  repositoryName: string;
  mainSha: string;
  finalTree: string;
  paths: string[];
  request: GitHubRequest;
}): Promise<string> {
  const entries: GitTreeEntry[] = [];
  for (const filePath of input.paths) {
    const entry = inspectTreeEntry(input.repository, input.finalTree, filePath);
    if (!entry) {
      entries.push({ mode: "100644", path: filePath, sha: null, type: "blob" });
      continue;
    }
    const content = execFileSync("git", hardenedGitArgs(["cat-file", "blob", entry.sha ?? ""]), {
      cwd: input.repository,
      env: HARDENED_GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const created = (await input.request("POST", `/repos/${input.repositoryName}/git/blobs`, {
      content: content.toString("base64"),
      encoding: "base64",
    })) as { sha?: string };
    if (created.sha !== entry.sha) {
      throw new PostMergeDocsError(`GitHub returned an unexpected blob SHA for ${filePath}`);
    }
    entries.push(entry);
  }
  const tree = (await input.request("POST", `/repos/${input.repositoryName}/git/trees`, {
    base_tree: requireSha(
      gitText(input.repository, ["rev-parse", `${input.mainSha}^{tree}`]),
      "exact main tree",
    ),
    tree: entries,
  })) as { sha?: string };
  if (tree.sha !== input.finalTree) {
    throw new PostMergeDocsError(
      "GitHub returned a tree that differs from the validated documentation tree",
    );
  }
  return input.finalTree;
}

async function updateBranch(input: {
  repositoryName: string;
  repositoryId: string;
  previousSha: string;
  commitSha: string;
  graphql: GraphqlRequest;
}): Promise<void> {
  const mutation = `
    mutation UpdatePostMergeDocsRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) { clientMutationId }
    }
  `;
  const result = (await input.graphql(mutation, {
    input: {
      clientMutationId: input.commitSha,
      refUpdates: [
        {
          afterOid: input.commitSha,
          beforeOid: input.previousSha,
          force: false,
          name: `refs/heads/${ROLLING_BRANCH}`,
        },
      ],
      repositoryId: input.repositoryId,
    },
  })) as { updateRefs?: { clientMutationId?: string } };
  if (result.updateRefs?.clientMutationId !== input.commitSha) {
    throw new PostMergeDocsError("GitHub did not confirm the atomic documentation branch update");
  }
}

async function prepareCleanRollingCommit(input: {
  previousSha: string;
  previousTree: string;
  mainSha: string;
  mainTree: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  if (input.previousTree === input.mainTree) return input.previousSha;
  const commit = (await input.request("POST", `/repos/${input.repositoryName}/git/commits`, {
    message: `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
    parents: [input.previousSha, input.mainSha],
    tree: input.mainTree,
  })) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
  const commitSha = requireSha(
    commit.sha ?? "",
    "rolling branch commit SHA whose tree matches exact main",
  );
  if (commit.verification?.verified !== true) {
    throw new PostMergeDocsError(
      `GitHub did not verify the rolling branch commit whose tree matches exact main: ${commit.verification?.reason ?? "unknown reason"}`,
    );
  }
  return commitSha;
}

async function assertFinalCleanState(input: {
  repositoryName: string;
  sourceRepository: string;
  mainSha: string;
  mainTree: string;
  rangeStartTag: string;
  rangeStartSha: string;
  rollingHeadSha: string | null;
  request: GitHubRequest;
}): Promise<void> {
  const liveMain = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/main`,
  )) as GitRef;
  if (liveMain.object.sha !== input.mainSha) {
    throw new PostMergeDocsError("main changed before no-change readiness");
  }
  const range = latestReachableSemverTag(input.sourceRepository, input.mainSha);
  if (range.tag !== input.rangeStartTag || range.sha !== input.rangeStartSha) {
    throw new PostMergeDocsError("documentation range changed before no-change readiness");
  }
  const rollingRef = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/${ROLLING_BRANCH}`,
  )) as GitRef | null;
  if (
    (input.rollingHeadSha === null && rollingRef !== null) ||
    (input.rollingHeadSha !== null && rollingRef?.object.sha !== input.rollingHeadSha)
  ) {
    throw new PostMergeDocsError("rolling branch changed before no-change readiness");
  }
  const owner = input.repositoryName.split("/")[0];
  const openPulls = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/pulls?state=open&base=main&head=${encodeURIComponent(
      `${owner}:${ROLLING_BRANCH}`,
    )}&per_page=100`,
  )) as PullRequest[];
  if (!Array.isArray(openPulls) || openPulls.length !== 0) {
    throw new PostMergeDocsError("a rolling documentation PR remains open");
  }
  if (input.rollingHeadSha) {
    const commit = (await input.request(
      "GET",
      `/repos/${input.repositoryName}/git/commits/${input.rollingHeadSha}`,
    )) as { sha?: string; tree?: { sha?: string } };
    if (commit.sha !== input.rollingHeadSha || commit.tree?.sha !== input.mainTree) {
      throw new PostMergeDocsError("the retained rolling branch tree differs from exact main");
    }
  }
  const finalRollingRef = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/${ROLLING_BRANCH}`,
  )) as GitRef | null;
  const finalOpenPulls = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/pulls?state=open&base=main&head=${encodeURIComponent(
      `${owner}:${ROLLING_BRANCH}`,
    )}&per_page=100`,
  )) as PullRequest[];
  const finalMain = (await input.request(
    "GET",
    `/repos/${input.repositoryName}/git/ref/heads/main`,
  )) as GitRef;
  if (
    !Array.isArray(finalOpenPulls) ||
    finalOpenPulls.length !== 0 ||
    finalMain.object.sha !== input.mainSha ||
    (input.rollingHeadSha === null && finalRollingRef !== null) ||
    (input.rollingHeadSha !== null && finalRollingRef?.object.sha !== input.rollingHeadSha)
  ) {
    throw new PostMergeDocsError("documentation state changed during final readiness validation");
  }
}

async function requestWithRetry(
  request: GitHubRequest,
  method: "POST" | "PATCH",
  apiPath: string,
  body: unknown,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await request(method, apiPath, body);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function publishArtifact(input: {
  artifactDirectory: string;
  expectedRepository: string;
  expectedRangeStartSha: string;
  expectedRangeStartTag: string;
  expectedMainSha: string;
  sourceRepository: string;
  request: GitHubRequest;
  graphql: GraphqlRequest;
}): Promise<PublicationResult> {
  const artifact = validateArtifact({
    artifactDirectory: input.artifactDirectory,
    expectedRepository: input.expectedRepository,
    expectedRangeStartSha: input.expectedRangeStartSha,
    expectedRangeStartTag: input.expectedRangeStartTag,
    expectedMainSha: input.expectedMainSha,
  });
  assertRange(input.sourceRepository, artifact.result.rangeStartSha, artifact.result.mainSha);
  const live = await discoverState({
    repository: input.expectedRepository,
    mainSha: input.expectedMainSha,
    sourceRepository: input.sourceRepository,
    request: async (_method, apiPath) => input.request("GET", apiPath),
  });
  if (
    live.rangeStartTag !== artifact.result.rangeStartTag ||
    live.rangeStartSha !== artifact.result.rangeStartSha ||
    live.rollingHeadSha !== artifact.result.rollingHeadSha ||
    live.rollingPrNumber !== artifact.result.rollingPrNumber
  ) {
    throw new PostMergeDocsError(
      "live tag or rolling branch state changed after documentation review",
    );
  }
  const repository = (await input.request("GET", `/repos/${input.expectedRepository}`)) as {
    id?: number;
    node_id?: string;
  };
  if (!repository.node_id)
    throw new PostMergeDocsError("GitHub repository response has no node ID");
  const liveMain = (await input.request(
    "GET",
    `/repos/${input.expectedRepository}/git/ref/heads/main`,
  )) as GitRef;
  if (requireSha(liveMain.object?.sha ?? "", "live main SHA") !== artifact.result.mainSha) {
    throw new PostMergeDocsError(
      "main changed after documentation analysis; refusing stale publication",
    );
  }
  const previousSha = live.rollingHeadSha;
  const boundPull = live.rollingPrNumber
    ? ((await input.request(
        "GET",
        `/repos/${input.expectedRepository}/pulls/${live.rollingPrNumber}`,
      )) as PullRequest)
    : null;
  let existingPull: PullRequest | null = null;
  let pendingRetiredPull: PullRequest | null = null;
  let historicalPendingRetirement: HistoricalPendingRetirement | null = null;
  if (boundPull?.state === "open") {
    validateExistingPull(boundPull, input.expectedRepository);
    existingPull = boundPull;
  } else if (boundPull && previousSha) {
    const marker = parseRetirementPendingMarker(boundPull.body ?? "");
    if (!marker) {
      throw new PostMergeDocsError(
        "GitHub did not confirm the closed pending documentation retirement",
      );
    }
    validatePendingRetiredPull(boundPull, input.expectedRepository, previousSha, marker.mainSha);
    const pendingTree = validatePendingRetirementTree({
      sourceRepository: input.sourceRepository,
      pendingMainSha: marker.mainSha,
      rollingHeadSha: marker.headSha,
      currentMainSha: artifact.result.mainSha,
    });
    if (marker.mainSha === artifact.result.mainSha) {
      pendingRetiredPull = boundPull;
    } else {
      historicalPendingRetirement = {
        pull: boundPull,
        mainSha: marker.mainSha,
        headSha: marker.headSha,
        mainTreeSha: pendingTree.mainTreeSha,
      };
    }
  } else if (boundPull) {
    throw new PostMergeDocsError("a bound rolling PR has no rolling branch");
  }
  if (existingPull && existingPull.head.sha !== previousSha) {
    throw new PostMergeDocsError("rolling branch SHA differs from the open PR commit");
  }
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "nemoclaw-post-merge-docs-"));
  try {
    const applied = applyAndValidatePatch({
      artifact,
      sourceRepository: input.sourceRepository,
      destination: path.join(temporaryDirectory, "repository"),
    });
    const mainTree = requireSha(
      gitText(applied.repository, ["rev-parse", `${artifact.result.mainSha}^{tree}`]),
      "exact main tree",
    );
    if (historicalPendingRetirement) {
      await finalizeHistoricalPendingRetirement({
        pending: historicalPendingRetirement,
        repository: applied.repository,
        repositoryName: input.expectedRepository,
        request: input.request,
      });
    }
    if (applied.finalTree === mainTree && artifact.result.documentationPaths.length === 0) {
      let finalRollingHeadSha = previousSha;
      if (previousSha) {
        const previousTree = requireSha(
          gitText(applied.repository, ["rev-parse", `${previousSha}^{tree}`]),
          "rolling branch tree",
        );
        const cleanRollingSha = await prepareCleanRollingCommit({
          previousSha,
          previousTree,
          mainSha: artifact.result.mainSha,
          mainTree,
          repositoryName: input.expectedRepository,
          request: input.request,
        });
        const latestMain = (await input.request(
          "GET",
          `/repos/${input.expectedRepository}/git/ref/heads/main`,
        )) as GitRef;
        if (latestMain.object.sha !== artifact.result.mainSha) {
          throw new PostMergeDocsError(
            "main changed before publishing the rolling branch tree that matches exact main",
          );
        }
        if (existingPull) {
          const latestPull = (await input.request(
            "GET",
            `/repos/${input.expectedRepository}/pulls/${existingPull.number}`,
          )) as PullRequest;
          validateExistingPull(latestPull, input.expectedRepository);
          if (latestPull.head.sha !== previousSha) {
            throw new PostMergeDocsError("rolling PR changed before empty retirement");
          }
          const agentsEntry = inspectTreeEntry(applied.repository, applied.finalTree, "AGENTS.md");
          if (!agentsEntry?.sha) {
            throw new PostMergeDocsError("validated tree has no regular AGENTS.md blob");
          }
          const retiredBlock = retirementPendingManagedBody({
            result: artifact.result,
            commitSha: cleanRollingSha,
            agentsBlobSha: agentsEntry.sha,
          }).replace(
            MANAGED_END,
            `${retirementPendingMarker(artifact.result.mainSha, cleanRollingSha)}\n${MANAGED_END}`,
          );
          const retiredBody = replaceManagedBlock(latestPull.body ?? "", retiredBlock);
          const bodyResponse = (await requestWithRetry(
            input.request,
            "PATCH",
            `/repos/${input.expectedRepository}/pulls/${latestPull.number}`,
            { body: retiredBody },
          )) as PullRequest;
          validateExistingPull(bodyResponse, input.expectedRepository);
          if (bodyResponse.head.sha !== previousSha || bodyResponse.body !== retiredBody) {
            throw new PostMergeDocsError("GitHub did not confirm the empty retirement marker");
          }
        }
        if (cleanRollingSha !== previousSha) {
          await updateBranch({
            repositoryName: input.expectedRepository,
            repositoryId: repository.node_id,
            previousSha,
            commitSha: cleanRollingSha,
            graphql: input.graphql,
          });
          const cleanRef = (await input.request(
            "GET",
            `/repos/${input.expectedRepository}/git/ref/heads/${ROLLING_BRANCH}`,
          )) as GitRef;
          if (cleanRef.object.sha !== cleanRollingSha) {
            throw new PostMergeDocsError(
              "GitHub did not confirm that the rolling branch tree matches exact main",
            );
          }
        }
        finalRollingHeadSha = cleanRollingSha;
        if (existingPull || pendingRetiredPull) {
          let retired = pendingRetiredPull
            ? pendingRetiredPull
            : ((await input.request(
                "GET",
                `/repos/${input.expectedRepository}/pulls/${existingPull?.number}`,
              )) as PullRequest);
          if (retired.state === "open") {
            validateExistingPull(retired, input.expectedRepository);
            if (retired.head.sha !== cleanRollingSha) {
              throw new PostMergeDocsError(
                "rolling PR did not advance to the commit whose tree matches exact main",
              );
            }
            try {
              retired = (await requestWithRetry(
                input.request,
                "PATCH",
                `/repos/${input.expectedRepository}/pulls/${retired.number}`,
                { state: "closed" },
              )) as PullRequest;
            } catch (error) {
              retired = (await input.request(
                "GET",
                `/repos/${input.expectedRepository}/pulls/${retired.number}`,
              )) as PullRequest;
              try {
                validatePendingRetiredPull(
                  retired,
                  input.expectedRepository,
                  cleanRollingSha,
                  artifact.result.mainSha,
                );
              } catch {
                throw error;
              }
            }
          }
          validatePendingRetiredPull(
            retired,
            input.expectedRepository,
            cleanRollingSha,
            artifact.result.mainSha,
          );
          const agentsEntry = inspectTreeEntry(applied.repository, applied.finalTree, "AGENTS.md");
          if (!agentsEntry?.sha) {
            throw new PostMergeDocsError("validated tree has no regular AGENTS.md blob");
          }
          const finalBlock = retiredManagedBody({
            result: artifact.result,
            commitSha: cleanRollingSha,
            agentsBlobSha: agentsEntry.sha,
          }).replace(
            MANAGED_END,
            `${retiredEmptyMarker(artifact.result.mainSha, cleanRollingSha)}\n${MANAGED_END}`,
          );
          retired = await publishFinalRetiredBody({
            pull: retired,
            block: finalBlock,
            repository: input.expectedRepository,
            expectedHeadSha: cleanRollingSha,
            expectedMainSha: artifact.result.mainSha,
            request: input.request,
          });
        }
      }
      await assertFinalCleanState({
        repositoryName: input.expectedRepository,
        sourceRepository: input.sourceRepository,
        mainSha: artifact.result.mainSha,
        mainTree,
        rangeStartTag: artifact.result.rangeStartTag,
        rangeStartSha: artifact.result.rangeStartSha,
        rollingHeadSha: finalRollingHeadSha,
        request: input.request,
      });
      return { status: "no_changes", coveredSha: artifact.result.mainSha };
    }
    if (pendingRetiredPull) {
      throw new PostMergeDocsError(
        "closed pending retirement requires a reviewed candidate whose tree matches exact main",
      );
    }
    if (
      artifact.result.outcome === "no_changes" &&
      !existingPull &&
      (!previousSha || artifact.result.documentationPaths.length === 0)
    ) {
      throw new PostMergeDocsError(
        "no-change orphan recovery requires a reviewed documentation-only branch diff",
      );
    }
    if (previousSha) {
      const previousTree = requireSha(
        gitText(applied.repository, ["rev-parse", `${previousSha}^{tree}`]),
        "rolling branch tree",
      );
      const mainIsAncestor =
        spawnSync(
          "git",
          hardenedGitArgs(["merge-base", "--is-ancestor", artifact.result.mainSha, previousSha]),
          {
            cwd: applied.repository,
            env: HARDENED_GIT_ENV,
            stdio: "ignore",
          },
        ).status === 0;
      if (previousTree === applied.finalTree && mainIsAncestor && existingPull) {
        const agentsEntry = inspectTreeEntry(applied.repository, applied.finalTree, "AGENTS.md");
        if (!agentsEntry?.sha) {
          throw new PostMergeDocsError("validated tree has no regular AGENTS.md blob");
        }
        const latestPull = (await input.request(
          "GET",
          `/repos/${input.expectedRepository}/pulls/${existingPull.number}`,
        )) as PullRequest;
        validateExistingPull(latestPull, input.expectedRepository);
        if (latestPull.head.sha !== previousSha) {
          throw new PostMergeDocsError(
            "rolling PR changed before idempotent receipt reconciliation",
          );
        }
        const desiredBody = replaceManagedBlock(
          latestPull.body ?? "",
          managedBody({
            result: artifact.result,
            commitSha: previousSha,
            agentsBlobSha: agentsEntry.sha,
          }),
        );
        if (desiredBody !== latestPull.body) {
          const patched = (await requestWithRetry(
            input.request,
            "PATCH",
            `/repos/${input.expectedRepository}/pulls/${latestPull.number}`,
            { body: desiredBody },
          )) as PullRequest;
          validateExistingPull(patched, input.expectedRepository);
          if (patched.head.sha !== previousSha || patched.body !== desiredBody) {
            throw new PostMergeDocsError("GitHub did not reconcile the idempotent PR receipt");
          }
        }
        return {
          status: "pr_pending",
          coveredSha: artifact.result.mainSha,
          pullRequestNumber: existingPull.number,
          pullRequestUrl: existingPull.html_url,
        };
      }
    }
    const publicationPaths = changedPaths(
      applied.repository,
      artifact.result.mainSha,
      applied.finalTree,
    );
    if (publicationPaths.some((entry) => !isAllowedDocumentationPath(entry))) {
      throw new PostMergeDocsError("rolling PR tree changes a path outside docs/ or fern/");
    }
    for (const filePath of publicationPaths) {
      inspectTreeEntry(applied.repository, applied.finalTree, filePath);
    }
    const tree = await createGitHubTree({
      repository: applied.repository,
      repositoryName: input.expectedRepository,
      mainSha: artifact.result.mainSha,
      finalTree: applied.finalTree,
      paths: publicationPaths,
      request: input.request,
    });
    let parents = [artifact.result.mainSha];
    if (previousSha) {
      const mainBeforeRolling =
        spawnSync(
          "git",
          hardenedGitArgs(["merge-base", "--is-ancestor", artifact.result.mainSha, previousSha]),
          {
            cwd: applied.repository,
            env: HARDENED_GIT_ENV,
            stdio: "ignore",
          },
        ).status === 0;
      const rollingBeforeMain =
        spawnSync(
          "git",
          hardenedGitArgs(["merge-base", "--is-ancestor", previousSha, artifact.result.mainSha]),
          {
            cwd: applied.repository,
            env: HARDENED_GIT_ENV,
            stdio: "ignore",
          },
        ).status === 0;
      if (mainBeforeRolling) parents = [previousSha];
      else if (!rollingBeforeMain) parents = [previousSha, artifact.result.mainSha];
    }
    const commit = (await input.request("POST", `/repos/${input.expectedRepository}/git/commits`, {
      message: `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
      parents,
      tree,
    })) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
    const commitSha = requireSha(commit.sha ?? "", "created documentation commit SHA");
    if (commit.verification?.verified !== true) {
      throw new PostMergeDocsError(
        `GitHub did not verify the documentation commit: ${commit.verification?.reason ?? "unknown reason"}`,
      );
    }
    const agentsEntry = inspectTreeEntry(applied.repository, applied.finalTree, "AGENTS.md");
    if (!agentsEntry?.sha)
      throw new PostMergeDocsError("validated tree has no regular AGENTS.md blob");
    const block = managedBody({
      result: artifact.result,
      commitSha,
      agentsBlobSha: agentsEntry.sha,
    });
    let preparedBody = block;
    if (existingPull) {
      const latestPull = (await input.request(
        "GET",
        `/repos/${input.expectedRepository}/pulls/${existingPull.number}`,
      )) as PullRequest;
      validateExistingPull(latestPull, input.expectedRepository);
      if (latestPull.head.sha !== previousSha) {
        throw new PostMergeDocsError(
          "rolling PR changed before its future commit receipt was written",
        );
      }
      preparedBody = replaceManagedBlock(latestPull.body ?? "", block);
      const patched = (await requestWithRetry(
        input.request,
        "PATCH",
        `/repos/${input.expectedRepository}/pulls/${latestPull.number}`,
        { body: preparedBody },
      )) as PullRequest;
      validateExistingPull(patched, input.expectedRepository);
      if (patched.head.sha !== previousSha || patched.body !== preparedBody) {
        throw new PostMergeDocsError(
          "GitHub did not confirm the future documentation commit receipt",
        );
      }
    }
    const mainBeforeWrite = (await input.request(
      "GET",
      `/repos/${input.expectedRepository}/git/ref/heads/main`,
    )) as GitRef;
    if (mainBeforeWrite.object.sha !== artifact.result.mainSha) {
      throw new PostMergeDocsError("main changed before the documentation branch update");
    }
    if (previousSha) {
      try {
        await updateBranch({
          repositoryName: input.expectedRepository,
          repositoryId: repository.node_id,
          previousSha,
          commitSha,
          graphql: input.graphql,
        });
      } catch (error) {
        const reconciled = (await input.request(
          "GET",
          `/repos/${input.expectedRepository}/git/ref/heads/${ROLLING_BRANCH}`,
        )) as GitRef | null;
        if (reconciled?.object.sha !== commitSha) throw error;
      }
    } else {
      let createdRef: { ref?: string; object?: { sha?: string } };
      try {
        createdRef = (await requestWithRetry(
          input.request,
          "POST",
          `/repos/${input.expectedRepository}/git/refs`,
          { ref: `refs/heads/${ROLLING_BRANCH}`, sha: commitSha },
        )) as { ref?: string; object?: { sha?: string } };
      } catch (error) {
        const reconciled = (await input.request(
          "GET",
          `/repos/${input.expectedRepository}/git/ref/heads/${ROLLING_BRANCH}`,
        )) as { ref?: string; object?: { sha?: string } } | null;
        if (reconciled?.object?.sha !== commitSha) throw error;
        createdRef = { ref: `refs/heads/${ROLLING_BRANCH}`, object: { sha: commitSha } };
      }
      if (
        createdRef.ref !== `refs/heads/${ROLLING_BRANCH}` ||
        createdRef.object?.sha !== commitSha
      ) {
        throw new PostMergeDocsError("GitHub did not confirm the documentation branch creation");
      }
    }

    let pull: PullRequest;
    try {
      if (existingPull) {
        pull = (await input.request(
          "GET",
          `/repos/${input.expectedRepository}/pulls/${existingPull.number}`,
        )) as PullRequest;
      } else {
        pull = (await requestWithRetry(
          input.request,
          "POST",
          `/repos/${input.expectedRepository}/pulls`,
          {
            base: "main",
            body: preparedBody,
            draft: true,
            head: ROLLING_BRANCH,
            title: ROLLING_TITLE,
          },
        )) as PullRequest;
      }
    } catch (error) {
      const reconciled = (await input.request(
        "GET",
        `/repos/${input.expectedRepository}/pulls?state=open&base=main&head=${encodeURIComponent(
          `${input.expectedRepository.split("/")[0]}:${ROLLING_BRANCH}`,
        )}&per_page=100`,
      )) as PullRequest[];
      if (!Array.isArray(reconciled) || reconciled.length !== 1) throw error;
      pull = reconciled[0];
    }
    validateExistingPull(pull, input.expectedRepository);
    if (pull.head.sha !== commitSha || pull.base.ref !== "main" || pull.body !== preparedBody) {
      throw new PostMergeDocsError("GitHub returned a PR for a different documentation commit");
    }
    return {
      status: "pr_pending",
      coveredSha: artifact.result.mainSha,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url,
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function githubClient(token: string): { request: GitHubRequest; graphql: GraphqlRequest } {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const parse = async (response: Response): Promise<unknown> => {
    if (response.status === 404) return null;
    const body = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    if (!response.ok || body.errors?.length) {
      const detail =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || body.message;
      throw new PostMergeDocsError(
        `GitHub API request failed: ${detail || `HTTP ${response.status}`}`,
      );
    }
    return body.data ?? body;
  };
  return {
    request: async (method, apiPath, body) =>
      parse(
        await fetch(`https://api.github.com${apiPath}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
        }),
      ),
    graphql: async (query, variables) =>
      parse(
        await fetch("https://api.github.com/graphql", {
          body: JSON.stringify({ query, variables }),
          headers,
          method: "POST",
        }),
      ),
  };
}

function appendOutput(key: string, value: string | number): void {
  const output = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  const rendered = String(value);
  if (!/^[a-z_]+$/u.test(key) || /[\r\n]/u.test(rendered)) {
    throw new PostMergeDocsError("GitHub output contains unsupported characters");
  }
  fs.appendFileSync(output, `${key}=${rendered}\n`);
}

async function main(): Promise<void> {
  const repository = required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const mainSha = requireSha(required(process.env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA");
  const rangeStartSha = requireSha(
    required(process.env.RANGE_START_SHA, "RANGE_START_SHA"),
    "RANGE_START_SHA",
  );
  const client = githubClient(required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN"));
  const result = await publishArtifact({
    artifactDirectory: required(
      process.env.POST_MERGE_DOCS_ARTIFACT_DIR,
      "POST_MERGE_DOCS_ARTIFACT_DIR",
    ),
    expectedRepository: repository,
    expectedRangeStartSha: rangeStartSha,
    expectedRangeStartTag: required(process.env.RANGE_START_TAG, "RANGE_START_TAG"),
    expectedMainSha: mainSha,
    sourceRepository: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
    ...client,
  });
  appendOutput("status", result.status);
  appendOutput("covered_sha", result.coveredSha);
  if (result.pullRequestNumber) appendOutput("pr_number", result.pullRequestNumber);
  if (result.pullRequestUrl) appendOutput("pr_url", result.pullRequestUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
