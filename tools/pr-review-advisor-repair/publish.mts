#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi, githubGraphql } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  MAX_PATCH_BYTES,
  parseSelectionBundle,
  parseValidationReceipt,
  readBoundedJson,
  readBoundedRegularFile,
  RepairContractError,
  sanitizeDiagnostic,
  type SelectionBundle,
  type ValidationReceipt,
} from "./contract.mts";

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
  maintainer_can_modify?: unknown;
  head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
  base?: {
    sha?: unknown;
    ref?: unknown;
    repo?: { full_name?: unknown; node_id?: unknown };
  };
};

type TreeEntry = {
  path: string;
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

function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
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
  return execFileSync("git", args, {
    cwd: repository,
    env,
    encoding: buffer ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_PATCH_BYTES + 1024 * 1024,
  });
}

export function assertPublicationPullRequest(
  selection: SelectionBundle,
  pull: PullRequest,
): { repositoryId: string } {
  if (
    pull.number !== selection.input.prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.maintainer_can_modify !== true ||
    pull.head?.sha !== selection.input.sourceHeadSha ||
    pull.head?.ref !== selection.input.pullRequest.headRef ||
    pull.head?.repo?.full_name !== CANONICAL_REPOSITORY ||
    pull.base?.sha !== selection.input.baseSha ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError(
      "live pull request identity or ownership changed before publication",
    );
  }
  const repositoryId = pull.base.repo.node_id;
  if (typeof repositoryId !== "string" || !repositoryId) {
    throw new RepairContractError("canonical repository node identity is missing");
  }
  return { repositoryId };
}

export function reconstructValidatedTree(input: {
  sourceCheckout: string;
  selection: SelectionBundle;
  patchFile: string;
  expectedTree: string;
  stagingDirectory: string;
}): { repository: string; treeSha: string } {
  const home = path.join(input.stagingDirectory, "home");
  const repository = path.join(input.stagingDirectory, "repo");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = gitEnvironment(home);
  git(
    input.stagingDirectory,
    ["clone", "--no-local", "--no-hardlinks", "--no-checkout", input.sourceCheckout, repository],
    env,
  );
  git(repository, ["checkout", "--detach", input.selection.input.sourceHeadSha], env);
  git(
    repository,
    ["apply", "--check", "--index", "--binary", "--whitespace=error-all", input.patchFile],
    env,
  );
  git(repository, ["apply", "--index", "--binary", "--whitespace=error-all", input.patchFile], env);
  git(repository, ["diff", "--cached", "--check", "HEAD", "--"], env);
  const treeSha = String(git(repository, ["write-tree"], env)).trim();
  if (treeSha !== input.expectedTree) {
    throw new RepairContractError("publisher reconstructed a different candidate tree");
  }
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
      entries.push({ path: changedPath, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const line = String(
      git(repository, ["ls-tree", candidateTreeSha, "--", changedPath], env),
    ).trim();
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/u.exec(line);
    if (!match || match[2] !== changedPath) {
      throw new RepairContractError("publisher candidate contains an unsupported Git object");
    }
    entries.push({ path: changedPath, mode: "100644", type: "blob", sha: match[1] });
  }
  return entries;
}

async function createGitHubTree(input: {
  repository: string;
  sourceHeadSha: string;
  candidateTreeSha: string;
  token: string;
  request: GitHubRequest;
}): Promise<string> {
  const env = gitEnvironment(path.join(input.repository, ".publisher-home"));
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
      body: { base_tree: input.sourceHeadSha, tree: entries },
    },
  );
  if (created.sha !== input.candidateTreeSha) {
    throw new RepairContractError("GitHub returned a tree that differs from trusted validation");
  }
  return input.candidateTreeSha;
}

export async function waitForVerifiedCommit(
  commitSha: string,
  token: string,
  request: GitHubRequest = githubApi,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let attempt = 1; attempt <= VERIFIED_RETRY_ATTEMPTS; attempt += 1) {
    const commit = await request<{ verification?: { verified?: unknown; reason?: unknown } }>(
      `repos/${CANONICAL_REPOSITORY}/git/commits/${commitSha}`,
      token,
    );
    if (commit.verification?.verified === true) return;
    if (attempt < VERIFIED_RETRY_ATTEMPTS) await wait(VERIFIED_RETRY_DELAY_MS);
  }
  throw new RepairContractError("GitHub did not verify the repair commit before publication");
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

const GENERATED_HEAD_WORKFLOWS = [
  "pr.yaml",
  "commit-lint.yaml",
  "dco-check.yaml",
  "installer-hash-check.yaml",
  "code-scanning.yaml",
] as const;

async function assertValidationWorkflowsActive(
  token: string,
  request: GitHubRequest,
): Promise<void> {
  for (const workflow of [...GENERATED_HEAD_WORKFLOWS, "pr-review-advisor.yaml"]) {
    const metadata = await request<{ state?: unknown; path?: unknown }>(
      `repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}`,
      token,
    );
    if (metadata.state !== "active" || metadata.path !== `.github/workflows/${workflow}`) {
      throw new RepairContractError(`generated-head workflow is not active: ${workflow}`);
    }
  }
}

export async function dispatchGeneratedHeadValidation(
  selection: SelectionBundle,
  commitSha: string,
  token: string,
  request: GitHubRequest = githubApi,
): Promise<string[]> {
  const common = {
    pr_number: String(selection.input.prNumber),
    source_head_sha: commitSha,
    base_sha: selection.input.baseSha,
    repair_attempt_key: selection.attemptKey,
  };
  for (const workflow of GENERATED_HEAD_WORKFLOWS) {
    await request(`repos/${CANONICAL_REPOSITORY}/actions/workflows/${workflow}/dispatches`, token, {
      method: "POST",
      body: { ref: selection.input.pullRequest.headRef, inputs: common },
    });
  }
  await request(
    `repos/${CANONICAL_REPOSITORY}/actions/workflows/pr-review-advisor.yaml/dispatches`,
    token,
    {
      method: "POST",
      body: {
        ref: selection.input.pullRequest.headRef,
        inputs: {
          target_repo: CANONICAL_REPOSITORY,
          target_pr: String(selection.input.prNumber),
          target_base: "main",
          source_head_sha: commitSha,
          base_sha: selection.input.baseSha,
          repair_attempt_key: selection.attemptKey,
        },
      },
    },
  );
  return [...GENERATED_HEAD_WORKFLOWS, "pr-review-advisor.yaml"];
}

export async function publishValidatedRepair(input: {
  sourceCheckout: string;
  selection: SelectionBundle;
  receipt: ValidationReceipt;
  patchFile: string;
  stagingDirectory: string;
  token: string;
  request?: GitHubRequest;
  graphql?: GraphqlRequest;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<PublicationReceipt> {
  const request = input.request ?? githubApi;
  const graphql =
    input.graphql ?? ((query, variables) => githubGraphql(input.token, query, variables));
  const pull = await request<PullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${input.selection.input.prNumber}`,
    input.token,
  );
  const { repositoryId } = assertPublicationPullRequest(input.selection, pull);
  await assertValidationWorkflowsActive(input.token, request);
  const reconstructed = reconstructValidatedTree({
    sourceCheckout: input.sourceCheckout,
    selection: input.selection,
    patchFile: input.patchFile,
    expectedTree: input.receipt.candidateTreeSha,
    stagingDirectory: input.stagingDirectory,
  });
  await createGitHubTree({
    repository: reconstructed.repository,
    sourceHeadSha: input.selection.input.sourceHeadSha,
    candidateTreeSha: reconstructed.treeSha,
    token: input.token,
    request,
  });
  const commit = await request<{ sha?: unknown }>(
    `repos/${CANONICAL_REPOSITORY}/git/commits`,
    input.token,
    {
      method: "POST",
      body: {
        message: `fix(advisor): apply validated review repair\n\nAdvisor-Repair-Attempt: ${input.selection.attemptKey}`,
        tree: reconstructed.treeSha,
        parents: [input.selection.input.sourceHeadSha],
      },
    },
  );
  const commitSha = fullSha(commit.sha, "created repair commit SHA");
  await waitForVerifiedCommit(commitSha, input.token, request, input.wait);
  const current = await request<PullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${input.selection.input.prNumber}`,
    input.token,
  );
  assertPublicationPullRequest(input.selection, current);
  await atomicUpdate({
    repositoryId,
    headRef: input.selection.input.pullRequest.headRef,
    beforeOid: input.selection.input.sourceHeadSha,
    afterOid: commitSha,
    graphql,
  });
  const dispatchedWorkflows = await dispatchGeneratedHeadValidation(
    input.selection,
    commitSha,
    input.token,
    request,
  );
  return {
    version: 1,
    attemptKey: input.selection.attemptKey,
    sourceHeadSha: input.selection.input.sourceHeadSha,
    candidateTreeSha: input.receipt.candidateTreeSha,
    commitSha,
    headRef: input.selection.input.pullRequest.headRef,
    dispatchedWorkflows,
  };
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const selection = parseSelectionBundle(
    readBoundedJson(required(env, "SELECTION_FILE"), 1024 * 1024),
  );
  const patchFile = required(env, "VALIDATED_PATCH_FILE");
  const patch = readBoundedRegularFile(patchFile, MAX_PATCH_BYTES);
  const receipt = parseValidationReceipt(
    readBoundedJson(required(env, "VALIDATION_RECEIPT_FILE"), 1024 * 1024),
    selection,
    patch,
  );
  const stagingRoot = required(env, "PUBLISH_STAGING_ROOT");
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingDirectory = fs.mkdtempSync(path.join(stagingRoot, "candidate-"));
  try {
    const publication = await publishValidatedRepair({
      sourceCheckout: required(env, "SOURCE_CHECKOUT"),
      selection,
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
