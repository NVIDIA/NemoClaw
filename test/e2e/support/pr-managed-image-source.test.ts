// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
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

function requestFor(
  files: Array<{ filename: string; previous_filename?: string }>,
  pullOverrides: Record<string, unknown> = {},
) {
  const responses = new Map<string, unknown>([
    [`/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`, pull(files.length, pullOverrides)],
    [`/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}/files?per_page=100&page=1`, files],
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
  it("selects a local Dockerfile when a reviewed image input changes", async () => {
    await expect(
      resolvePrManagedImageSource(selectorInput(), requestFor([{ filename: "Dockerfile.base" }])),
    ).resolves.toBe("local-dockerfile");
  });

  it("selects a trusted managed image when reviewed image inputs are unchanged", async () => {
    await expect(
      resolvePrManagedImageSource(selectorInput(), requestFor([{ filename: "docs/guide.mdx" }])),
    ).resolves.toBe("managed-image");
  });

  it("rejects PR identity drift before selecting a source", async () => {
    const request = requestFor([{ filename: "Dockerfile" }], {
      head: { sha: CANDIDATE_SHA, repo: { full_name: "attacker/fork" } },
    });

    await expect(resolvePrManagedImageSource(selectorInput(), request)).rejects.toThrow(
      "pull request source repository must be NVIDIA/NemoClaw",
    );
  });

  it("records PR source reads in the retry inventory", () => {
    const row = fs
      .readFileSync("test/e2e/RETRY_INVENTORY.md", "utf8")
      .split("\n")
      .find((line) => line.startsWith("| `github-publication-read` |"));

    expect(row).toContain("tools/e2e/base-image-publication.mts");
    expect(row).toContain("tools/e2e/pr-managed-image-source.mts");
    expect(row).toContain("PR metadata reads");
    expect(row).toContain("workload-source selection");
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
