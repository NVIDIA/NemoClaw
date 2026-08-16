// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildUnitGapReport,
  classifyFailureSignature,
  extractJobSignatures,
  formatUnitGapReport,
  normalizeFailureSignature,
  type RunLogEvidence,
} from "../../../tools/e2e/unit-test-gaps-core.mts";
import {
  failedRunLogArgs,
  listRunsArgs,
  requireCompleteRunSelection,
  rollingRange,
} from "../../../tools/e2e/unit-test-gaps.mts";

function evidence(overrides: Partial<RunLogEvidence> = {}): RunLogEvidence {
  return {
    log: "job\tstep\t2026-08-12T10:00:00.0000000Z AssertionError: expected UPGRADE, received 400\n",
    run: {
      attempt: 1,
      conclusion: "failure",
      createdAt: "2026-08-12T10:00:00Z",
      databaseId: 12345678,
      event: "push",
      headBranch: "main",
      headSha: "1234567890abcdef1234567890abcdef12345678",
      name: "E2E main",
      status: "completed",
      url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    },
    ...overrides,
  };
}

describe("weekly E2E unit-test gap analysis", () => {
  it("redacts volatile identifiers, paths, URLs, sandboxes, and durations", () => {
    const signature = normalizeFailureSignature(
      "Error: sandbox e2e-sbx-a at /home/runner/work/NemoClaw failed after 180000ms for 1234567890abcdef1234567890abcdef12345678 via https://example.test/path?token=secret",
    );

    expect(signature).toBe(
      "Error: sandbox <sandbox> at <path> failed after <duration> for <sha> via <url>",
    );
    expect(signature).not.toContain("secret");
  });

  it("redacts credential-shaped values before writing a cause candidate", () => {
    const signature = normalizeFailureSignature(
      "Error: Authorization: Bearer ghp_EXAMPLE012345678901234 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE session=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl",
    );

    expect(signature).toBe(
      "Error: Authorization: Bearer <REDACTED> AWS_ACCESS_KEY_ID=<REDACTED> session=<REDACTED>",
    );
    expect(signature).not.toContain("EXAMPLE");
  });

  it("uses an exact rolling window for --days", () => {
    expect(rollingRange(7, new Date("2026-08-16T19:30:00.000Z"))).toEqual({
      from: "2026-08-09T19:30:00.000Z",
      to: "2026-08-16T19:30:00.000Z",
    });
  });

  it("rejects a run selection that may have reached the collection limit", () => {
    expect(() => requireCompleteRunSelection("e2e.yaml", 999)).not.toThrow();
    expect(() => requireCompleteRunSelection("e2e.yaml", 1000)).toThrow(
      "e2e.yaml reached the 1000-run collection limit, so the selected range may be incomplete. Narrow --since or --days and retry.",
    );
  });

  it("binds workflow and failed-log reads to the canonical repository", () => {
    expect(
      listRunsArgs("e2e.yaml", {
        from: "2026-08-09T20:00:00.000Z",
        to: "2026-08-16T20:00:00.000Z",
      }),
    ).toEqual([
      "run",
      "list",
      "--repo",
      "NVIDIA/NemoClaw",
      "--workflow",
      "e2e.yaml",
      "--branch",
      "main",
      "--event",
      "push",
      "--created",
      "2026-08-09T20:00:00.000Z..2026-08-16T20:00:00.000Z",
      "--limit",
      "1000",
      "--json",
      "attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,name,status,url",
    ]);
    expect(failedRunLogArgs(12345678)).toEqual([
      "run",
      "view",
      "12345678",
      "--repo",
      "NVIDIA/NemoClaw",
      "--log-failed",
    ]);
  });

  it("groups volatile BuildKit references under the missing build-input contract", () => {
    expect(
      normalizeFailureSignature(
        'ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref 12345678-1234-4234-9234-123456789abc::sztmu18osbm95fj41qvxlgdie: "/tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle": not found',
      ),
    ).toBe("ERROR: reviewed runtime bundle is missing from the image build context");
  });

  it("uses the earliest high-specificity causal line and ignores wrappers and echoed shell", () => {
    const signatures = extractJobSignatures(
      [
        "portable-launch\tstep\t2026-08-12T10:00:00.0000000Z ##[error]Process completed with exit code 1.",
        'portable-launch\tstep\t2026-08-12T10:00:00.5000000Z echo "::error::a shell guard failed"',
        "portable-launch\tstep\t2026-08-12T10:00:01.0000000Z Error: Portable Podman readiness failed at service activation",
        "rootless-linux\tstep\t2026-08-12T10:00:02.0000000Z npm error code EAI_AGAIN",
      ].join("\n"),
    );

    expect(signatures).toEqual([
      {
        job: "portable-launch",
        signature: "Error: Portable Podman readiness failed at service activation",
      },
      { job: "rootless-linux", signature: "npm error code EAI_AGAIN" },
    ]);
  });

  it("strips terminal controls after a timestamp and preserves an unprefixed message", () => {
    expect(
      extractJobSignatures(
        [
          "online\tstep\t2026-08-12T10:00:00.0000000Z \u001b[31mError: colored failure\u001b[0m",
          "offline\tstep\tError: offline evidence failed",
        ].join("\n"),
      ),
    ).toEqual([
      { job: "online", signature: "Error: colored failure" },
      { job: "offline", signature: "Error: offline evidence failed" },
    ]);
  });

  it("keeps a failed job in the queue when its causal line needs manual review", () => {
    expect(
      extractJobSignatures(
        "job\tstep\t2026-08-12T10:00:00.0000000Z ##[error]Process completed with exit code 1.\n",
      ),
    ).toEqual([{ job: "job", signature: "Failed job log requires manual causal-line review" }]);
  });

  it.each([
    ["AssertionError: expected UPGRADE, received 400", "deterministic"],
    ["npm error code EAI_AGAIN", "external"],
    ["Error: E2E cleanup failed: gateway unavailable", "harness"],
    ["Error: Local BuildKit build failed", "needs-triage"],
  ] as const)("classifies %s as %s", (signature, classification) => {
    expect(classifyFailureSignature(signature)).toBe(classification);
  });

  it("groups the same normalized cause across runs and keeps the required test action", () => {
    const first = evidence();
    const second = evidence({
      run: {
        ...evidence().run,
        databaseId: 23456789,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23456789",
      },
    });
    const report = buildUnitGapReport(
      [first, second],
      { from: "2026-08-09", to: "2026-08-16" },
      "2026-08-16T20:00:00.000Z",
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      classification: "deterministic",
      regressionTest: null,
      reviewStatus: "open",
      runCount: 2,
      runIds: [12345678, 23456789],
    });
    expect(report.groups[0]!.requiredAction).toContain("unit or package-contract regression test");
  });

  it("fails the evidence ledger visibly when a failed log is unavailable", () => {
    const report = buildUnitGapReport(
      [evidence({ error: "too many API requests needed to fetch logs", log: undefined })],
      { from: "2026-08-09", to: "2026-08-16" },
      "2026-08-16T20:00:00.000Z",
    );
    const markdown = formatUnitGapReport(report);

    expect(report.incompleteRuns).toEqual([
      {
        error: "too many API requests needed to fetch logs",
        runId: 12345678,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
      },
    ]);
    expect(markdown).toContain("The report is incomplete.");
  });

  it("keeps a run active at the cutoff from producing a complete ledger", () => {
    const active = evidence({
      log: undefined,
      run: { ...evidence().run, conclusion: "", status: "in_progress" },
    });
    const report = buildUnitGapReport(
      [active],
      { from: "2026-08-09T20:00:00.000Z", to: "2026-08-16T20:00:00.000Z" },
      "2026-08-16T20:00:00.000Z",
    );

    expect(report.incompleteRuns).toEqual([
      {
        error: "run was in_progress at the collection cutoff",
        runId: 12345678,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
      },
    ]);
  });
});
