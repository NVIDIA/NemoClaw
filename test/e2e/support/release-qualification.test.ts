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
