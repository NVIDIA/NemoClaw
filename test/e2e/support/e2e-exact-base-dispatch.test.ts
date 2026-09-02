// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";

const MANUAL_PR_DISPATCH_SCRIPT = path.join(process.cwd(), "scripts/e2e/manual-pr-dispatch.sh");
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function pullRequest(headRepository: string, headSha: string, baseSha: string): string {
  return JSON.stringify({
    state: "open",
    head: {
      repo: { full_name: headRepository, owner: { login: "NVIDIA", type: "Organization" } },
      sha: headSha,
    },
    base: { repo: { full_name: "NVIDIA/NemoClaw" }, ref: "main", sha: baseSha },
  });
}

describe("exact-base E2E dispatch", testTimeoutOptions(15_000), () => {
  it.each([
    [
      "the exact PR base",
      "b",
      "NVIDIA/NemoClaw",
      "refs/heads/main",
      "managed-image-protected-runtime",
      0,
      "",
    ],
    [
      "a substituted base SHA",
      "a",
      "NVIDIA/NemoClaw",
      "refs/heads/main",
      "managed-image-protected-runtime",
      1,
      "::error::base checkout_sha must match the exact PR base SHA\n",
    ],
    [
      "an empty selector",
      "b",
      "NVIDIA/NemoClaw",
      "refs/heads/main",
      "",
      1,
      "::error::exact-base E2E requires the failed candidate selector\n",
    ],
    [
      "a PR-controlled workflow",
      "b",
      "NVIDIA/NemoClaw",
      "refs/heads/candidate",
      "managed-image-protected-runtime",
      1,
      "::error::Manual PR E2E must be dispatched from the trusted main branch\n",
    ],
    [
      "a fork PR",
      "b",
      "contributor/NemoClaw",
      "refs/heads/main",
      "managed-image-protected-runtime",
      1,
      "::error::exact-base E2E requires a same-repository PR\n",
    ],
    [
      "a candidate-only evidence producer",
      "b",
      "NVIDIA/NemoClaw",
      "refs/heads/main",
      "managed-image-protected-runtime,native-runtime-qualification-producer",
      1,
      "::error::native runtime qualification evidence is candidate-only\n",
    ],
    [
      "a staging Launchable selector",
      "b",
      "NVIDIA/NemoClaw",
      "refs/heads/main",
      "managed-image-protected-runtime,staging-brev-launchable",
      1,
      "::error::exact-base E2E cannot select staging Launchable\n",
    ],
  ] as const)(
    "authenticates %s",
    (caseName, checkoutCharacter, headRepository, workflowRef, jobs, status, stderr) => {
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const workflowSha = "c".repeat(40);
      const result = spawnSync("bash", [MANUAL_PR_DISPATCH_SCRIPT, "authenticate"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
          ALLOW_JETSON_DISPATCH: "false",
          BASE_SHA: baseSha,
          CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
          CHECKOUT_SHA: checkoutCharacter.repeat(40),
          CORRELATION_ID,
          EXPECTED_WORKFLOW_SHA: workflowSha,
          GITHUB_OUTPUT: "/dev/null",
          INCLUDE_LAUNCHABLE: "false",
          JOBS: jobs,
          PR_NUMBER: "42",
          PULL_JSON: pullRequest(headRepository, headSha, baseSha),
          REVISION: "base",
          TARGETS: "",
          WORKFLOW_EVENT: "workflow_dispatch",
          WORKFLOW_REF: workflowRef,
          WORKFLOW_SHA: workflowSha,
        },
      });

      expect(result.status, caseName).toBe(status);
      expect(result.stderr).toBe(stderr);
    },
  );

  it.each([
    ["an empty value", "", 1, "::error::correlation_id must be a lowercase UUIDv4\n"],
    ["a malformed value", "run-42", 1, "::error::correlation_id must be a lowercase UUIDv4\n"],
    ["a UUIDv4", CORRELATION_ID, 0, ""],
  ] as const)(
    "requires %s for manual PR correlation",
    (_caseName, correlationId, expectedStatus, expectedError) => {
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const workflowSha = "c".repeat(40);
      const result = spawnSync("bash", [MANUAL_PR_DISPATCH_SCRIPT, "authenticate"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
          ALLOW_JETSON_DISPATCH: "false",
          BASE_SHA: baseSha,
          CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
          CHECKOUT_SHA: baseSha,
          CORRELATION_ID: correlationId,
          EXPECTED_WORKFLOW_SHA: workflowSha,
          GITHUB_OUTPUT: "/dev/null",
          INCLUDE_LAUNCHABLE: "false",
          JOBS: "managed-image-protected-runtime",
          PR_NUMBER: "42",
          PULL_JSON: pullRequest("NVIDIA/NemoClaw", headSha, baseSha),
          REVISION: "base",
          TARGETS: "",
          WORKFLOW_EVENT: "workflow_dispatch",
          WORKFLOW_REF: "refs/heads/main",
          WORKFLOW_SHA: workflowSha,
        },
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.stderr).toBe(expectedError);
    },
  );

  it.each([
    {
      caseName: "the unchanged exact base and original head",
      checkoutCharacter: "b",
      currentBaseCharacter: "b",
      currentHeadCharacter: "a",
      expectedError: "",
      expectedStatus: 0,
    },
    {
      caseName: "a mismatched checkout",
      checkoutCharacter: "d",
      currentBaseCharacter: "b",
      currentHeadCharacter: "a",
      expectedError: "::error::checked-out commit does not match checkout_sha\n",
      expectedStatus: 1,
    },
    {
      caseName: "a changed PR base",
      checkoutCharacter: "b",
      currentBaseCharacter: "d",
      currentHeadCharacter: "a",
      expectedError: "::error::base_sha changed before execution\n",
      expectedStatus: 1,
    },
    {
      caseName: "a changed PR head",
      checkoutCharacter: "b",
      currentBaseCharacter: "b",
      currentHeadCharacter: "d",
      expectedError: "::error::PR head changed before execution\n",
      expectedStatus: 1,
    },
  ])(
    "revalidates $caseName after checkout",
    ({
      checkoutCharacter,
      currentBaseCharacter,
      currentHeadCharacter,
      expectedError,
      expectedStatus,
    }) => {
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const result = spawnSync("bash", [MANUAL_PR_DISPATCH_SCRIPT, "validate-checkout"], {
        encoding: "utf8",
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CHECKED_OUT_SHA: checkoutCharacter.repeat(40),
          CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
          CHECKOUT_SHA: baseSha,
          NVIDIA_OWNED: "true",
          PR_HEAD_SHA: headSha,
          PULL_JSON: pullRequest(
            "NVIDIA/NemoClaw",
            currentHeadCharacter.repeat(40),
            currentBaseCharacter.repeat(40),
          ),
          REVISION: "base",
        },
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.stderr).toBe(expectedError);
    },
  );

  it.each(["candidate", "base"])(
    "resolves the approved external target set for a %s request",
    (revision) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-controller-matrix-"));
      const output = path.join(directory, "output");
      try {
        const result = spawnSync("bash", [MANUAL_PR_DISPATCH_SCRIPT, "controller-matrix"], {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            JOBS: "",
            REVISION: revision,
            TARGETS:
              "ubuntu-repo-cloud-langchain-deepagents-code,ubuntu-repo-docker-post-reboot-recovery",
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(output, "utf8")).toBe(
          'matrix=[{"id":"ubuntu-repo-cloud-langchain-deepagents-code","runner":"ubuntu-latest","label":"ubuntu-repo-cloud-langchain-deepagents-code"},{"id":"ubuntu-repo-docker-post-reboot-recovery","runner":"ubuntu-latest","label":"ubuntu-repo-docker-post-reboot-recovery"}]\ntest_matrix=[]\n',
        );
      } finally {
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("rejects an external target outside the trusted controller allowlist", () => {
    const result = spawnSync("bash", [MANUAL_PR_DISPATCH_SCRIPT, "controller-matrix"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: "/dev/null",
        JOBS: "",
        TARGETS: "managed-image-protected-runtime",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "::error::PR E2E target is not approved by the trusted controller\n",
    );
  });
});
