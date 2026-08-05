// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BASE_SHA,
  coordinationCheck,
  E2E_COORDINATION_EXTERNAL_ID,
  e2eGateCheck,
  exactDiffGateRun,
  HEAD_SHA,
  installerHashRun,
  prWorkflowRun,
  runGate,
  successfulRequiredChecks,
  successfulRequiredChecksWithoutE2e,
} from "./check-gates-test-fixtures.ts";

describe("maintainer merge-gate contributor compliance", () => {
  it("treats a mergeable PR blocked on required review as conflict-free", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.conflicts).toMatchObject({
      pass: true,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
    });
    expect(output.allPass).toBe(true);
  });

  it("fails closed when BLOCKED masks a stale base revision", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        currentBaseSha: "cccccccccccccccccccccccccccccccccccccccc",
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      baseSha: BASE_SHA,
      currentBaseSha: "cccccccccccccccccccccccccccccccccccccccc",
    });
    expect(output.allPass).toBe(false);
  });

  it("fails closed when the current base revision cannot be verified", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        currentBaseSha: null,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      baseSha: BASE_SHA,
    });
    expect(output.gates.conflicts.currentBaseSha).toBeUndefined();
    expect(output.allPass).toBe(false);
  });

  it("fails closed when the base branch changes during gate evaluation", () => {
    const finalCurrentBaseSha = "c".repeat(40);
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalCurrentBaseSha,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      details: "The base SHA changed during gate evaluation. Rerun the gate checker.",
      baseSha: BASE_SHA,
      currentBaseSha: finalCurrentBaseSha,
    });
    expect(output.allPass).toBe(false);
  });

  it("fails closed while GitHub has not determined mergeability", () => {
    const result = runGate({
      body: "Signed-off-by: Example User <user@example.com>",
      verified: true,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });

    const output = JSON.parse(result.stdout);
    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(output.allPass).toBe(false);
  });

  it("fails closed when the PR branch is behind its base branch", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BEHIND",
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["title", { title: "fix(policy): changed during review" }],
    ["body", { body: "DCO declaration removed during review" }],
    ["head", { headRefOid: "c".repeat(40) }],
    ["base", { baseRefOid: "c".repeat(40) }],
    ["base branch", { baseRefName: "release" }],
    ["mergeability", { mergeable: "UNKNOWN" }],
    ["merge state", { mergeStateStatus: "UNKNOWN" }],
  ])("fails closed when the PR %s changes during gate evaluation", (_name, finalPr) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPr,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      details: "PR revision or merge state changed during gate evaluation; rerun the gate checker",
    });
    expect(output.allPass).toBe(false);
  });

  it("performs no remote read after the final PR snapshot", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPrAfterFinalCi: { headRefOid: "c".repeat(40) },
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({
      pass: false,
      details: "PR revision or merge state changed during gate evaluation; rerun the gate checker",
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["closes", { state: "CLOSED" }, "PR is no longer open"],
    ["becomes a draft", { isDraft: true }, "PR became a draft during gate evaluation"],
  ])("fails closed when the PR %s", (_name, finalPr, details) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        finalPr,
      }).stdout,
    );

    expect(output.gates.conflicts).toMatchObject({ pass: false, details });
    expect(output.allPass).toBe(false);
  });

  it("requires checks and changes to come from the same substantive PR CI run", () => {
    const statusChecks = successfulRequiredChecks().map((check) =>
      check.name === "changes"
        ? e2eGateCheck([95, 1, "SUCCESS", undefined, undefined, "CI / Pull Request", "changes"])
        : check,
    );
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks,
        actionRunAttempts: {
          "95": prWorkflowRun("success", [{ id: 1, name: "changes" }], true),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it.each([
    [
      "a stale base in the immutable PR CI title",
      `CI PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
    ],
    [
      "a stale head in the immutable PR CI title",
      `CI PR #42 head ${"c".repeat(40)} base ${BASE_SHA} gate true`,
    ],
    [
      "an unsafe PR number in the immutable PR CI title",
      `CI PR #9007199254740993 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    ],
    [
      "an uppercase SHA in the immutable PR CI title",
      `CI PR #42 head ${HEAD_SHA.toUpperCase()} base ${BASE_SHA} gate true`,
    ],
  ])("rejects %s even when mutable pull_requests claims the current diff", (_name, displayTitle) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
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
            displayTitle,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it("fails closed when immutable PR CI identity changes during job collection", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
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
            nextDisplayTitle: `CI PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({ pass: false });
    expect(output.gates.ci.failingChecks).toEqual(
      expect.arrayContaining([
        "checks: latest attempt evidence incomplete",
        "changes: latest attempt evidence incomplete",
      ]),
    );
  });

  it("rejects a required check emitted by the wrong workflow", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...exactDiffGateRun("success", [{ id: 1, name: "check-hash" }]),
            event: "pull_request",
            path: ".github/workflows/unrelated.yaml",
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("accepts immutable installer identity without relying on retarget timestamps", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            createdAt: "2026-01-01T00:02:00Z",
            updatedAt: "2026-01-01T00:02:00Z",
            pullRequests: [],
          },
        },
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each(["SKIPPED", "NEUTRAL"])("rejects a required Actions run concluded %s", (conclusion) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": installerHashRun(conclusion.toLowerCase(), [{ id: 1, name: "check-hash" }], true),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
    expect(output.allPass).toBe(false);
  });

  it.each(["SKIPPED", "NEUTRAL"])("rejects a required CheckRun concluded %s", (conclusion) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: successfulRequiredChecks().map((check) =>
          check.name === "check-hash" ? { ...check, conclusion } : check,
        ),
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: [`check-hash: ${conclusion}`],
    });
    expect(output.allPass).toBe(false);
  });

  it.each([
    ["a stale base", `Installer Hash PR #42 head ${HEAD_SHA} base ${"c".repeat(40)} gate true`],
    ["a stale head", `Installer Hash PR #42 head ${"c".repeat(40)} base ${BASE_SHA} gate true`],
    [
      "an unsafe PR number",
      `Installer Hash PR #9007199254740993 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    ],
    [
      "an uppercase SHA",
      `Installer Hash PR #42 head ${HEAD_SHA.toUpperCase()} base ${BASE_SHA} gate true`,
    ],
    ["a malformed title", "Installer Hash current diff"],
  ])("rejects check-hash with %s in its immutable title", (_name, displayTitle) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            displayTitle,
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("does not accept a gate-false installer metadata edit as evidence", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": installerHashRun("success", [{ id: 1, name: "check-hash" }], false),
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("rejects installer evidence with a contradictory mutable PR association", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        actionRunAttempts: {
          "91": {
            ...installerHashRun("success", [{ id: 1, name: "check-hash" }], true),
            pullRequests: [
              {
                number: 99,
                head: { sha: HEAD_SHA },
                base: { sha: BASE_SHA },
              },
            ],
          },
        },
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: ["check-hash: latest attempt evidence incomplete"],
    });
  });

  it("accepts the former exact-diff E2E coordination check name during rollout", () => {
    const formerCheck = coordinationCheck({
      id: 8001,
      name: "E2E / PR Gate Coordination",
    });
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: [...successfulRequiredChecksWithoutE2e(), e2eGateCheck([94, 1, "SUCCESS"])],
        coordinationCheckPages: [{ total_count: 0, check_runs: [] }],
        formerCoordinationCheckPages: [{ total_count: 1, check_runs: [formerCheck] }],
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it("finds the exact E2E coordination check on a later page", () => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        statusChecks: successfulRequiredChecks().map((check) =>
          check.name === "E2E / PR Gate"
            ? { ...check, detailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/8002" }
            : check,
        ),
        coordinationCheckPages: [
          {
            total_count: 2,
            check_runs: [coordinationCheck({ id: 8001, external_id: "ordinary-uuid" })],
          },
          { total_count: 2, check_runs: [coordinationCheck({ id: 8002 })] },
        ],
      }).stdout,
    );

    expect(output).toMatchObject({ allPass: true, gates: { ci: { pass: true } } });
  });

  it.each([
    ["missing", [{ total_count: 0, check_runs: [] }]],
    [
      "bound to another diff",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ external_id: `${E2E_COORDINATION_EXTERNAL_ID}-stale` })],
        },
      ],
    ],
    [
      "reported on another head SHA",
      [{ total_count: 1, check_runs: [coordinationCheck({ head_sha: "c".repeat(40) })] }],
    ],
    [
      "claimed by another GitHub App",
      [{ total_count: 1, check_runs: [coordinationCheck({ app: { id: 1234 } })] }],
    ],
    [
      "still running",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ status: "in_progress", conclusion: null })],
        },
      ],
    ],
    [
      "completed with failure",
      [
        {
          total_count: 1,
          check_runs: [coordinationCheck({ status: "completed", conclusion: "failure" })],
        },
      ],
    ],
    [
      "reported with malformed timing",
      [{ total_count: 1, check_runs: [coordinationCheck({ started_at: "not-a-time" })] }],
    ],
    [
      "reported with inverted timing",
      [
        {
          total_count: 1,
          check_runs: [
            coordinationCheck({
              started_at: "2026-01-01T00:02:30Z",
              completed_at: "2026-01-01T00:01:30Z",
            }),
          ],
        },
      ],
    ],
    [
      "duplicated",
      [
        {
          total_count: 2,
          check_runs: [coordinationCheck(), coordinationCheck({ id: 8001 })],
        },
      ],
    ],
    ["from an incomplete page set", [{ total_count: 2, check_runs: [coordinationCheck()] }]],
  ])("fails closed when PR/base SHA E2E coordination evidence is %s", (_name, pages) => {
    const output = JSON.parse(
      runGate({
        body: "Signed-off-by: Example User <user@example.com>",
        verified: true,
        coordinationCheckPages: pages,
      }).stdout,
    );

    expect(output.gates.ci).toMatchObject({
      pass: false,
      failingChecks: [
        "E2E / PR Gate: latest attempt evidence incomplete",
        "initialize: latest attempt evidence incomplete",
      ],
    });
  });
});
