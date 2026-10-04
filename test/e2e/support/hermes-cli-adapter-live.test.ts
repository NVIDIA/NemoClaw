// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  displayedHermesSessionTitle,
  isDisplayedHermesSessionTitleForContinuation,
  isHermesFailedUsageEvidence,
} from "../live/hermes-cli-adapter-live.ts";

describe("Hermes CLI adapter live assertions", () => {
  it.each([
    [
      "N8011_mthe9zxn_PROFILE_CONTINUE   sandbox   just now   20260831_153001_12c622",
      "N8011_mthe9zxn_PROFILE_CONTINUE",
    ],
    [
      "N8011_mthe9zxn_PROFILE_CON   sandbox   just now   20260831_153001_12c622",
      "N8011_mthe9zxn_PROFILE_CON",
    ],
  ])("extracts the displayed continued-session title from %j", (row, expected) => {
    expect(displayedHermesSessionTitle(row)).toBe(expected);
  });

  it.each([
    ["N8011_mthe9zxn_PROFILE_CONTINUE   sandbox   just now   20260831_153001_12c622", true],
    ["N8011_mthe9zxn_PROFILE_CON   sandbox   just now   20260831_153001_12c622", true],
    ["N8011_mthe9zxn_PROFILE_   sandbox   just now   20260831_153001_12c622", false],
    ["N8011_mthe9zxn_PROFILE_SEED   sandbox   just now   20260831_153001_12c622", false],
    ["", false],
  ])("classifies displayed continuation row %j as %s", (row, expected) => {
    expect(
      isDisplayedHermesSessionTitleForContinuation(
        row,
        "N8011_mthe9zxn_PROFILE_CONTINUE",
        "N8011_mthe9zxn_PROFILE_SEED",
      ),
    ).toBe(expected);
  });

  it("accepts only the Hermes failed-usage payload for the expected failure", () => {
    const failure = "session not found: 20260917_120000_deadbeef";
    const evidence = {
      estimated_cost_usd: null,
      failed: true,
      failure,
      input_tokens: null,
      output_tokens: null,
    };

    expect(isHermesFailedUsageEvidence(JSON.stringify(evidence), failure)).toBe(true);
    expect(isHermesFailedUsageEvidence(JSON.stringify(evidence), "another failure")).toBe(false);
    expect(
      isHermesFailedUsageEvidence(JSON.stringify({ ...evidence, failed: false }), failure),
    ).toBe(false);
    expect(
      isHermesFailedUsageEvidence(JSON.stringify({ ...evidence, input_tokens: 1 }), failure),
    ).toBe(false);
    expect(isHermesFailedUsageEvidence("not-json", failure)).toBe(false);
  });
});
