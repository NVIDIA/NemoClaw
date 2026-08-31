// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  displayedHermesSessionTitle,
  isDisplayedHermesSessionTitleForContinuation,
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
    ["N8011_mthe9zxn_PROFILE_CONTINUE", true],
    ["N8011_mthe9zxn_PROFILE_CON", true],
    ["N8011_mthe9zxn_PROFILE_", false],
    ["N8011_mthe9zxn_PROFILE_SEED", false],
    ["", false],
  ])("classifies displayed continuation title %j as %s", (displayedTitle, expected) => {
    const row = `${displayedTitle}   sandbox   just now   20260831_153001_12c622`;
    expect(
      isDisplayedHermesSessionTitleForContinuation(
        row,
        "N8011_mthe9zxn_PROFILE_CONTINUE",
        "N8011_mthe9zxn_PROFILE_SEED",
      ),
    ).toBe(expected);
  });
});
