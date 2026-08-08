// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BASE_SHA,
  HEAD_SHA,
  openshellQualificationRun,
  requiredCheck,
  runGate,
  successfulRequiredChecks,
} from "./check-gates-test-fixtures.ts";

function qualificationCheck(
  runId: number,
  jobId: number,
  startedAt: string,
  appId: number | null = null,
) {
  return {
    ...requiredCheck("openshell-qualification"),
    appId: appId ?? undefined,
    detailsUrl: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
    startedAt,
  };
}

function fixtureForRun(
  runId: number,
  run: ReturnType<typeof openshellQualificationRun>,
  appId: number | null = null,
) {
  return {
    body: "Signed-off-by: Example User <user@example.com>",
    verified: true,
    statusChecks: [
      ...successfulRequiredChecks().filter((check) => check.name !== "openshell-qualification"),
      qualificationCheck(runId, 1, "2026-01-01T00:02:00Z", appId),
    ],
    actionRunAttempts: { [String(runId)]: run },
  };
}

describe("maintainer OpenShell qualification gate evidence", () => {
  it("accepts the exact base-executed required workflow for a current PR (#8600)", () => {
    const result = runGate(
      fixtureForRun(
        195,
        openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      ),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it("accepts a base-executed non-sensitive fork result without candidate-run identity (#8600)", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      headRepository: "contributor/NemoClaw",
      verified: true,
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      allPass: true,
      gates: { ci: { pass: true } },
    });
  });

  it.each([
    [
      "PR number",
      {
        displayTitle: `OpenShell Qualification PR #41 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
      },
    ],
    [
      "candidate SHA",
      {
        displayTitle: `OpenShell Qualification PR #42 head ${BASE_SHA} base ${BASE_SHA} gate true`,
      },
    ],
    [
      "base SHA",
      {
        displayTitle: `OpenShell Qualification PR #42 head ${HEAD_SHA} base ${HEAD_SHA} gate true`,
      },
    ],
    [
      "gate disposition",
      {
        displayTitle: `OpenShell Qualification PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate false`,
      },
    ],
    ["event", { event: "pull_request" }],
    ["workflow path", { path: ".github/workflows/untrusted.yaml" }],
    ["base controller SHA", { headSha: HEAD_SHA }],
    ["base branch", { headBranch: "not-main" }],
    ["base repository", { headRepository: "attacker/NemoClaw" }],
  ])("rejects a qualification run with mismatched %s evidence (#8600)", (_label, override) => {
    const run = {
      ...openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      ...override,
    };
    const output = JSON.parse(runGate(fixtureForRun(196, run)).stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });

  it("rejects a qualification context produced by another GitHub App (#8600)", () => {
    const run = {
      ...openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      appId: 42,
    };
    const output = JSON.parse(runGate(fixtureForRun(197, run, 42)).stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });

  it("rejects a qualification CheckRun without exact GitHub Actions App identity (#8600)", () => {
    const run = {
      ...openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      appId: null,
    };
    const output = JSON.parse(runGate(fixtureForRun(201, run, null)).stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });

  it("rejects a forged qualification StatusContext (#8600)", () => {
    const run = openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]);
    const fixture = fixtureForRun(202, run);
    const statusChecks = fixture.statusChecks.map((check) =>
      check.name === "openshell-qualification"
        ? {
            __typename: "StatusContext",
            context: "openshell-qualification",
            detailsUrl: check.detailsUrl,
            startedAt: check.startedAt,
            state: "SUCCESS",
          }
        : check,
    );
    const output = JSON.parse(runGate({ ...fixture, statusChecks }).stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });

  it("rejects a run whose latest attempt changes during authentication (#8600)", () => {
    const run = {
      ...openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      nextAttempt: 2,
    };
    const output = JSON.parse(runGate(fixtureForRun(198, run)).stdout);

    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });

  it("does not let a newer duplicate context from another workflow replace exact evidence (#8600)", () => {
    const legitimate = {
      ...openshellQualificationRun("success", [{ id: 1, name: "openshell-qualification" }]),
      createdAt: "2026-01-01T00:01:00Z",
    };
    const duplicate = {
      ...openshellQualificationRun("success", [{ id: 2, name: "openshell-qualification" }]),
      createdAt: "2026-01-01T00:02:00Z",
      path: ".github/workflows/untrusted.yaml",
    };
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      statusChecks: [
        ...successfulRequiredChecks().filter((check) => check.name !== "openshell-qualification"),
        qualificationCheck(199, 1, "2026-01-01T00:01:00Z"),
        qualificationCheck(200, 2, "2026-01-01T00:02:00Z"),
      ],
      actionRunAttempts: { "199": legitimate, "200": duplicate },
    });

    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ allPass: false, gates: { ci: { pass: false } } });
    expect(output.gates.ci.failingChecks).toContain(
      "openshell-qualification: latest attempt evidence incomplete",
    );
  });
});
