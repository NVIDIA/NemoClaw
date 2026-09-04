// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageAgent,
  type ManagedImageContractV1,
} from "../../../src/lib/onboard/managed-image/contract";
import { githubRequest } from "../../../tools/e2e/base-image-publication.mts";
import {
  assembleManagedImageCatalog,
  main,
  resolvePrManagedImageCatalog,
  selectManagedImagePublicationRun,
  writeManagedImageCatalog,
} from "../../../tools/e2e/pr-managed-image-publication.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "1".repeat(40);
const CANDIDATE_TREE_SHA = "2".repeat(40);
const PR_NUMBER = 10_595;
const RUN_ID = 33_460_364_260;
const WORKFLOW_ID = 12_345;
const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
      - "src/lib/onboard/**"
  workflow_dispatch:
jobs: {}
`;
const temporaryDirectories: string[] = [];

function contractForCohort(
  agent: ManagedImageAgent,
  index: number,
  cohort: ManagedImageContractV1["source"]["cohort"],
): ManagedImageContractV1 {
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
      cohort,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function contract(agent: ManagedImageAgent, index: number): ManagedImageContractV1 {
  return contractForCohort(agent, index, `ghrun-${RUN_ID}-1`);
}

function contractArchive(agent: ManagedImageAgent, index: number): Buffer {
  return artifactZip([
    { name: "contract.json", contents: `${JSON.stringify(contract(agent, index))}\n` },
  ]);
}

function treeEntry(entryPath: string, sha: string) {
  return { mode: "100644", path: entryPath, sha, type: "blob" };
}

function workflowRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    run_attempt: 1,
    workflow_id: WORKFLOW_ID,
    name: "Images / Build, Test, and Publish Managed Images",
    path: ".github/workflows/managed-images.yaml",
    event: "pull_request",
    head_sha: CANDIDATE_SHA,
    status: "completed",
    conclusion: "success",
    repository: { full_name: CANONICAL_REPOSITORY },
    head_repository: { full_name: CANONICAL_REPOSITORY },
    pull_requests: [{ number: PR_NUMBER }],
    ...overrides,
  };
}

function workflowRun(overrides: Record<string, unknown> = {}) {
  return { total_count: 1, workflow_runs: [workflowRunRecord(overrides)] };
}

function candidateRequest(options: {
  readonly candidateRepository?: string;
  readonly changedPath?: string;
  readonly imageChanged: boolean;
  readonly run?: unknown;
  readonly runPages?: readonly unknown[];
  readonly artifactHeadSha?: string;
  readonly artifactRunId?: number;
  readonly missingAgent?: ManagedImageAgent;
}) {
  const candidateRepository = options.candidateRepository ?? CANONICAL_REPOSITORY;
  const changedPath = options.changedPath ?? "Dockerfile.base";
  const artifactRunId = options.artifactRunId ?? RUN_ID;
  const baseEntries = [
    treeEntry(changedPath, "3".repeat(40)),
    treeEntry("docs/guide.mdx", "4".repeat(40)),
  ];
  const candidateEntries = [
    treeEntry(changedPath, (options.imageChanged ? "5" : "3").repeat(40)),
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
    [
      `/repos/${CANONICAL_REPOSITORY}/actions/workflows/managed-images.yaml`,
      {
        id: WORKFLOW_ID,
        name: "Images / Build, Test, and Publish Managed Images",
        path: ".github/workflows/managed-images.yaml",
        state: "active",
      },
    ],
  ]);
  const runsPath = `/repos/${CANONICAL_REPOSITORY}/actions/workflows/managed-images.yaml/runs?event=pull_request&head_sha=${CANDIDATE_SHA}&per_page=100`;
  const runPages = options.runPages ?? [options.run ?? workflowRun()];
  for (const [index, page] of runPages.entries()) {
    responses.set(`${runsPath}&page=${index + 1}`, page);
  }
  for (const [index, agent] of SHIPPED_MANAGED_IMAGE_AGENTS.entries()) {
    const name = `managed-pr-contract-${artifactRunId}-${agent}`;
    const archive = contractArchive(agent, index);
    const id = index + 100;
    responses.set(
      `/repos/${CANONICAL_REPOSITORY}/actions/runs/${artifactRunId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      options.missingAgent === agent
        ? { total_count: 0, artifacts: [] }
        : {
            total_count: 1,
            artifacts: [
              {
                archive_download_url: `https://api.github.com/repos/${CANONICAL_REPOSITORY}/actions/artifacts/${id}/zip`,
                digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
                expired: false,
                id,
                name,
                size_in_bytes: archive.length,
                workflow_run: {
                  head_sha: options.artifactHeadSha ?? CANDIDATE_SHA,
                  id: artifactRunId,
                },
              },
            ],
          },
    );
  }
  return async (requestPath: string): Promise<unknown> =>
    responses.get(requestPath) ?? Promise.reject(new Error(`unexpected request ${requestPath}`));
}

function resolverInput(candidateRepository = CANONICAL_REPOSITORY) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-test-"));
  temporaryDirectories.push(directory);
  return {
    baseSha: BASE_SHA,
    candidateRepository,
    candidateSha: CANDIDATE_SHA,
    outputPath: path.join(directory, "catalog.json"),
    prNumber: PR_NUMBER,
    token: "test-token",
    workflowSource: WORKFLOW_SOURCE,
  };
}

function downloadContract(
  identity: { readonly name: string },
  cohort: ManagedImageContractV1["source"]["cohort"] = `ghrun-${RUN_ID}-1`,
): Promise<Buffer> {
  const index = SHIPPED_MANAGED_IMAGE_AGENTS.findIndex((agent) => identity.name.endsWith(agent));
  expect(index, "artifact identity must name one shipped agent").toBeGreaterThanOrEqual(0);
  const agent = SHIPPED_MANAGED_IMAGE_AGENTS[index]!;
  return Promise.resolve(
    artifactZip([
      {
        name: "contract.json",
        contents: `${JSON.stringify(contractForCohort(agent, index, cohort))}\n`,
      },
    ]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("exact PR managed-image publication", () => {
  it("keeps unchanged PRs on the authenticated base-history cohort", async () => {
    const input = resolverInput();
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(input, candidateRequest({ imageChanged: false }), download),
    ).resolves.toBe("base-cohort");
    expect(download).not.toHaveBeenCalled();
    expect(fs.existsSync(input.outputPath)).toBe(false);
  });

  it("uses the exact PR base as the base-history cohort", async () => {
    const input = { ...resolverInput(), candidateSha: BASE_SHA };
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(input, candidateRequest({ imageChanged: true }), download),
    ).resolves.toBe("base-cohort");
    expect(download).not.toHaveBeenCalled();
    expect(fs.existsSync(input.outputPath)).toBe(false);
  });

  it("writes one exact candidate catalog after an immutable image-input change", async () => {
    const input = resolverInput();

    await expect(
      resolvePrManagedImageCatalog(
        input,
        candidateRequest({ imageChanged: true }),
        downloadContract,
      ),
    ).resolves.toBe("candidate-catalog");
    expect(JSON.parse(fs.readFileSync(input.outputPath, "utf8"))).toEqual(
      Object.fromEntries(
        SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contract(agent, index)]),
      ),
    );
    expect(fs.statSync(input.outputPath).mode & 0o777).toBe(0o600);
  });

  it("keeps artifact download evidence out of the machine-readable selection", async () => {
    const input = resolverInput();
    const apiRequest = candidateRequest({ imageChanged: true });
    const artifactResponses = new Map<string, Response>(
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
        const archive = contractArchive(agent, index);
        return [
          `/repos/${CANONICAL_REPOSITORY}/actions/artifacts/${index + 100}/zip`,
          new Response(new Uint8Array(archive), {
            status: 200,
            headers: { "content-length": String(archive.length) },
          }),
        ] as const;
      }),
    );
    let standardOutput = "";
    let standardError = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      standardOutput += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      standardOutput += `${values.map(String).join(" ")}\n`;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      standardError += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      standardError += `${values.map(String).join(" ")}\n`;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request) => {
        const url = new URL(String(request));
        return (
          artifactResponses.get(url.pathname) ??
          Response.json(await apiRequest(`${url.pathname}${url.search}`))
        );
      }),
    );

    await main([input.outputPath], {
      BASE_SHA,
      CANDIDATE_REPOSITORY: CANONICAL_REPOSITORY,
      CANDIDATE_SHA,
      GITHUB_TOKEN: "test-token",
      PR_NUMBER: String(PR_NUMBER),
    });

    const artifactEvidence = Array.from(
      { length: SHIPPED_MANAGED_IMAGE_AGENTS.length },
      () => "artifact-content-read attempt=1 outcome=passed-first-attempt\n",
    ).join("");
    expect(standardOutput).toBe("candidate-catalog\n");
    expect(standardOutput).not.toContain("artifact-content-read");
    expect(standardError).toBe(artifactEvidence);
  });

  it("selects a candidate catalog when only managed-image onboarding runtime changes", async () => {
    const input = resolverInput();

    await expect(
      resolvePrManagedImageCatalog(
        input,
        candidateRequest({
          changedPath: "src/lib/onboard/workload/preparation.ts",
          imageChanged: true,
        }),
        downloadContract,
      ),
    ).resolves.toBe("candidate-catalog");
    expect(fs.existsSync(input.outputPath)).toBe(true);
  });

  it("uses one serialization contract for assembled and resolved candidate catalogs", async () => {
    const input = resolverInput();
    await resolvePrManagedImageCatalog(
      input,
      candidateRequest({ imageChanged: true }),
      downloadContract,
    );

    const assemblyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-catalog-assembly-"));
    temporaryDirectories.push(assemblyRoot);
    const contractPaths = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
      const contractPath = path.join(assemblyRoot, `${agent}.json`);
      fs.writeFileSync(contractPath, JSON.stringify(contract(agent, index)), "utf8");
      return contractPath;
    });
    const assembledPath = path.join(assemblyRoot, "assembled", "catalog.json");
    writeManagedImageCatalog(contractPaths, CANDIDATE_SHA, assembledPath, {
      id: RUN_ID,
      attempt: 1,
    });

    expect(fs.readFileSync(assembledPath)).toEqual(fs.readFileSync(input.outputPath));
    expect(fs.statSync(assembledPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(input.outputPath).mode & 0o777).toBe(0o600);
  });

  it("rejects an image-changing fork before any artifact download", async () => {
    const candidateRepository = "external-contributor/NemoClaw";
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(candidateRepository),
        candidateRequest({ candidateRepository, imageChanged: true }),
        download,
      ),
    ).rejects.toThrow("requires a branch in NVIDIA/NemoClaw");
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects a failed exact-candidate Images run before artifact download", async () => {
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        candidateRequest({ imageChanged: true, run: workflowRun({ conclusion: "failure" }) }),
        download,
      ),
    ).rejects.toThrow("must complete successfully before live E2E");
    expect(download).not.toHaveBeenCalled();
  });

  it("resolves an earlier producer cohort after a failed-job rerun", async () => {
    const request = vi.fn(
      candidateRequest({ imageChanged: true, run: workflowRun({ run_attempt: 2 }) }),
    );

    await expect(
      resolvePrManagedImageCatalog(resolverInput(), request, downloadContract),
    ).resolves.toBe("candidate-catalog");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`name=managed-pr-contract-${RUN_ID}-openclaw`),
    );
  });

  it("uses the newest successful Images run after an earlier failure", async () => {
    const laterRunId = RUN_ID + 10;
    const request = vi.fn(
      candidateRequest({
        artifactRunId: laterRunId,
        imageChanged: true,
        run: {
          total_count: 2,
          workflow_runs: [
            workflowRunRecord({ conclusion: "failure" }),
            workflowRunRecord({ id: laterRunId, run_attempt: 2 }),
          ],
        },
      }),
    );

    await expect(
      resolvePrManagedImageCatalog(resolverInput(), request, (identity) =>
        downloadContract(identity, `ghrun-${laterRunId}-2`),
      ),
    ).resolves.toBe("candidate-catalog");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`/actions/runs/${laterRunId}/artifacts`),
    );
    expect(request).not.toHaveBeenCalledWith(
      expect.stringContaining(`/actions/runs/${RUN_ID}/artifacts`),
    );
  });

  it("selects a successful exact-candidate Images run beyond the first API page", async () => {
    const laterRunId = RUN_ID + 200;
    const failedRuns = Array.from({ length: 100 }, (_, index) =>
      workflowRunRecord({ conclusion: "failure", id: RUN_ID + index }),
    );
    const request = vi.fn(
      candidateRequest({
        artifactRunId: laterRunId,
        imageChanged: true,
        runPages: [
          { total_count: 101, workflow_runs: failedRuns },
          {
            total_count: 101,
            workflow_runs: [workflowRunRecord({ id: laterRunId })],
          },
        ],
      }),
    );

    await expect(
      resolvePrManagedImageCatalog(resolverInput(), request, (identity) =>
        downloadContract(identity, `ghrun-${laterRunId}-1`),
      ),
    ).resolves.toBe("candidate-catalog");
    expect(request).toHaveBeenCalledWith(expect.stringContaining("per_page=100&page=2"));
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`/actions/runs/${laterRunId}/artifacts`),
    );
  });

  it("fails closed when the exact-candidate Images run count keeps changing", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      workflowRunRecord({ conclusion: "failure", id: RUN_ID + index }),
    );
    const pages = Array.from({ length: 3 }).flatMap(() => [
      { total_count: 101, workflow_runs: firstPage },
      {
        total_count: 102,
        workflow_runs: [workflowRunRecord({ id: RUN_ID + 200 })],
      },
    ]);
    const fallback = candidateRequest({ imageChanged: true });
    const runsPath = `/repos/${CANONICAL_REPOSITORY}/actions/workflows/managed-images.yaml/runs?event=pull_request&head_sha=${CANDIDATE_SHA}&per_page=100`;

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        (requestPath) =>
          requestPath.startsWith(runsPath) ? Promise.resolve(pages.shift()) : fallback(requestPath),
        downloadContract,
      ),
    ).rejects.toThrow("workflow run total_count changed during 3 pagination attempts");
  });

  it("rejects candidate contracts from another workflow run cohort", async () => {
    const laterRunId = RUN_ID + 10;

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        candidateRequest({
          artifactRunId: laterRunId,
          imageChanged: true,
          run: workflowRun({ id: laterRunId, run_attempt: 2 }),
        }),
        downloadContract,
      ),
    ).rejects.toThrow("producer run does not match the consumer run");
  });

  it("rejects missing or ambiguous exact-candidate Images runs", async () => {
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        candidateRequest({ imageChanged: true, run: { total_count: 0, workflow_runs: [] } }),
        download,
      ),
    ).rejects.toThrow("missing or ambiguous");
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects a substituted artifact producer before content download", async () => {
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        candidateRequest({ artifactHeadSha: "f".repeat(40), imageChanged: true }),
        download,
      ),
    ).rejects.toThrow("artifact producer head does not match");
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects an incomplete exact-candidate artifact set", async () => {
    const download = vi.fn(downloadContract);

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        candidateRequest({ imageChanged: true, missingAgent: "hermes" }),
        download,
      ),
    ).rejects.toThrow("exact artifact identity is missing or ambiguous");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "duplicate paths",
      [treeEntry("Dockerfile.base", "5".repeat(40)), treeEntry("Dockerfile.base", "6".repeat(40))],
      "contains duplicate paths",
    ],
    [
      "invalid type and mode",
      [{ mode: "040000", path: "Dockerfile.base", sha: "5".repeat(40), type: "blob" }],
      "entry mode is invalid",
    ],
  ])("rejects candidate commit trees with %s", async (_label, tree, message) => {
    const request = candidateRequest({ imageChanged: true });
    const candidateTreePath = `/repos/${CANONICAL_REPOSITORY}/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`;

    await expect(
      resolvePrManagedImageCatalog(
        resolverInput(),
        async (requestPath) =>
          requestPath === candidateTreePath
            ? { sha: CANDIDATE_TREE_SHA, tree, truncated: false }
            : request(requestPath),
        downloadContract,
      ),
    ).rejects.toThrow(message);
  });

  it("rejects a workflow run for another pull request", () => {
    expect(() =>
      selectManagedImagePublicationRun(workflowRun({ pull_requests: [{ number: 10_693 }] }), {
        headSha: CANDIDATE_SHA,
        prNumber: PR_NUMBER,
        workflowId: WORKFLOW_ID,
      }),
    ).toThrow("does not match the PR number");
  });

  it("rejects mixed candidate revisions in an all-agent catalog", () => {
    const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map(contract);
    const substituted = {
      ...contracts[0],
      source: { ...contracts[0]!.source, revision: "f".repeat(40) },
    };

    expect(() =>
      assembleManagedImageCatalog([substituted, ...contracts.slice(1)], CANDIDATE_SHA, {
        id: RUN_ID,
        attempt: 1,
      }),
    ).toThrow("do not match the candidate commit");
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

describe("PR managed-image contract reruns", () => {
  it("accepts one producer-owned cohort after a partial producer rerun", () => {
    const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) =>
      contractForCohort(agent, index, `ghrun-${RUN_ID}-1`),
    );

    expect(
      assembleManagedImageCatalog(contracts, CANDIDATE_SHA, { id: RUN_ID, attempt: 2 }),
    ).toEqual(Object.fromEntries(contracts.map((value) => [value.agent, value])));
  });

  it.each([
    [
      "mixed attempts",
      [`ghrun-${RUN_ID}-1`, `ghrun-${RUN_ID}-1`, `ghrun-${RUN_ID}-2`],
      "one publication cohort",
    ],
    ["another run", ["ghrun-7000-1", "ghrun-7000-1", "ghrun-7000-1"], "producer run"],
    [
      "a future attempt",
      [`ghrun-${RUN_ID}-3`, `ghrun-${RUN_ID}-3`, `ghrun-${RUN_ID}-3`],
      "producer attempt",
    ],
  ])("rejects contracts from %s", (_case, cohorts, message) => {
    const contracts = SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) =>
      contractForCohort(agent, index, cohorts[index] as ManagedImageContractV1["source"]["cohort"]),
    );

    expect(() =>
      assembleManagedImageCatalog(contracts, CANDIDATE_SHA, { id: RUN_ID, attempt: 2 }),
    ).toThrow(message);
  });
});
