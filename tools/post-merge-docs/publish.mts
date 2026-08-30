#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { allowedDocumentationPath, nextPatchReleaseTag, readBoundedFile } from "./contract.mts";

const PREFIX = "automation/post-merge-docs-";
const SIGN_OFF =
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const SHA = /^[0-9a-f]{40}$/u;
type Method = "GET" | "POST";
export type Request = (method: Method, apiPath: string, body?: unknown) => Promise<unknown>;
type Repo = { full_name: string; node_id?: string };
type Pull = {
  body: string | null;
  base: { ref: string; repo: Repo };
  draft: boolean;
  head: { ref: string; repo: Repo | null; sha: string };
  html_url: string;
  number: number;
  state: string;
  title: string;
};
type Change = { mode: "100644"; path: string; sha: string | null; type: "blob" };
type Commit = {
  author?: { email?: string };
  message?: string;
  parents?: Array<{ sha?: string }>;
  sha?: string;
  tree?: { sha?: string };
  verification?: { verified?: boolean };
};
function fail(message: string): never {
  throw new Error(message);
}
function failureDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return (
    message
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 512) || "unknown error"
  );
}
function environment(name: string): string {
  return process.env[name] || fail(`${name} is required`);
}
function sha(value: string, name: string): string {
  return SHA.test(value) ? value : fail(`${name} must be a lowercase 40-character Git SHA`);
}
type Approval = {
  patch: Buffer;
  rangeStartTag: string;
  targetReleaseTag: string;
};
function approvedPatch(directory: string, repository: string, mainSha: string): Approval {
  const patch = readBoundedFile(path.join(directory, "docs.patch"), 5_242_880, true);
  let value: unknown;
  try {
    value = JSON.parse(
      readBoundedFile(path.join(directory, "review.json"), 8_192).toString("utf8"),
    );
  } catch {
    fail("review.json must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("review is invalid");
  const review = value as Record<string, unknown>;
  if (
    Object.keys(review).sort().join() !==
      "mainSha,outcome,patchSha256,rangeStartTag,repository,targetReleaseTag,version" ||
    review.version !== 2 ||
    review.repository !== repository ||
    review.mainSha !== mainSha ||
    review.patchSha256 !== createHash("sha256").update(patch).digest("hex") ||
    review.outcome !== "approved" ||
    typeof review.rangeStartTag !== "string" ||
    typeof review.targetReleaseTag !== "string" ||
    nextPatchReleaseTag(
      review.rangeStartTag,
      "review range start tag cannot produce a release target",
    ) !== review.targetReleaseTag
  )
    fail("review does not approve the exact patch and release target for this main commit");
  return {
    patch,
    rangeStartTag: review.rangeStartTag,
    targetReleaseTag: review.targetReleaseTag,
  };
}
const gitEnv: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
};
function git(repository: string, args: readonly string[], buffer = false): string | Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      ...args,
    ],
    {
      cwd: repository,
      encoding: buffer ? undefined : "utf8",
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0)
    fail(`Git ${args[0] ?? "command"} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}
function prepare(source: string, destination: string, mainSha: string, patch: Buffer) {
  git(source, ["clone", "--no-hardlinks", "--no-checkout", source, destination]);
  git(destination, ["checkout", "--detach", mainSha]);
  const patchPath = path.join(path.dirname(destination), "docs.patch");
  fs.writeFileSync(patchPath, patch, { flag: "wx", mode: 0o600 });
  if (patch.length) git(destination, ["apply", "--index", "--binary", patchPath]);
  const finalTree = sha(String(git(destination, ["write-tree"])).trim(), "final tree");
  const diff = git(
    destination,
    ["diff", "--name-status", "--no-renames", "-z", mainSha, finalTree],
    true,
  ) as Buffer;
  const fields = diff.toString().split("\0").filter(Boolean);
  if (fields.length % 2 || fields.length > 400) fail("patch contains an invalid changed-path list");
  const changes: Change[] = [];
  let total = 0;
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (!/^[ADM]$/u.test(status) || !allowedDocumentationPath(file))
      fail(`patch changes unsupported path: ${file}`);
    const tree = status === "D" ? mainSha : finalTree;
    const entry = String(git(destination, ["ls-tree", tree, "--", file])).trim();
    const match = /^100644 blob ([0-9a-f]{40})\t/u.exec(entry);
    if (!match) fail(`patch changes a non-regular file: ${file}`);
    const size = status === "D" ? 0 : Number(git(destination, ["cat-file", "-s", match[1]!]));
    total += size;
    if (!Number.isSafeInteger(size) || size > 1_048_576 || total > 5_242_880)
      fail("documentation files exceed publication limits");
    const objectSha = status === "D" ? null : match[1]!;
    changes.push({ mode: "100644", path: file, sha: objectSha, type: "blob" });
  }
  return { changes, finalTree, repository: destination };
}

function checkedPull(
  pull: Pull,
  repository: string,
  branch?: string,
  body?: string,
  title?: string,
): Pull {
  if (
    pull.state !== "open" ||
    typeof pull.draft !== "boolean" ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.base.ref !== "main" ||
    pull.base.repo.full_name !== repository ||
    typeof pull.base.repo.node_id !== "string" ||
    !pull.base.repo.node_id ||
    pull.base.repo.node_id.length > 256 ||
    pull.head.repo?.full_name !== repository ||
    !SHA.test(pull.head.sha) ||
    (branch !== undefined && pull.head.ref !== branch) ||
    (body !== undefined && pull.body !== body) ||
    (title !== undefined && pull.title !== title) ||
    typeof pull.title !== "string" ||
    pull.html_url !== `https://github.com/${repository}/pull/${pull.number}`
  )
    fail("GitHub returned an invalid managed documentation PR");
  return pull;
}
async function managed(repository: string, request: Request): Promise<Pull[]> {
  const found: Pull[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = `/repos/${repository}/pulls?state=open&base=main&per_page=100&page=${page}`;
    const pulls = (await request("GET", url)) as Pull[];
    if (!Array.isArray(pulls)) fail("GitHub returned an invalid pull request list");
    for (const pull of pulls) {
      if (
        /^automation\/post-merge-docs-[0-9a-f]{12}$/u.test(pull.head?.ref ?? "") &&
        pull.head.repo?.full_name === repository
      )
        found.push(checkedPull(pull, repository));
    }
    if (pulls.length < 100) return found;
  }
  return fail("GitHub pull request pagination exceeded 100 pages");
}
async function checkpoint(repo: string, main: string, request: Request): Promise<Pull | undefined> {
  const ref = (await request("GET", `/repos/${repo}/git/ref/heads/main`)) as {
    object?: { sha?: string };
  };
  if (ref?.object?.sha !== main) fail("main changed after documentation review");
  const pulls = await managed(repo, request);
  if (pulls.length > 1) fail("multiple managed documentation PRs are open");
  return pulls[0];
}
function samePull(left: Pull | undefined, right: Pull | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.number === right.number &&
        left.body === right.body &&
        left.draft === right.draft &&
        left.head.ref === right.head.ref &&
        left.head.sha === right.head.sha &&
        left.title === right.title;
}
function requireSamePull(expected: Pull | undefined, observed: Pull | undefined): void {
  if (!samePull(expected, observed)) fail("managed documentation PR changed during publication");
}
function pullTitle(target: string): string {
  return `docs: prepare ${target} documentation`;
}
function managedBranchIdentity(branch: string, commitSha: string): string {
  return `managed documentation branch ${branch} at ${commitSha}`;
}
function orphanRecoveryUrl(repository: string): string {
  return `https://github.com/${repository}/blob/main/docs/AUTOMATION.md#recover-an-orphaned-managed-branch`;
}
function pullBody(repository: string, rangeStart: string, target: string): string {
  return `## Release target

This cumulative draft prepares documentation for \`${target}\`.
It covers merged changes after \`${rangeStart}\` through the reviewed \`main\` commit recorded as a parent of the latest workflow-created commit.
The workflow selects \`${target}\` by incrementing the patch component of \`${rangeStart}\`.

## Managed state

The workflow owns this branch while the PR is a draft. Ready-for-review status transfers branch ownership to maintainers, and later workflow runs leave the PR unchanged.

Follow [Post-Merge Documentation Catch-Up](https://github.com/${repository}/blob/main/docs/AUTOMATION.md#post-merge-documentation-catch-up) for development, recovery, validation, and release-cutoff routing.

## Verification

- An independent documentation writer approved each exact cumulative patch.
- A maintainer must inspect and approve any approval-required workflow runs.

${SIGN_OFF}`;
}
function legacyPullBody(mainSha: string): string {
  return `## Summary

Updates documentation for merged changes through \`${mainSha}\`.

## Verification

- An independent documentation writer approved the exact patch.
- Required PR checks must run \`npm run docs\` before merge.
- A maintainer must inspect and approve any approval-required workflow runs.

${SIGN_OFF}`;
}
async function legacyCoverageSha(
  repository: string,
  commit: Commit,
  request: Request,
): Promise<string | undefined> {
  const firstParent = commit.parents?.[0]?.sha;
  if (!firstParent) return undefined;
  if (commit.parents?.length === 1) return firstParent;
  if (commit.parents?.length !== 2) return undefined;
  const previous = await managedCommit(repository, firstParent, request);
  return previous.parents?.length === 1 ? previous.parents[0]?.sha : undefined;
}
async function requireCurrentPullMetadata(
  pull: Pull,
  commit: Commit,
  repository: string,
  rangeStart: string,
  target: string,
  request: Request,
): Promise<void> {
  if (pull.title === pullTitle(target) && pull.body === pullBody(repository, rangeStart, target))
    return;
  const coverageSha = await legacyCoverageSha(repository, commit, request);
  if (
    coverageSha &&
    pull.title === "docs: catch up after merged changes" &&
    pull.body === legacyPullBody(coverageSha)
  )
    fail(
      `managed documentation PR ${pull.html_url} uses previous workflow metadata; close this legacy draft so a later qualifying push can create a current workflow-owned draft, or mark the PR ready for review to transfer ownership`,
    );
  return fail(
    `managed documentation PR ${pull.html_url} title or body no longer matches the workflow-owned release target; restore the previous workflow-authored title and body to resume updates on the next qualifying push, or mark the PR ready for review to transfer ownership`,
  );
}
async function managedCommit(
  repository: string,
  commitSha: string,
  request: Request,
): Promise<Commit> {
  const commit = (await request("GET", `/repos/${repository}/git/commits/${commitSha}`)) as Commit;
  if (
    commit.sha !== commitSha ||
    !SHA.test(commit.tree?.sha ?? "") ||
    !Array.isArray(commit.parents) ||
    !commit.parents.length ||
    commit.parents.length > 2 ||
    commit.parents.some((parent) => !SHA.test(parent.sha ?? "")) ||
    commit.message !== `docs: catch up after main\n\n${SIGN_OFF}` ||
    commit.author?.email !== "41898282+github-actions[bot]@users.noreply.github.com" ||
    !commit.verification?.verified
  )
    fail("managed documentation branch contains a commit not created by the workflow");
  return commit;
}
async function recoverableOrphan(
  repository: string,
  mainSha: string,
  finalTree: string,
  ref: { object?: { sha?: string } } | null,
  request: Request,
): Promise<string | undefined> {
  if (ref === null) return undefined;
  const commitSha = sha(ref.object?.sha ?? "", "existing documentation branch SHA");
  let commit: Commit;
  try {
    commit = await managedCommit(repository, commitSha, request);
  } catch {
    return fail("an unmanaged documentation branch already exists for this main commit");
  }
  if (
    commit.parents?.length !== 1 ||
    commit.parents[0]?.sha !== mainSha ||
    commit.tree?.sha !== finalTree
  )
    fail("an unmanaged documentation branch already exists for this main commit");
  return commitSha;
}
async function createCommit(input: {
  changes: Change[];
  finalTree: string;
  mainSha: string;
  preparedRepository: string;
  previousSha?: string;
  repository: string;
  request: Request;
}): Promise<string> {
  for (const entry of input.changes) {
    if (!entry.sha) continue;
    const content = git(input.preparedRepository, ["cat-file", "blob", entry.sha], true) as Buffer;
    const blob = (await input.request("POST", `/repos/${input.repository}/git/blobs`, {
      content: content.toString("base64"),
      encoding: "base64",
    })) as { sha?: string };
    if (blob.sha !== entry.sha) fail(`GitHub returned an unexpected blob for ${entry.path}`);
  }
  const base = String(
    git(input.preparedRepository, ["rev-parse", `${input.mainSha}^{tree}`]),
  ).trim();
  const tree = (await input.request("POST", `/repos/${input.repository}/git/trees`, {
    base_tree: base,
    tree: input.changes,
  })) as { sha?: string };
  if (tree.sha !== input.finalTree) fail("GitHub returned a tree different from the reviewed tree");
  const parents = input.previousSha ? [input.previousSha, input.mainSha] : [input.mainSha];
  const commit = (await input.request("POST", `/repos/${input.repository}/git/commits`, {
    message: `docs: catch up after main\n\n${SIGN_OFF}`,
    parents,
    tree: input.finalTree,
  })) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
  const commitSha = sha(commit.sha ?? "", "created commit SHA");
  if (!commit.verification?.verified)
    fail(
      `GitHub did not verify the documentation commit: ${commit.verification?.reason ?? "unknown reason"}`,
    );
  return commitSha;
}
async function updateRef(
  branch: string,
  beforeSha: string,
  commitSha: string,
  repositoryId: string,
  request: Request,
): Promise<void> {
  const clientMutationId = commitSha;
  const mutation = `
    mutation UpdatePostMergeDocumentationRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) {
        clientMutationId
      }
    }
  `;
  const result = (await request("POST", "/graphql", {
    query: mutation,
    variables: {
      input: {
        clientMutationId,
        refUpdates: [
          {
            afterOid: commitSha,
            beforeOid: beforeSha,
            force: false,
            name: `refs/heads/${branch}`,
          },
        ],
        repositoryId,
      },
    },
  })) as { updateRefs?: { clientMutationId?: string } };
  if (result.updateRefs?.clientMutationId !== clientMutationId)
    fail("GitHub did not confirm the conditional documentation branch update");
}
async function createPull(input: {
  body: string;
  branch: string;
  commitSha: string;
  repository: string;
  request: Request;
  title: string;
}): Promise<Pull> {
  const refPath = `/repos/${input.repository}/git/ref/heads/${input.branch}`;
  let pull: Pull;
  try {
    pull = (await input.request("POST", `/repos/${input.repository}/pulls`, {
      base: "main",
      body: input.body,
      draft: true,
      head: input.branch,
      title: input.title,
    })) as Pull;
  } catch (error) {
    const reconciled = await managed(input.repository, input.request);
    const matching = reconciled.filter((candidate) => candidate.head.ref === input.branch);
    if (matching.length !== 1 || reconciled.length !== 1) {
      const orphaned = (await input.request("GET", refPath)) as {
        object?: { sha?: string };
      } | null;
      if (!matching.length && orphaned?.object?.sha === input.commitSha)
        fail(
          `${managedBranchIdentity(input.branch, input.commitSha)} remains without a draft PR; PR creation failed: ${failureDiagnostic(error)}; follow ${orphanRecoveryUrl(input.repository)}`,
        );
      throw error;
    }
    pull = matching[0]!;
  }
  checkedPull(pull, input.repository, input.branch, input.body, input.title);
  if (!pull.draft) fail("GitHub did not create a draft documentation PR");
  if (pull.head.sha !== input.commitSha)
    fail("documentation PR does not point to the verified commit");
  return pull;
}

export async function publishDocumentation(input: {
  artifactDirectory: string;
  expectedMainSha: string;
  expectedRepository: string;
  request: Request;
  sourceRepository: string;
}): Promise<void> {
  const { expectedRepository: repository, request } = input;
  const mainSha = sha(input.expectedMainSha, "GITHUB_SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail("GITHUB_REPOSITORY is invalid");
  const approval = approvedPatch(input.artifactDirectory, repository, mainSha);
  const { patch, rangeStartTag, targetReleaseTag: target } = approval;
  const body = pullBody(repository, rangeStartTag, target);
  const title = pullTitle(target);
  const active = await checkpoint(repository, mainSha, request);
  if (active && !active.draft) return;
  const temporary = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-docs-publish-"));
  try {
    const destination = path.join(temporary, "repository");
    const prepared = prepare(input.sourceRepository, destination, mainSha, patch);
    requireSamePull(active, await checkpoint(repository, mainSha, request));
    if (!active && !prepared.changes.length) return;

    const branch = active?.head.ref ?? `${PREFIX}${mainSha.slice(0, 12)}`;
    const refPath = `/repos/${repository}/git/ref/heads/${branch}`;
    const ref = (await request("GET", refPath)) as { object?: { sha?: string } } | null;
    const orphanSha = active
      ? undefined
      : await recoverableOrphan(repository, mainSha, prepared.finalTree, ref, request);
    if (active) {
      if (ref?.object?.sha !== active.head.sha)
        fail("managed documentation PR and branch point to different commits");
      const current = await managedCommit(repository, active.head.sha, request);
      await requireCurrentPullMetadata(active, current, repository, rangeStartTag, target, request);
      if (!prepared.changes.length || current.tree?.sha === prepared.finalTree) {
        fail(`Documentation remains pending in ${active.html_url}`);
      }
    } else if (orphanSha) {
      requireSamePull(undefined, await checkpoint(repository, mainSha, request));
      const pull = await createPull({
        body,
        branch,
        commitSha: orphanSha,
        repository,
        request,
        title,
      });
      fail(`Documentation remains pending in ${pull.html_url}`);
    }

    const commitSha = await createCommit({
      changes: prepared.changes,
      finalTree: prepared.finalTree,
      mainSha,
      preparedRepository: prepared.repository,
      ...(active ? { previousSha: active.head.sha } : {}),
      repository,
      request,
    });
    requireSamePull(active, await checkpoint(repository, mainSha, request));

    if (active) {
      try {
        await updateRef(branch, active.head.sha, commitSha, active.base.repo.node_id!, request);
      } catch (error) {
        const reconciled = (await request("GET", refPath)) as {
          object?: { sha?: string };
        } | null;
        if (reconciled?.object?.sha !== commitSha) throw error;
      }
      fail(`Documentation remains pending in ${active.html_url}`);
    }

    try {
      const created = (await request("POST", `/repos/${repository}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commitSha,
      })) as { object?: { sha?: string }; ref?: string };
      if (created.ref !== `refs/heads/${branch}` || created.object?.sha !== commitSha)
        fail("GitHub did not confirm documentation branch creation");
    } catch (error) {
      const reconciled = (await request("GET", refPath)) as { object?: { sha?: string } } | null;
      if (reconciled?.object?.sha !== commitSha) throw error;
    }

    console.error(
      `${managedBranchIdentity(branch, commitSha)} was created; if publication stops before draft PR creation, follow ${orphanRecoveryUrl(repository)}`,
    );
    requireSamePull(undefined, await checkpoint(repository, mainSha, request));
    const pull = await createPull({ body, branch, commitSha, repository, request, title });
    fail(`Documentation remains pending in ${pull.html_url}`);
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}
function client(token: string): Request {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return async (method, apiPath, body) => {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers,
      method,
      signal: AbortSignal.timeout(30_000),
    });
    if (method === "GET" && response.status === 404) return null;
    const value = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: string }>;
      message?: string;
    };
    const graphqlError = value.errors?.find((error) => typeof error.message === "string")?.message;
    if (!response.ok || (apiPath === "/graphql" && value.errors?.length))
      fail(
        `GitHub API request failed: ${graphqlError ?? value.message ?? `HTTP ${response.status}`}`,
      );
    return apiPath === "/graphql" ? value.data : value;
  };
}
async function main(): Promise<void> {
  await publishDocumentation({
    artifactDirectory: environment("POST_MERGE_DOCS_ARTIFACT_DIR"),
    expectedMainSha: environment("GITHUB_SHA"),
    expectedRepository: environment("GITHUB_REPOSITORY"),
    request: client(environment("GITHUB_TOKEN")),
    sourceRepository: environment("TRUSTED_CHECKOUT"),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
