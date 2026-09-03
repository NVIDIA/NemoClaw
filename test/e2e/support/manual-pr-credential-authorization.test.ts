// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readE2eOperationsWorkflow } from "../../../tools/e2e/operations-workflow-boundary.mts";

describe("manual PR E2E credential authorization", () => {
  it.each([
    {
      caseName: "matching repository and requested SHAs",
      checkoutRepository: "NVIDIA/NemoClaw",
      nvidiaOwned: true,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: true,
      workflowShaMatches: true,
      expectedAllowed: true,
    },
    {
      caseName: "an NVIDIA-owned sibling repository",
      checkoutRepository: "NVIDIA/NemoClaw-E2E",
      nvidiaOwned: true,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: true,
      workflowShaMatches: true,
      expectedAllowed: true,
    },
    {
      caseName: "a checkout repository outside NVIDIA",
      checkoutRepository: "contributor/NemoClaw",
      nvidiaOwned: false,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: true,
      workflowShaMatches: true,
      expectedAllowed: false,
    },
    {
      caseName: "a workflow repository outside NVIDIA/NemoClaw",
      checkoutRepository: "NVIDIA/NemoClaw",
      nvidiaOwned: true,
      workflowRepository: "contributor/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: true,
      workflowShaMatches: true,
      expectedAllowed: false,
    },
    {
      caseName: "checkout_sha differs from the checked-out commit",
      checkoutRepository: "NVIDIA/NemoClaw",
      nvidiaOwned: true,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: false,
      workflowShaMatches: true,
      expectedAllowed: false,
    },
    {
      caseName: "a requested workflow SHA that differs from the running workflow",
      checkoutRepository: "NVIDIA/NemoClaw",
      nvidiaOwned: true,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/main",
      checkoutShaMatches: true,
      workflowShaMatches: false,
      expectedAllowed: false,
    },
    {
      caseName: "a non-main workflow ref with otherwise matching identities",
      checkoutRepository: "NVIDIA/NemoClaw",
      nvidiaOwned: true,
      workflowRepository: "NVIDIA/NemoClaw",
      workflowRef: "refs/heads/pr-controlled-workflow",
      checkoutShaMatches: true,
      workflowShaMatches: true,
      expectedAllowed: false,
    },
  ])(
    "sets E2E credential access to $expectedAllowed for $caseName (#9047)",
    ({
      checkoutRepository,
      nvidiaOwned,
      workflowRepository,
      workflowRef,
      checkoutShaMatches,
      workflowShaMatches,
      expectedAllowed,
    }) => {
      const workflow = readE2eOperationsWorkflow();
      const credentialAuthorization = workflow.jobs["generate-matrix"].steps!.find(
        (step) => step.name === "Authorize E2E credentials",
      )!;
      const checkedOutSha = spawnSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim();
      const checkoutSha = checkoutShaMatches ? checkedOutSha : "0".repeat(40);
      const workflowSha = "c".repeat(40);
      const expectedWorkflowSha = workflowShaMatches ? workflowSha : "d".repeat(40);
      const directory = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-credentials-"));
      const output = join(directory, "output");

      try {
        writeFileSync(output, "");
        const result = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", credentialAuthorization.run!],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              CHECKOUT_REPOSITORY: checkoutRepository,
              CHECKOUT_SHA: checkoutSha,
              EVENT_NAME: "workflow_dispatch",
              EXPECTED_WORKFLOW_SHA: expectedWorkflowSha,
              GITHUB_OUTPUT: output,
              NVIDIA_OWNED: nvidiaOwned ? "true" : "false",
              REF: workflowRef,
              WORKFLOW_REPOSITORY: workflowRepository,
              WORKFLOW_SHA: workflowSha,
            },
          },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(
          `allowed=${expectedAllowed ? "true" : "false"}\n`,
        );
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );
});
