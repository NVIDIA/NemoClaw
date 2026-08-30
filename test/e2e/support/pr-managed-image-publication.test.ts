// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

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
  resolvePrManagedImageCatalog,
  selectManagedImagePublicationRun,
} from "../../../tools/e2e/pr-managed-image-publication.mts";
import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "c".repeat(40);
const CANDIDATE_TREE_SHA = "d".repeat(40);
const PR_NUMBER = 8746;
const WORKFLOW_ID = 12345;
const MANAGED_IMAGE_WORKFLOW = fs.readFileSync(".github/workflows/managed-images.yaml", "utf8");

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

function exactCommitRequest(changedPath: string, onUnexpected: (apiPath: string) => unknown) {
  const baseBlob = "1".repeat(40);
  const candidateBlob = "2".repeat(40);
  return async (apiPath: string): Promise<unknown> => {
    switch (apiPath) {
      case `/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`:
        return {
          state: "open",
          base: { sha: BASE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
          head: { sha: CANDIDATE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
        };
      case `/repos/NVIDIA/NemoClaw/git/commits/${BASE_SHA}`:
        return { sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } };
      case `/repos/NVIDIA/NemoClaw/git/commits/${CANDIDATE_SHA}`:
        return { sha: CANDIDATE_SHA, tree: { sha: CANDIDATE_TREE_SHA } };
      case `/repos/NVIDIA/NemoClaw/git/trees/${BASE_TREE_SHA}?recursive=1`:
        return {
          sha: BASE_TREE_SHA,
          truncated: false,
          tree: [{ path: changedPath, mode: "100644", type: "blob", sha: baseBlob }],
        };
      case `/repos/NVIDIA/NemoClaw/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`:
        return {
          sha: CANDIDATE_TREE_SHA,
          truncated: false,
          tree: [{ path: changedPath, mode: "100644", type: "blob", sha: candidateBlob }],
        };
      default:
        return onUnexpected(apiPath);
    }
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

  it("classifies immutable commit trees without reading the mutable PR file listing", async () => {
    const requests: string[] = [];
    const request = exactCommitRequest("docs/upgrade.md", (apiPath) => {
      requests.push(apiPath);
      throw new Error(`unexpected request: ${apiPath}`);
    });

    await expect(
      resolvePrManagedImageCatalog(
        {
          baseSha: BASE_SHA,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          outputPath: path.join(os.tmpdir(), "unused-pr-managed-image-catalog.json"),
          prNumber: PR_NUMBER,
          token: "test-token",
          workflowSource: MANAGED_IMAGE_WORKFLOW,
        },
        async (apiPath) => {
          requests.push(apiPath);
          return request(apiPath);
        },
      ),
    ).resolves.toBe("not-required");
    expect(requests).toContain(`/repos/NVIDIA/NemoClaw/git/commits/${BASE_SHA}`);
    expect(requests).toContain(`/repos/NVIDIA/NemoClaw/git/commits/${CANDIDATE_SHA}`);
    expect(requests.some((apiPath) => apiPath.includes(`/pulls/${PR_NUMBER}/files`))).toBe(false);
  });

  it("requires exact publication after an immutable managed-image input change", async () => {
    const request = exactCommitRequest("agents/hermes/plugin/__init__.py", (apiPath) => {
      throw new Error(`publication lookup reached: ${apiPath}`);
    });

    await expect(
      resolvePrManagedImageCatalog(
        {
          baseSha: BASE_SHA,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          outputPath: path.join(os.tmpdir(), "unused-pr-managed-image-catalog.json"),
          prNumber: PR_NUMBER,
          token: "test-token",
          workflowSource: MANAGED_IMAGE_WORKFLOW,
        },
        request,
      ),
    ).rejects.toThrow("publication lookup reached: /repos/NVIDIA/NemoClaw/actions/workflows");
  });

  it("rejects a truncated immutable commit tree", async () => {
    const request = exactCommitRequest("docs/upgrade.md", (apiPath) => {
      throw new Error(`unexpected request: ${apiPath}`);
    });
    const truncatedTreePath = `/repos/NVIDIA/NemoClaw/git/trees/${BASE_TREE_SHA}?recursive=1`;
    const substitutedResponses = new Map<string, unknown>([
      [
        truncatedTreePath,
        {
          sha: BASE_TREE_SHA,
          truncated: true,
          tree: [
            {
              path: "docs/upgrade.md",
              mode: "100644",
              type: "blob",
              sha: "1".repeat(40),
            },
          ],
        },
      ],
    ]);
    await expect(
      resolvePrManagedImageCatalog(
        {
          baseSha: BASE_SHA,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          outputPath: path.join(os.tmpdir(), "unused-pr-managed-image-catalog.json"),
          prNumber: PR_NUMBER,
          token: "test-token",
          workflowSource: MANAGED_IMAGE_WORKFLOW,
        },
        async (apiPath) => substitutedResponses.get(apiPath) ?? request(apiPath),
      ),
    ).rejects.toThrow("PR base commit tree is truncated");
  });

  it.each([
    [
      "duplicate directories",
      [
        { path: "agents", mode: "040000", type: "tree", sha: "1".repeat(40) },
        { path: "agents", mode: "040000", type: "tree", sha: "2".repeat(40) },
      ],
    ],
    [
      "directory and file collisions",
      [
        { path: "agents", mode: "040000", type: "tree", sha: "1".repeat(40) },
        { path: "agents", mode: "100644", type: "blob", sha: "2".repeat(40) },
      ],
    ],
  ])("rejects %s in an immutable commit tree", async (_description, tree) => {
    const request = exactCommitRequest("docs/upgrade.md", (apiPath) => {
      throw new Error(`unexpected request: ${apiPath}`);
    });
    const baseTreePath = `/repos/NVIDIA/NemoClaw/git/trees/${BASE_TREE_SHA}?recursive=1`;

    await expect(
      resolvePrManagedImageCatalog(
        {
          baseSha: BASE_SHA,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          outputPath: path.join(os.tmpdir(), "unused-pr-managed-image-catalog.json"),
          prNumber: PR_NUMBER,
          token: "test-token",
          workflowSource: MANAGED_IMAGE_WORKFLOW,
        },
        async (apiPath) =>
          apiPath === baseTreePath
            ? { sha: BASE_TREE_SHA, truncated: false, tree }
            : request(apiPath),
      ),
    ).rejects.toThrow("PR base commit tree contains duplicate paths");
  });

  it.each([
    ["blob", "040000"],
    ["commit", "100644"],
    ["tree", "100755"],
  ])("rejects an immutable %s entry with Git mode %s", async (type, mode) => {
    const request = exactCommitRequest("docs/upgrade.md", (apiPath) => {
      throw new Error(`unexpected request: ${apiPath}`);
    });
    const baseTreePath = `/repos/NVIDIA/NemoClaw/git/trees/${BASE_TREE_SHA}?recursive=1`;

    await expect(
      resolvePrManagedImageCatalog(
        {
          baseSha: BASE_SHA,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          outputPath: path.join(os.tmpdir(), "unused-pr-managed-image-catalog.json"),
          prNumber: PR_NUMBER,
          token: "test-token",
          workflowSource: MANAGED_IMAGE_WORKFLOW,
        },
        async (apiPath) =>
          apiPath === baseTreePath
            ? {
                sha: BASE_TREE_SHA,
                truncated: false,
                tree: [{ path: "agents", mode, type, sha: "1".repeat(40) }],
              }
            : request(apiPath),
      ),
    ).rejects.toThrow("PR base tree entry mode is invalid");
  });

  it("rejects a manual PR catalog without a trusted pre-checkout producer", () => {
    const workflow = readE2eOperationsWorkflow();
    delete workflow.jobs["generate-matrix"].outputs?.managed_image_catalog;

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR managed-image catalog must be authenticated before candidate checkout",
    );
  });

  it("rejects a candidate mutation of the authenticated managed-image catalog", () => {
    const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8"));
    const packageCli = workflow.jobs["generate-matrix"].steps.find(
      (step: Record<string, unknown>) => step.name === "Package exact-commit CLI",
    );
    const stagingMatch = packageCli.run.match(
      /# BEGIN exact managed-image catalog staging\n([\s\S]*?)# END exact managed-image catalog staging/u,
    );
    const stagingSource = stagingMatch?.[1] ?? "";

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-stage-test-"));
    try {
      fs.mkdirSync(path.join(directory, "dist"), { mode: 0o700 });
      const trustedCatalog = JSON.stringify(
        Object.fromEntries(
          SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contract(agent, index)]),
        ),
      );
      const trustedDigest = createHash("sha256")
        .update(`${trustedCatalog}\n`, "utf8")
        .digest("hex");
      fs.writeFileSync(
        path.join(directory, "pr-managed-image-catalog.json"),
        '{"candidateMutation":true}\n',
        { mode: 0o600 },
      );
      const scriptPath = path.join(directory, "stage-managed-image-catalog.sh");
      fs.writeFileSync(scriptPath, `set -euo pipefail\n${stagingSource}`, { mode: 0o700 });

      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", scriptPath], {
        cwd: directory,
        encoding: "utf8",
        env: {
          MANAGED_IMAGE_CATALOG: trustedCatalog,
          MANAGED_IMAGE_CATALOG_SHA256: trustedDigest,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          RUNNER_TEMP: directory,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "trusted PR managed-image catalog changed after authentication",
      );
      expect(fs.existsSync(path.join(directory, "dist/e2e-managed-image-catalog.json"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
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
