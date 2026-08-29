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
  managedImagePublicationReuseAllowed,
  parseManagedImagePullRequestPaths,
  parseManagedImagePublicationComparison,
  selectManagedImagePublicationRun,
} from "../../../tools/e2e/pr-managed-image-publication.mts";

const CANDIDATE_SHA = "a".repeat(40);
const PR_NUMBER = 8746;
const WORKFLOW_ID = 12345;
const MANAGED_IMAGE_DOCKERFILES = [
  "Dockerfile",
  "Dockerfile.base",
  "agents/hermes/Dockerfile",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile.base",
] as const;

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

  it("allows reuse only across host-installer and E2E-only changes", () => {
    expect(
      managedImagePublicationReuseAllowed([
        "ci/test-file-size-budget.json",
        ".github/actions/restore-e2e-cli-artifact/action.yaml",
        ".github/actions/setup-native-podman-e2e/action.yaml",
        ".github/workflows/e2e-standard-profile.yaml",
        ".github/workflows/e2e.yaml",
        "scripts/install.sh",
        "scripts/checks/run-managed-image-openshell-e2e.ts",
        "src/lib/actions/maintenance.test.ts",
        "src/lib/actions/maintenance.ts",
        "src/lib/actions/sandbox/connect-probe-observe.test.ts",
        "src/lib/actions/sandbox/gateway-failure-classifier.test.ts",
        "src/lib/actions/sandbox/gateway-failure-classifier.ts",
        "src/lib/actions/sandbox/launch-readiness-ordinary-pairing.test.ts",
        "src/lib/actions/sandbox/process-recovery.ts",
        "src/lib/actions/sandbox/mcp-bridge-input-targets.test.ts",
        "src/lib/actions/sandbox/mcp-bridge-tool-discovery.test.ts",
        "src/lib/actions/sandbox/mcp-bridge-tool-discovery.ts",
        "src/lib/actions/sandbox/stopped-sandbox-backup.test.ts",
        "src/lib/actions/sandbox/stopped-sandbox-backup.ts",
        "src/lib/actions/sandbox/status-preflight.ts",
        "src/lib/adapters/podman/index.test.ts",
        "src/lib/adapters/podman/index.ts",
        "src/lib/inference/serving/profile-list.test.ts",
        "src/lib/shields/index.ts",
        "src/lib/shields/state-dir-lock.test.ts",
        "src/lib/onboard/credential-provider-registration.test.ts",
        "src/lib/onboard/credential-provider-registration.ts",
        "src/lib/onboard/managed-bootstrap/docker-runtime.test.ts",
        "src/lib/onboard/managed-bootstrap/docker-runtime.ts",
        "src/lib/onboard/managed-bootstrap/podman-bootstrap-replacement.test.ts",
        "src/lib/onboard/managed-bootstrap/podman-bootstrap-replacement.ts",
        "src/lib/onboard/managed-bootstrap/podman-image-transaction.test.ts",
        "src/lib/onboard/managed-bootstrap/podman-image-transaction.ts",
        "src/lib/onboard/managed-bootstrap/podman-runtime.test.ts",
        "src/lib/onboard/managed-bootstrap/podman-runtime.ts",
        "src/lib/onboard/managed-bootstrap/runtime-create.ts",
        "src/lib/onboard/managed-startup/state-roots.ts",
        "src/lib/onboard/managed-workload/onboard-orchestration.test.ts",
        "src/lib/onboard/managed-workload/onboard-orchestration.ts",
        "src/lib/onboard/machine/finalization-deps.test.ts",
        "src/lib/onboard/machine/finalization-deps.ts",
        "src/lib/onboard/machine/messaging-credential-convergence.test.ts",
        "src/lib/onboard/machine/messaging-credential-convergence.ts",
        "src/lib/onboard/runtime-provider/docker-state-mutation.ts",
        "src/lib/onboard/runtime-provider/podman-host-local-inference-cleanup-settlement.test.ts",
        "src/lib/onboard/runtime-provider/podman-host-local-inference.ts",
        "src/lib/onboard/runtime-provider/podman-runtime-surfaces.ts",
        "src/lib/onboard/runtime-provider/podman-state-mutation.test.ts",
        "src/lib/onboard/runtime-provider/podman-state-mutation.ts",
        "src/lib/onboard/sandbox-create/orchestration.ts",
        "src/lib/onboard/sandbox-gpu-create-flow.test.ts",
        "src/lib/onboard/sandbox-gpu-create-flow.ts",
        "src/lib/onboard/sandbox-gpu-create-run-attempt.ts",
        "src/lib/onboard/sandbox-workload-preparation.test.ts",
        "src/lib/onboard/workload/preparation.ts",
        "test/e2e/fixtures/security-posture.ts",
        "test/install-preflight-docker-bootstrap.test.ts",
        "tools/e2e/target-catalogue.mts",
      ]),
    ).toBe(true);
    expect(managedImagePublicationReuseAllowed(["scripts/managed-gateway-control.py"])).toBe(false);
    expect(managedImagePublicationReuseAllowed(["src/lib/onboard/workload/rebuild.ts"])).toBe(
      false,
    );
  });

  it.each(MANAGED_IMAGE_DOCKERFILES)("keeps reusable paths outside %s", (dockerfile) => {
    const source = fs.readFileSync(dockerfile, "utf8");
    expect(source).not.toContain("restore-e2e-cli-artifact");
    expect(source).not.toContain("scripts/install.sh");
    expect(source).not.toContain("scripts/checks/run-managed-image-openshell-e2e.ts");
    expect(source).not.toContain("src/lib/actions/maintenance.ts");
    expect(source).not.toContain("src/lib/actions/sandbox/process-recovery.ts");
    expect(source).not.toContain("src/lib/actions/sandbox/gateway-failure-classifier.ts");
    expect(source).not.toContain("src/lib/actions/sandbox/status-preflight.ts");
    expect(source).not.toContain("src/lib/actions/sandbox/mcp-bridge-tool-discovery.ts");
    expect(source).not.toContain("src/lib/actions/sandbox/stopped-sandbox-backup.ts");
    expect(source).not.toContain("src/lib/adapters/podman/index.ts");
    expect(source).not.toContain("src/lib/onboard/credential-provider-registration.ts");
    expect(source).not.toContain("src/lib/onboard/managed-bootstrap/docker-runtime.ts");
    expect(source).not.toContain("src/lib/onboard/machine/finalization-deps.ts");
    expect(source).not.toContain("src/lib/onboard/machine/messaging-credential-convergence.ts");
    expect(source).not.toContain(
      "src/lib/onboard/managed-bootstrap/podman-bootstrap-replacement.ts",
    );
    expect(source).not.toContain("src/lib/onboard/managed-bootstrap/podman-image-transaction.ts");
    expect(source).not.toContain("src/lib/onboard/managed-bootstrap/podman-runtime.ts");
    expect(source).not.toContain("src/lib/onboard/managed-bootstrap/runtime-create.ts");
    expect(source).not.toContain("src/lib/onboard/managed-startup/state-roots.ts");
    expect(source).not.toContain("src/lib/onboard/managed-workload/onboard-orchestration.ts");
    expect(source).not.toContain("src/lib/onboard/sandbox-create/orchestration.ts");
    expect(source).not.toContain("src/lib/onboard/sandbox-gpu-create-flow.ts");
    expect(source).not.toContain("src/lib/onboard/sandbox-gpu-create-run-attempt.ts");
    expect(source).not.toContain("src/lib/onboard/workload/preparation.ts");
    expect(source).not.toMatch(/^COPY [.]github\/workflows\/e2e/mu);
    expect(source).not.toMatch(/^COPY src\/lib\/onboard\/.*[.]test[.]ts/mu);
    expect(source).not.toMatch(/^COPY test\//mu);
    expect(source).not.toMatch(/^COPY tools\/e2e\//mu);
  });

  it("accepts one complete ancestor comparison with only reusable changes", () => {
    const publicationSha = "b".repeat(40);
    expect(
      parseManagedImagePublicationComparison(
        {
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
          total_commits: 2,
          base_commit: { sha: publicationSha },
          merge_base_commit: { sha: publicationSha },
          commits: [{ sha: "c".repeat(40) }, { sha: CANDIDATE_SHA }],
          files: [
            { filename: "scripts/install.sh" },
            { filename: "test/e2e/support/security-posture.test.ts" },
          ],
        },
        { candidateSha: CANDIDATE_SHA, publicationSha },
      ),
    ).toEqual({
      changedFiles: ["scripts/install.sh", "test/e2e/support/security-posture.test.ts"],
      commits: 2,
    });
  });

  it("rejects reuse when a managed-image input changed", () => {
    const publicationSha = "b".repeat(40);
    expect(() =>
      parseManagedImagePublicationComparison(
        {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          base_commit: { sha: publicationSha },
          merge_base_commit: { sha: publicationSha },
          commits: [{ sha: CANDIDATE_SHA }],
          files: [{ filename: "agents/hermes/Dockerfile" }],
        },
        { candidateSha: CANDIDATE_SHA, publicationSha },
      ),
    ).toThrow("changes managed-image inputs");
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
