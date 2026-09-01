// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { githubRequest } from "../../../tools/e2e/base-image-publication.mts";
import {
  main,
  resolvePrManagedImageSource,
} from "../../../tools/e2e/pr-managed-image-publication.mts";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "1".repeat(40);
const CANDIDATE_TREE_SHA = "2".repeat(40);
const PR_NUMBER = 10_263;
const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
  workflow_dispatch:
jobs: {}
`;

function treeEntry(path: string, sha: string) {
  return { mode: "100644", path, sha, type: "blob" };
}

function requestFor(candidateRepository: string, imageChanged: boolean) {
  const baseEntries = [
    treeEntry("Dockerfile.base", "3".repeat(40)),
    treeEntry("docs/guide.mdx", "4".repeat(40)),
  ];
  const candidateEntries = [
    treeEntry("Dockerfile.base", (imageChanged ? "5" : "3").repeat(40)),
    treeEntry("docs/guide.mdx", "4".repeat(40)),
  ];
  const responses = new Map<string, unknown>([
    [
      `/repos/${CANONICAL_REPOSITORY}/pulls/${PR_NUMBER}`,
      {
        state: "open",
        base: { sha: BASE_SHA, repo: { full_name: CANONICAL_REPOSITORY } },
        head: { sha: CANDIDATE_SHA, repo: { full_name: candidateRepository } },
      },
    ],
    [
      `/repos/${CANONICAL_REPOSITORY}/git/commits/${BASE_SHA}`,
      { sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } },
    ],
    [
      `/repos/${CANONICAL_REPOSITORY}/git/trees/${BASE_TREE_SHA}?recursive=1`,
      { sha: BASE_TREE_SHA, tree: baseEntries, truncated: false },
    ],
    [
      `/repos/${candidateRepository}/git/commits/${CANDIDATE_SHA}`,
      { sha: CANDIDATE_SHA, tree: { sha: CANDIDATE_TREE_SHA } },
    ],
    [
      `/repos/${candidateRepository}/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`,
      { sha: CANDIDATE_TREE_SHA, tree: candidateEntries, truncated: false },
    ],
  ]);
  return async (requestPath: string): Promise<unknown> =>
    responses.get(requestPath) ?? Promise.reject(new Error(`unexpected request ${requestPath}`));
}

function selectorInput(candidateRepository: string) {
  return {
    baseSha: BASE_SHA,
    candidateRepository,
    candidateSha: CANDIDATE_SHA,
    prNumber: PR_NUMBER,
    token: "test-token",
    workflowSource: WORKFLOW_SOURCE,
  };
}

async function assemblePrManagedImageCatalog(
  cohorts: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Record<string, unknown>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-managed-contracts-"));
  const output = path.join(root, "catalog.json");
  try {
    const contractPaths = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
      const contractRoot = path.join(root, agent);
      const contractPath = path.join(contractRoot, "contract.json");
      const digest = `sha256:${(index + 1).toString(16).padStart(64, "0")}`;
      const image = MANAGED_IMAGE_REPOSITORIES[agent];
      fs.mkdirSync(contractRoot);
      fs.writeFileSync(
        contractPath,
        `${JSON.stringify({
          contractVersion: 1,
          agent,
          platform: "linux/amd64",
          image,
          digest,
          reference: `${image}@${digest}`,
          source: {
            repository: CANONICAL_REPOSITORY,
            revision: CANDIDATE_SHA,
            release: "v0.0.1",
            cohort: cohorts[index],
          },
          startupProfileContractVersion: 1,
          capabilityContractVersion: 1,
        })}\n`,
      );
      return contractPath;
    });
    await main(["assemble", CANDIDATE_SHA, output, ...contractPaths], {
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "7001",
      ...env,
    });
    return JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR managed-image source selection", () => {
  it("keeps source selection bound to commit A during A-to-B-to-A PR drift", async () => {
    await expect(
      resolvePrManagedImageSource(
        selectorInput(CANONICAL_REPOSITORY),
        requestFor(CANONICAL_REPOSITORY, true),
      ),
    ).resolves.toBe("local-dockerfile");
  });

  it("reads a validated external candidate repository through the default request policy", async () => {
    const candidateRepository = "external-contributor/NemoClaw";
    const request = requestFor(candidateRepository, false);
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      return new Response(JSON.stringify(await request(`${url.pathname}${url.search}`)), {
        status: 200,
      });
    });

    await expect(resolvePrManagedImageSource(selectorInput(candidateRepository))).resolves.toBe(
      "managed-image",
    );
  });

  it("rejects a GitHub request outside the canonical and candidate repositories", async () => {
    await expect(
      githubRequest(`/repos/other-owner/other-repository/git/commits/${CANDIDATE_SHA}`, "token", {
        additionalRepository: "external-contributor/NemoClaw",
        attempts: 1,
        fetchImpl: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow("GitHub API path must stay within an allowed repository");
  });
});

describe("PR managed-image contract restoration", () => {
  it("restores one earlier producer attempt for a failed-job rerun", async () => {
    const catalog = await assemblePrManagedImageCatalog([
      "ghrun-7001-1",
      "ghrun-7001-1",
      "ghrun-7001-1",
    ]);

    expect(Object.keys(catalog)).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS]);
  });

  it.each([
    ["mixed attempts", ["ghrun-7001-1", "ghrun-7001-1", "ghrun-7001-2"], "one publication cohort"],
    ["another run", ["ghrun-7000-1", "ghrun-7000-1", "ghrun-7000-1"], "producer run"],
    ["a future attempt", ["ghrun-7001-3", "ghrun-7001-3", "ghrun-7001-3"], "producer attempt"],
  ])("rejects contracts from %s", async (_case, cohorts, message) => {
    await expect(assemblePrManagedImageCatalog(cohorts)).rejects.toThrow(message);
  });
});
