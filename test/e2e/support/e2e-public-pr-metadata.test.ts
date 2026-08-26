// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

function authenticationEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BASE_SHA: "b".repeat(40),
    CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
    CHECKOUT_SHA: "a".repeat(40),
    EXPECTED_WORKFLOW_SHA: "c".repeat(40),
    GITHUB_OUTPUT: "/dev/null",
    GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
    INCLUDE_LAUNCHABLE: "false",
    JOBS: "",
    PR_NUMBER: "42",
    WORKFLOW_EVENT: "workflow_dispatch",
    WORKFLOW_REF: "refs/heads/main",
    WORKFLOW_SHA: "c".repeat(40),
  };
}

describe("public PR metadata authentication", () => {
  it("does not widen workflow token permissions", () => {
    const workflow = readE2eOperationsWorkflow();
    const authentication = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Authenticate manual PR dispatch",
    )!;
    const validation = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Validate manual PR checkout",
    )!;

    expect(authentication.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(validation.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(authentication.run).not.toContain("Authorization:");
    expect(validation.run).not.toContain("Authorization:");

    authentication.env!.GITHUB_TOKEN = "${{ github.token }}";
    authentication.run = `${authentication.run}\ncurl --header "Authorization: Bearer token"`;
    validation.env!.GITHUB_TOKEN = "${{ github.token }}";
    validation.run = `${validation.run}\ncurl --header "Authorization: Bearer token"`;

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "Manual PR authentication must use the public read-only metadata endpoint",
        "Manual PR checkout validation must use the public read-only metadata endpoint",
      ]),
    );
  });

  it.each([
    ["denied response", "curl() { return 22; }"],
    ["malformed response", "curl() { printf '{'; }"],
  ])("fails closed on a terminal %s", (_caseName, curlStub) => {
    const workflow = readE2eOperationsWorkflow();
    const authentication = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Authenticate manual PR dispatch",
    )!;
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${curlStub}\n${authentication.run}`],
      { encoding: "utf8", env: authenticationEnvironment() },
    );

    expect(result.status).not.toBe(0);
  });
});
