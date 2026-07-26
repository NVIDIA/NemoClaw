// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  exactDiffGateRun,
  HEAD_SHA,
  prWorkflowRun,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate fork evidence", () => {
  it("accepts association-less PR CI with exact immutable diff and head metadata", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        headRepository: "example/fork",
        emptyHeadRepositoryNameWithOwner: true,
        actionRunAttempts: {
          "90": {
            ...prWorkflowRun(
              "success",
              [
                { id: 1, name: "checks" },
                { id: 2, name: "changes" },
              ],
              true,
            ),
            headRepository: "example/fork",
            pullRequests: [],
          },
        },
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it("fails closed when GitHub head repository fields contradict each other", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      headRepository: "example/fork",
      headRepositoryNameWithOwner: "other/fork",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to resolve PR #42 head repository");
  });

  it.each([
    "pull_request",
    "pull_request_target",
  ])("accepts an association-less %s check tied to the exact head metadata", (event) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        headRepository: "example/fork",
        statusChecks: [
          ...successfulRequiredChecks(),
          {
            __typename: "CheckRun",
            name: "optional-check",
            workflowName: "CI / Optional",
            detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/449/job/41",
            startedAt: "2026-01-01T00:00:00Z",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        actionRunAttempts: {
          "449": {
            attempt: 1,
            headSha: HEAD_SHA,
            headBranch: "feature-branch",
            headRepository: "example/fork",
            pullRequests: [],
            event,
            path: ".github/workflows/optional.yaml",
            status: "completed",
            conclusion: "success",
            jobs: [{ id: 41, name: "optional-check" }],
          },
        },
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each([
    ["head SHA", { headSha: "c".repeat(40) }],
    ["head branch", { headBranch: "other-branch" }],
    ["head repository", { headRepository: "other/fork" }],
  ])("rejects association-less evidence with another %s", (_name, override) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        headRepository: "example/fork",
        statusChecks: [
          ...successfulRequiredChecks(),
          {
            __typename: "CheckRun",
            name: "optional-check",
            workflowName: "CI / Optional",
            detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/449/job/41",
            startedAt: "2026-01-01T00:00:00Z",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        actionRunAttempts: {
          "449": {
            attempt: 1,
            headSha: HEAD_SHA,
            headBranch: "feature-branch",
            headRepository: "example/fork",
            pullRequests: [],
            event: "pull_request",
            path: ".github/workflows/optional.yaml",
            status: "completed",
            conclusion: "success",
            jobs: [{ id: 41, name: "optional-check" }],
            ...override,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["optional-check: latest attempt evidence incomplete"],
    });
  });

  it("does not use association-less head metadata for an internal PR", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: [
          ...successfulRequiredChecks(),
          {
            __typename: "CheckRun",
            name: "optional-check",
            workflowName: "CI / Optional",
            detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/449/job/41",
            startedAt: "2026-01-01T00:00:00Z",
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
        actionRunAttempts: {
          "449": {
            attempt: 1,
            headSha: HEAD_SHA,
            headBranch: "feature-branch",
            headRepository: "NVIDIA/NemoClaw",
            pullRequests: [],
            event: "pull_request",
            path: ".github/workflows/optional.yaml",
            status: "completed",
            conclusion: "success",
            jobs: [{ id: 41, name: "optional-check" }],
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["optional-check: latest attempt evidence incomplete"],
    });
  });

  it("does not let association-less head metadata bypass E2E coordination", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        headRepository: "example/fork",
        coordinationCheckPages: [{ total_count: 0, check_runs: [] }],
        actionRunAttempts: {
          "94": {
            ...exactDiffGateRun("success", [{ id: 1, name: "E2E / PR Gate" }]),
            headRepository: "example/fork",
            pullRequests: [],
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["E2E / PR Gate: latest attempt evidence incomplete"],
    });
  });
});
