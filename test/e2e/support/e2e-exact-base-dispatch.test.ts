// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readE2eOperationsWorkflow } from "../../../tools/e2e/operations-workflow-boundary.mts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";

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
      "::error::exact-base E2E must use the trusted main workflow\n",
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
      const workflow = readE2eOperationsWorkflow();
      const authentication = workflow.jobs["generate-matrix"].steps!.find(
        (step) => step.name === "Authenticate manual PR dispatch",
      )!;
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const workflowSha = "c".repeat(40);
      const prefix = [
        "curl() {",
        `  printf '%s' '{"state":"open","head":{"repo":{"full_name":"${headRepository}","owner":{"login":"NVIDIA","type":"Organization"}},"sha":"${headSha}"},"base":{"repo":{"full_name":"NVIDIA/NemoClaw"},"ref":"main","sha":"${baseSha}"}}'`,
        "}",
      ].join("\n");
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${prefix}\n${authentication.run}`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
            ALLOW_JETSON_DISPATCH: "false",
            BASE_SHA: baseSha,
            CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
            CHECKOUT_SHA: checkoutCharacter.repeat(40),
            EXPECTED_WORKFLOW_SHA: workflowSha,
            GITHUB_OUTPUT: "/dev/null",
            GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
            INCLUDE_LAUNCHABLE: "false",
            JOBS: jobs,
            PR_NUMBER: "42",
            REVISION: "base",
            TARGETS: "",
            WORKFLOW_EVENT: "workflow_dispatch",
            WORKFLOW_REF: workflowRef,
            WORKFLOW_SHA: workflowSha,
          },
        },
      );

      expect(result.status, caseName).toBe(status);
      expect(result.stderr).toBe(stderr);
    },
  );

  it("revalidates the exact PR base and original head after checkout", () => {
    const workflow = readE2eOperationsWorkflow();
    const validation = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Validate manual PR checkout",
    )!;
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const prefix = [
      "git() { printf '%s\\n' \"$CHECKOUT_SHA\"; }",
      "curl() {",
      `  printf '%s' '{"state":"open","head":{"repo":{"full_name":"NVIDIA/NemoClaw","owner":{"login":"NVIDIA","type":"Organization"}},"sha":"${headSha}"},"base":{"repo":{"full_name":"NVIDIA/NemoClaw"},"ref":"main","sha":"${baseSha}"}}'`,
      "}",
    ].join("\n");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${prefix}\n${validation.run}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BASE_SHA: baseSha,
          CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
          CHECKOUT_SHA: baseSha,
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          NVIDIA_OWNED: "true",
          PR_HEAD_SHA: headSha,
          PR_NUMBER: "42",
          REVISION: "base",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
