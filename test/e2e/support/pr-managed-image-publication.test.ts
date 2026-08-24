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
  main,
  managedImagePublicationRequired,
  parseManagedImagePullRequestPaths,
  selectManagedImagePublicationRun,
} from "../../../tools/e2e/pr-managed-image-publication.mts";

const CANDIDATE_SHA = "a".repeat(40);
const PR_NUMBER = 8746;
const WORKFLOW_ID = 12345;

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

function run(overrides: Record<string, unknown> = {}): unknown {
  return {
    total_count: 1,
    workflow_runs: [
      {
        id: 32144654845,
        run_attempt: 1,
        workflow_id: WORKFLOW_ID,
        name: "Images / Build, Test, and Publish Managed Images",
        path: ".github/workflows/managed-images.yaml",
        event: "pull_request",
        head_sha: CANDIDATE_SHA,
        status: "completed",
        conclusion: "success",
        repository: { full_name: "NVIDIA/NemoClaw" },
        head_repository: { full_name: "NVIDIA/NemoClaw" },
        pull_requests: [{ number: PR_NUMBER }],
        ...overrides,
      },
    ],
  };
}

describe("exact PR managed-image publication (#8746, #9464)", () => {
  it("derives applicability from the trusted managed-image workflow", () => {
    const patterns = parseManagedImagePullRequestPaths(
      fs.readFileSync(".github/workflows/managed-images.yaml", "utf8"),
    );

    expect(
      managedImagePublicationRequired(["src/lib/onboard/workload/preparation.ts"], patterns),
    ).toBe(true);
    expect(
      managedImagePublicationRequired(["tools/mcp-tool-discovery-runtime/server.mts"], patterns),
    ).toBe(true);
    expect(
      managedImagePublicationRequired(
        ["src/lib/actions/sandbox/mcp-bridge-adapter-openclaw.ts"],
        patterns,
      ),
    ).toBe(true);
    expect(managedImagePublicationRequired(["docs/My Guide.md"], patterns)).toBe(false);
    expect(() =>
      managedImagePublicationRequired(["src/lib/onboard/file.ts\nother"], patterns),
    ).toThrow("changed-file path is invalid");
  });

  it("rejects an unreviewed path-filter glob", () => {
    expect(() =>
      parseManagedImagePullRequestPaths(`
on:
  pull_request:
    paths:
      - ".github/workflows/managed-images.yaml"
      - "src/**/nested/**"
`),
    ).toThrow("unsupported glob");
  });

  it("selects one successful workflow run for the candidate commit", () => {
    expect(
      selectManagedImagePublicationRun(run(), {
        headSha: CANDIDATE_SHA,
        prNumber: PR_NUMBER,
        workflowId: WORKFLOW_ID,
      }),
    ).toEqual({ id: 32144654845, attempt: 1, headSha: CANDIDATE_SHA });
  });

  it.each([
    ["pending", { status: "in_progress", conclusion: null }, "must complete successfully"],
    ["failed", { conclusion: "failure" }, "must complete successfully"],
    ["different commit", { head_sha: "b".repeat(40) }, "commit must be"],
    ["different PR", { pull_requests: [{ number: 9464 }] }, "PR number"],
  ])("rejects a %s publication run", (_label, overrides, message) => {
    expect(() =>
      selectManagedImagePublicationRun(run(overrides), {
        headSha: CANDIDATE_SHA,
        prNumber: PR_NUMBER,
        workflowId: WORKFLOW_ID,
      }),
    ).toThrow(message);
  });

  it("assembles one exact all-agent catalog", () => {
    const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map(contract);

    expect(assembleManagedImageCatalog(contracts, CANDIDATE_SHA)).toEqual(
      Object.fromEntries(contracts.map((value) => [value.agent, value])),
    );
  });

  it("writes a validated catalog through the shared assembly command", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-test-"));
    try {
      const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
        const contractPath = path.join(directory, `${agent}.json`);
        fs.writeFileSync(contractPath, JSON.stringify(contract(agent, index)));
        return contractPath;
      });
      const outputPath = path.join(directory, "catalog.json");

      await main(["assemble", CANDIDATE_SHA, outputPath, ...contracts], {});

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
              source: { ...contract(agent, index).source, revision: "b".repeat(40) },
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
