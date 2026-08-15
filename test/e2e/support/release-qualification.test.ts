// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

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
  it("accepts one successful result for every planner-selected job (#7912)", () => {
    expect(
      failedReleaseQualificationJobs(successfulNeeds, ["live", "staging-brev-launchable"]),
    ).toEqual([]);
  });

  it("accepts recorded failures only for planner-waived E2E jobs", () => {
    const needs = {
      ...successfulNeeds,
      "staging-brev-launchable": { result: "failure" },
    };

    expect(() =>
      assertReleaseQualification(JSON.stringify(needs), '["live"]', '["staging-brev-launchable"]'),
    ).not.toThrow();
    expect(() =>
      assertReleaseQualification(JSON.stringify(needs), '["live","staging-brev-launchable"]', "[]"),
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

  it("rejects controller, overlapping, duplicate, and missing waiver evidence", () => {
    expect(() =>
      assertReleaseQualification(
        JSON.stringify(successfulNeeds),
        '["live"]',
        '["generate-matrix"]',
      ),
    ).toThrow("Release controller jobs cannot be waived: generate-matrix");
    expect(() =>
      assertReleaseQualification(JSON.stringify(successfulNeeds), '["live"]', '["live"]'),
    ).toThrow("Waived jobs remain release-required: live");
    expect(() =>
      assertReleaseQualification(
        JSON.stringify(successfulNeeds),
        '["live"]',
        '["staging-brev-launchable","staging-brev-launchable"]',
      ),
    ).toThrow("Release qualification waived jobs must not contain duplicates");
    expect(() =>
      assertReleaseQualification(JSON.stringify(successfulNeeds), '["live"]', '["hermes-e2e"]'),
    ).toThrow("Waived jobs must finish with success or failure: hermes-e2e");
  });

  it.each(["cancelled", "skipped"])(
    "rejects a %s waived job because the execution did not complete",
    (result) => {
      const needs = {
        ...successfulNeeds,
        "staging-brev-launchable": { result },
      };

      expect(() =>
        assertReleaseQualification(
          JSON.stringify(needs),
          '["live"]',
          '["staging-brev-launchable"]',
        ),
      ).toThrow("Waived jobs must finish with success or failure: staging-brev-launchable");
    },
  );

  it("exits with status 1 when a required job fails (#7912)", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        path.join(process.cwd(), "tools/e2e/release-qualification.mts"),
      ],
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
