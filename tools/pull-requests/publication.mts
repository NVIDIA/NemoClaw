// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

export type GitHubRequest = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export type GraphqlRequest = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

type GitTreeEntry = {
  mode: string;
  path: string;
  sha: string | null;
  type: "blob" | "commit";
};

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value))
    throw new Error(`${label} is not a full Git SHA`);
  return value;
}

function gitBuffer(repository: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
}

function changedPathStatuses(
  repository: string,
  fromTree: string,
  toTree: string,
): Array<{ path: string; status: string }> {
  const fields = gitBuffer(repository, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    fromTree,
    toTree,
  ])
    .toString("utf8")
    .split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Git returned an invalid changed-path list");
  const results: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = fields[index + 1];
    if (!status || !filePath || !/^[ADMT]$/u.test(status))
      throw new Error(`Git returned an unsupported tree change status: ${status}`);
    results.push({ path: filePath, status });
  }
  return results;
}

function optionalTreeEntry(
  repository: string,
  tree: string,
  filePath: string,
): GitTreeEntry | null {
  const output = gitBuffer(repository, ["ls-tree", "-z", tree, "--", filePath]).toString("utf8");
  if (!output) return null;
  const separator = output.indexOf("\t");
  if (separator < 0) throw new Error(`Git tree does not contain ${filePath}`);
  const [mode, type, sha] = output.slice(0, separator).split(" ");
  if (!mode || (type !== "blob" && type !== "commit") || !sha || !/^[0-9a-f]{40}$/u.test(sha))
    throw new Error(`Git returned an invalid tree entry for ${filePath}`);
  return { mode, path: filePath, sha, type };
}

function treeEntry(repository: string, tree: string, filePath: string): GitTreeEntry {
  const entry = optionalTreeEntry(repository, tree, filePath);
  if (!entry) throw new Error(`Git tree does not contain ${filePath}`);
  return entry;
}

function parentContainsBlob(repository: string, parent: string, entry: GitTreeEntry): boolean {
  const parentEntry = optionalTreeEntry(repository, parent, entry.path);
  return parentEntry?.type === "blob" && parentEntry.sha === entry.sha;
}

export async function createGitHubTree(input: {
  baseSha: string;
  finalTree: string;
  headSha: string;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
}): Promise<string> {
  const entries: GitTreeEntry[] = [];
  for (const change of changedPathStatuses(input.repository, input.baseSha, input.finalTree)) {
    const sourceTree = change.status === "D" ? input.baseSha : input.finalTree;
    const entry = treeEntry(input.repository, sourceTree, change.path);
    if (change.status === "D") {
      entries.push({ ...entry, sha: null });
      continue;
    }
    if (
      entry.type === "blob" &&
      !parentContainsBlob(input.repository, input.headSha, entry) &&
      !parentContainsBlob(input.repository, input.baseSha, entry)
    ) {
      const content = gitBuffer(input.repository, ["cat-file", "blob", entry.sha ?? ""]);
      const created = (await input.request("POST", `/repos/${input.repositoryName}/git/blobs`, {
        content: content.toString("base64"),
        encoding: "base64",
      })) as { sha?: string };
      if (created.sha !== entry.sha)
        throw new Error(`GitHub returned an unexpected blob SHA for ${entry.path}`);
    }
    entries.push(entry);
  }
  const created = (await input.request("POST", `/repos/${input.repositoryName}/git/trees`, {
    base_tree: input.baseSha,
    tree: entries,
  })) as { sha?: string };
  if (created.sha !== input.finalTree)
    throw new Error("GitHub returned a tree that differs from the validated tree");
  return input.finalTree;
}

export async function createVerifiedCommit(input: {
  finalTree: string;
  headSha: string;
  message: string;
  repository: string;
  repositoryName: string;
  request: GitHubRequest;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<string> {
  const tree = await createGitHubTree({
    baseSha: input.headSha,
    finalTree: input.finalTree,
    headSha: input.headSha,
    repository: input.repository,
    repositoryName: input.repositoryName,
    request: input.request,
  });
  const created = (await input.request("POST", `/repos/${input.repositoryName}/git/commits`, {
    message: input.message,
    parents: [input.headSha],
    tree,
  })) as { sha?: string };
  const commitSha = fullSha(created.sha, "created commit SHA");
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let reason = "verification timed out";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const commit = (await input.request(
      "GET",
      `/repos/${input.repositoryName}/git/commits/${commitSha}`,
    )) as { sha?: string; verification?: { reason?: string; verified?: boolean } };
    if (commit.sha !== commitSha) throw new Error("GitHub returned a different commit");
    if (commit.verification?.verified) return commitSha;
    reason = commit.verification?.reason ?? "unknown reason";
    if (attempt < 11) await sleep(5_000);
  }
  throw new Error(`GitHub did not verify the repair commit: ${reason}`);
}

export async function updateVerifiedRef(input: {
  commitSha: string;
  graphql: GraphqlRequest;
  headRef: string;
  headSha: string;
  repositoryId: string;
}): Promise<void> {
  const result = (await input.graphql(
    `mutation UpdateVerifiedRef($input: UpdateRefsInput!) {
      updateRefs(input: $input) { clientMutationId }
    }`,
    {
      input: {
        clientMutationId: input.commitSha,
        refUpdates: [
          {
            afterOid: input.commitSha,
            beforeOid: input.headSha,
            force: false,
            name: `refs/heads/${input.headRef}`,
          },
        ],
        repositoryId: input.repositoryId,
      },
    },
  )) as { updateRefs?: { clientMutationId?: string } };
  if (result.updateRefs?.clientMutationId !== input.commitSha)
    throw new Error("GitHub did not confirm the atomic PR branch update");
}

export function githubClient(token: string): { graphql: GraphqlRequest; request: GitHubRequest } {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  const parse = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    let body: { data?: unknown; errors?: Array<{ message?: string }>; message?: string };
    try {
      body = text === "" ? {} : (JSON.parse(text) as typeof body);
    } catch {
      throw new Error(`GitHub API returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok || body.errors?.length) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") ||
        body.message ||
        `HTTP ${response.status}`;
      throw new Error(`GitHub API request failed: ${message}`);
    }
    return body.data ?? body;
  };
  return {
    graphql: async (query, variables) =>
      parse(
        await fetch("https://api.github.com/graphql", {
          body: JSON.stringify({ query, variables }),
          headers,
          method: "POST",
        }),
      ),
    request: async (method, apiPath, body) =>
      parse(
        await fetch(`https://api.github.com${apiPath}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
        }),
      ),
  };
}
