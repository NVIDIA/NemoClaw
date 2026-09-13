// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  assertReleaseQualification,
  failedReleaseQualificationJobs,
} from "../../../tools/e2e/release-qualification.mts";

const successfulNeeds = {
  "base-image-publication": { result: "success" },
  "generate-matrix": { result: "success" },
  live: { result: "success" },
  "staging-brev-launchable": { result: "success" },
};

describe("release qualification", () => {
  it("records passing PR evidence and refuses to overwrite it (#11489)", ({ onTestFinished }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "e2e-result-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const evidence = {
      outputPath: path.join(directory, "result.json"),
      runId: "123",
      attempt: "2",
    };
    const evaluate = () =>
      assertReleaseQualification(
        JSON.stringify(successfulNeeds),
        '["live","staging-brev-launchable"]',
        evidence,
      );
    expect(evaluate).not.toThrow();
    expect(JSON.parse(readFileSync(evidence.outputPath, "utf8"))).toEqual(
      JSON.parse(
        readFileSync(new URL("../../fixtures/review-queue-e2e-pass.json", import.meta.url), "utf8"),
      ),
    );
    expect(evaluate).toThrow("EEXIST");
  });
  it.each([
    ["failure", "fail"],
    ["cancelled", "unknown"],
    ["skipped", "unknown"],
    [undefined, "unknown"],
  ])(
    "records %s PR evidence with the existing evaluator and dispatch reference (#11489)",
    (result, status) => {
      const directory = mkdtempSync(path.join(tmpdir(), "e2e-result-"));
      const evidence = {
        outputPath: path.join(directory, "result.json"),
        runId: "123",
        attempt: "2",
      };
      try {
        const evaluate = () =>
          assertReleaseQualification(
            JSON.stringify({ ...successfulNeeds, live: { result } }),
            '["live","staging-brev-launchable"]',
            evidence,
          );
        expect(evaluate).toThrow("Release qualification did not pass: live");
        const receipt = JSON.parse(readFileSync(evidence.outputPath, "utf8"));
        expect(receipt.status).toBe(status);
        expect(receipt.dispatchArtifact).toBe("e2e-dispatch-123-2");
        expect(receipt.results).toContainEqual({ job: "live", result: result ?? null });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["[]", "null", '["live","live"]', '["bad job"]', '["generate-matrix"]'])(
    "rejects invalid PR selection %s (#11489)",
    (selection) => {
      expect(() =>
        assertReleaseQualification(JSON.stringify(successfulNeeds), selection, {
          outputPath: "unused.json",
          runId: "123",
          attempt: "2",
        }),
      ).toThrow();
    },
  );
  it("rejects invalid PR evidence without changing controller-only push behavior (#11489)", () => {
    const evidence = { outputPath: "unused.json", runId: "123", attempt: "2" };
    expect(() =>
      assertReleaseQualification(JSON.stringify(successfulNeeds), '["live"]', {
        ...evidence,
        attempt: "0",
      }),
    ).toThrow("dispatch receipt reference");
    expect(() => assertReleaseQualification("null", '["live"]', evidence)).toThrow(
      "Missing workflow results",
    );
  });
  it("accepts one successful result for every planner-selected job (#7912)", () => {
    expect(
      failedReleaseQualificationJobs(successfulNeeds, ["live", "staging-brev-launchable"]),
    ).toEqual([]);
  });

  it("rejects a failure in any release-required E2E job", () => {
    const needs = {
      ...successfulNeeds,
      "staging-brev-launchable": { result: "failure" },
    };

    expect(() =>
      assertReleaseQualification(JSON.stringify(needs), '["live","staging-brev-launchable"]'),
    ).toThrow("Release qualification did not pass: staging-brev-launchable");
  });

  it("treats an empty test selection as a successful controller-only no-op (#7912)", () => {
    expect(failedReleaseQualificationJobs(successfulNeeds, [])).toEqual([]);
    expect(() => assertReleaseQualification(JSON.stringify(successfulNeeds), "[]")).not.toThrow();
  });

  it.each([
    ["failed", { ...successfulNeeds, live: { result: "failure" } }, ["live"]],
    ["skipped", { ...successfulNeeds, live: { result: "skipped" } }, ["live"]],
    [
      "missing",
      {
        "base-image-publication": { result: "success" },
        "generate-matrix": { result: "success" },
      },
      ["live"],
    ],
    [
      "controller failure",
      { ...successfulNeeds, "base-image-publication": { result: "failure" } },
      ["base-image-publication"],
    ],
  ])("reports %s release-required jobs (#7912)", (_case, needs, expected) => {
    expect(failedReleaseQualificationJobs(needs, ["live"])).toEqual(expected);
  });

  it("rejects invalid planner output before evaluating results (#7912)", () => {
    expect(() =>
      assertReleaseQualification(JSON.stringify(successfulNeeds), '["live","bad job"]'),
    ).toThrow("Invalid release-required job IDs: bad job");
  });

  it("exits with status 1 when a required job fails (#7912)", () => {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", path.join(process.cwd(), "tools/e2e/release-qualification.mts")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NEEDS_JSON: JSON.stringify({
            ...successfulNeeds,
            live: { result: "failure" },
          }),
          RELEASE_REQUIRED_JOBS: '["live","staging-brev-launchable"]',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release qualification did not pass: live");
  });
});
