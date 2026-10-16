// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";

export interface GitHubApi {
  request(route: string, parameters: Record<string, unknown>): Promise<{ data: any }>;
  graphql(query: string, variables: Record<string, unknown>): Promise<any>;
}

// The Actions client owns authentication. Neither inference nor generated files
// receive the workflow's write credential.
export async function publishMapping(
  api: GitHubApi,
  repository: string,
  branch: string,
  expected: string,
  bootstrapSha: string,
  mappingPath: string,
  previousMapping?: string,
): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w/-]+$/.test(branch))
    throw Error("Invalid publication destination");
  if ((expected && !/^[a-f0-9]{40,64}$/.test(expected)) || !/^[a-f0-9]{40,64}$/.test(bootstrapSha))
    throw Error("Invalid mapping revision");
  const [owner, repo] = repository.split("/");
  const target = { owner, repo };
  const remote = async () => {
    try {
      return (
        await api.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ...target,
          ref: `heads/${branch}`,
        })
      ).data.object.sha as string;
    } catch (error: any) {
      if (error.status === 404) return "";
      throw error;
    }
  };
  const verified = async (sha: string) =>
    (
      await api.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        ...target,
        commit_sha: sha,
      })
    ).data.verification?.verified === true;
  if ((await remote()) !== expected)
    throw Error("Mapping branch changed; rerun against the new mapping");
  const mapping = await readFile(mappingPath, "utf8");
  if (expected && previousMapping === mapping) return expected;
  let parent = expected;
  if (!parent) {
    // Starting from an existing signed commit inherits the workflow without
    // requiring the bot to create or modify a workflow file.
    if (!(await verified(bootstrapSha)))
      throw Error("Bootstrap commit is not verified; branch was not created");
    await api.request("POST /repos/{owner}/{repo}/git/refs", {
      ...target,
      ref: `refs/heads/${branch}`,
      sha: bootstrapSha,
    });
    parent = bootstrapSha;
    if ((await remote()) !== parent)
      throw Error("Bootstrap readback differs; inspect before retrying");
  }
  // GitHub signs this commit and advances the branch atomically only if its
  // previous revision still matches. A competing manual edit is preserved.
  const result = await api.graphql(
    `mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`,
    {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName: branch },
        expectedHeadOid: parent,
        message: { headline: "docs(process-window): refresh guidance mapping" },
        fileChanges: {
          additions: [{ path: "mapping.yaml", contents: Buffer.from(mapping).toString("base64") }],
        },
      },
    },
  );
  const published = result.createCommitOnBranch.commit.oid;
  if (!(await verified(published))) throw Error("Published mapping commit is not verified");
  if ((await remote()) !== published)
    throw Error("Mapping publication readback differs; inspect before retrying");
  return published;
}
