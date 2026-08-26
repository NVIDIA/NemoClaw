// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract";
import {
  assembleManagedImageCatalog,
  resolvePrManagedImageSource,
  writeManagedImageCatalog,
} from "../../../tools/e2e/pr-managed-image-source.mts";
import { githubRequest } from "../../../tools/e2e/base-image-publication.mts";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const DRIFT_SHA = "c".repeat(40);
const BASE_TREE_SHA = "1".repeat(40);
const CANDIDATE_TREE_SHA = "2".repeat(40);
const PR_NUMBER = 10_113;
const CANDIDATE_REPOSITORY = "NVIDIA/NemoClaw";

function contract(agent: ManagedImageAgent, index: number): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${String(index + 1).repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: "linux/amd64",
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: CANDIDATE_SHA,
      release: "v0.0.110",
      cohort: "ghrun-32144654845-1",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function pull(changedFiles: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    state: "open",
    changed_files: changedFiles,
    base: { sha: BASE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
    head: { sha: CANDIDATE_SHA, repo: { full_name: CANDIDATE_REPOSITORY } },
    ...overrides,
  };
}

function unexpectedRequest(requestPath: string): never {
  throw new Error(`unexpected request ${requestPath}`);
}

function requestForChanges(
  changes: Array<{ filename: string; previous_filename?: string }>,
  pullOverrides: Record<string, unknown> = {},
  candidateRepository = CANDIDATE_REPOSITORY,
) {
  const baseEntries = changes.map((change) => ({
    mode: "100644",
    path: change.previous_filename ?? change.filename,
    sha: "3".repeat(40),
    type: "blob",
  }));
  const candidateEntries = changes.map((change) => ({
    mode: "100644",
    path: change.filename,
    sha: "4".repeat(40),
    type: "blob",
  }));
  const responses = new Map<string, unknown>([
    [`/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`, pull(changes.length, pullOverrides)],
    [`/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}/files?per_page=100&page=1`, changes],
    [
      `/repos/NVIDIA/NemoClaw/git/commits/${BASE_SHA}`,
      { sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } },
    ],
    [
      `/repos/NVIDIA/NemoClaw/git/trees/${BASE_TREE_SHA}?recursive=1`,
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
    responses.get(requestPath) ?? unexpectedRequest(requestPath);
}

function selectorInput() {
  return {
    baseSha: BASE_SHA,
    candidateRepository: CANDIDATE_REPOSITORY,
    candidateSha: CANDIDATE_SHA,
    prNumber: PR_NUMBER,
    token: "test-token",
    workflowSource: fs.readFileSync(".github/workflows/base-image.yaml", "utf8"),
  };
}

describe("PR managed-image source selection", () => {
  it("reads a validated external PR source through the default request path", async () => {
    const candidateRepository = "external-contributor/NemoClaw";
    const externalInput = { ...selectorInput(), candidateRepository };
    const request = requestForChanges(
      [{ filename: "docs/guide.mdx" }],
      { head: { sha: CANDIDATE_SHA, repo: { full_name: candidateRepository } } },
      candidateRepository,
    );
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      requestedUrls.push(input);
      const requestPath = new URL(input).pathname + new URL(input).search;
      const value = await request(requestPath);
      return new Response(JSON.stringify(value), { status: 200 });
    });

    await expect(resolvePrManagedImageSource(externalInput)).resolves.toBe("managed-image");
    expect(requestedUrls).toContain(
      `https://api.github.com/repos/${candidateRepository}/git/commits/${CANDIDATE_SHA}`,
    );
  });

  it("rejects a repository other than NemoClaw and the validated PR source before fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    await expect(
      githubRequest("/repos/other-owner/other-repository/git/commits/" + CANDIDATE_SHA, "token", {
        additionalRepository: "external-contributor/NemoClaw",
        fetchImpl,
      }),
    ).rejects.toThrow("GitHub API path must stay within an allowed repository");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["external-contributor/..", "../NemoClaw", "external-contributor/repo\nname"])(
    "rejects invalid additional repository %j before fetch",
    async (additionalRepository) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
      await expect(
        githubRequest(`/repos/NVIDIA/NemoClaw/git/commits/${CANDIDATE_SHA}`, "token", {
          additionalRepository,
          fetchImpl,
        }),
      ).rejects.toThrow("additional GitHub API repository is invalid");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "Dockerfile",
    "Dockerfile.base",
    "agents/hermes/Dockerfile.base",
    "agents/langchain-deepagents-code/Dockerfile.base",
    "agents/pi/Dockerfile.base",
    "src/lib/hermes-managed-route.ts",
    "src/lib/inference/managed-dcode/identity.ts",
    "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle",
  ])("selects a local Dockerfile when reviewed image input %s changes", async (filename) => {
    await expect(
      resolvePrManagedImageSource(selectorInput(), requestForChanges([{ filename }])),
    ).resolves.toBe("local-dockerfile");
  });

  it("selects a local Dockerfile when a reviewed image input is renamed", async () => {
    await expect(
      resolvePrManagedImageSource(
        selectorInput(),
        requestForChanges([
          { filename: "docs/renamed-base-image.txt", previous_filename: "Dockerfile.base" },
        ]),
      ),
    ).resolves.toBe("local-dockerfile");
  });

  it("selects a trusted managed image when reviewed image inputs are unchanged", async () => {
    await expect(
      resolvePrManagedImageSource(
        selectorInput(),
        requestForChanges([{ filename: "docs/guide.mdx" }]),
      ),
    ).resolves.toBe("managed-image");
  });

  it("keeps classification bound to immutable commits during A-to-B-to-A PR drift", async () => {
    const metadataPath = `/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`;
    const mutableFilesPath = `${metadataPath}/files?per_page=100&page=1`;
    const immutableRequest = requestForChanges([{ filename: "Dockerfile.base" }]);
    const requests: string[] = [];
    const observedPrHeads = [CANDIDATE_SHA];
    const requestHandlers = new Map<string, () => Promise<unknown> | unknown>([
      [
        metadataPath,
        async () => {
          const response = await immutableRequest(metadataPath);
          observedPrHeads.push(DRIFT_SHA);
          return response;
        },
      ],
      [mutableFilesPath, () => [{ filename: "docs/guide.mdx" }]],
      [
        `/repos/${CANDIDATE_REPOSITORY}/git/commits/${CANDIDATE_SHA}`,
        async () => {
          observedPrHeads.push(CANDIDATE_SHA);
          return immutableRequest(`/repos/${CANDIDATE_REPOSITORY}/git/commits/${CANDIDATE_SHA}`);
        },
      ],
    ]);
    const request = async (requestPath: string): Promise<unknown> => {
      requests.push(requestPath);
      const handler = requestHandlers.get(requestPath);
      return handler ? handler() : immutableRequest(requestPath);
    };

    await expect(resolvePrManagedImageSource(selectorInput(), request)).resolves.toBe(
      "local-dockerfile",
    );
    expect(observedPrHeads).toEqual([CANDIDATE_SHA, DRIFT_SHA, CANDIDATE_SHA]);
    expect(requests).not.toContain(mutableFilesPath);
    expect(requests).toContain(
      `/repos/${CANDIDATE_REPOSITORY}/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`,
    );
  });

  it("rejects a truncated immutable candidate tree", async () => {
    const candidateTreePath = `/repos/${CANDIDATE_REPOSITORY}/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`;
    const immutableRequest = requestForChanges([{ filename: "docs/guide.mdx" }]);
    const request = async (requestPath: string): Promise<unknown> =>
      requestPath === candidateTreePath
        ? { sha: CANDIDATE_TREE_SHA, tree: [], truncated: true }
        : immutableRequest(requestPath);

    await expect(resolvePrManagedImageSource(selectorInput(), request)).rejects.toThrow(
      "PR candidate commit tree is truncated",
    );
  });

  it.each([
    ["a closed pull request", { state: "closed" }, "pull request state must be open"],
    [
      "base commit drift",
      { base: { sha: "c".repeat(40), repo: { full_name: "NVIDIA/NemoClaw" } } },
      `pull request base commit must be ${BASE_SHA}`,
    ],
    [
      "candidate commit drift",
      {
        head: {
          sha: "c".repeat(40),
          repo: { full_name: CANDIDATE_REPOSITORY },
        },
      },
      `pull request source commit must be ${CANDIDATE_SHA}`,
    ],
    [
      "source repository drift",
      { head: { sha: CANDIDATE_SHA, repo: { full_name: "attacker/fork" } } },
      "pull request source repository must be NVIDIA/NemoClaw",
    ],
  ])("rejects %s before reading changed files", async (_label, pullOverrides, message) => {
    const metadataPath = `/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`;
    const requests: string[] = [];
    const responses = new Map<string, unknown>([[metadataPath, pull(1, pullOverrides)]]);
    const request = async (requestPath: string): Promise<unknown> => {
      requests.push(requestPath);
      return responses.get(requestPath) ?? unexpectedRequest(requestPath);
    };

    await expect(resolvePrManagedImageSource(selectorInput(), request)).rejects.toThrow(message);
    expect(requests).toEqual([metadataPath]);
  });
});

describe("managed-image activation catalog assembly", () => {
  it("assembles one exact all-agent catalog", () => {
    const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map(contract);
    expect(assembleManagedImageCatalog(contracts, CANDIDATE_SHA)).toEqual(
      Object.fromEntries(contracts.map((value) => [value.agent, value])),
    );
  });

  it("writes a validated private catalog", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-test-"));
    try {
      const contractPaths = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
        const contractPath = path.join(directory, `${agent}.json`);
        fs.writeFileSync(contractPath, JSON.stringify(contract(agent, index)));
        return contractPath;
      });
      const outputPath = path.join(directory, "catalog.json");
      writeManagedImageCatalog(contractPaths, CANDIDATE_SHA, outputPath);
      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(
        Object.fromEntries(
          SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contract(agent, index)]),
        ),
      );
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a symbolic-link catalog output", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-link-test-"));
    try {
      const contractPaths = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
        const contractPath = path.join(directory, `${agent}.json`);
        fs.writeFileSync(contractPath, JSON.stringify(contract(agent, index)));
        return contractPath;
      });
      const targetPath = path.join(directory, "target.json");
      const outputPath = path.join(directory, "catalog.json");
      fs.writeFileSync(targetPath, "unchanged\n");
      fs.symlinkSync(targetPath, outputPath);

      expect(() => writeManagedImageCatalog(contractPaths, CANDIDATE_SHA, outputPath)).toThrow();
      expect(fs.readFileSync(targetPath, "utf8")).toBe("unchanged\n");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "candidate revision",
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) =>
        index === 0
          ? {
              ...contract(agent, index),
              source: { ...contract(agent, index).source, revision: "c".repeat(40) },
            }
          : contract(agent, index),
      ),
      "candidate commit",
    ],
    [
      "publication cohort",
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) =>
        index === 0
          ? {
              ...contract(agent, index),
              source: { ...contract(agent, index).source, cohort: "ghrun-32144654845-2" },
            }
          : contract(agent, index),
      ),
      "publication cohort",
    ],
    [
      "agent set",
      [contract("openclaw", 0), contract("openclaw", 0), contract("hermes", 1)],
      "every shipped agent",
    ],
  ])("rejects mixed %s authority", (_label, contracts, message) => {
    expect(() => assembleManagedImageCatalog(contracts, CANDIDATE_SHA)).toThrow(message);
  });
});
