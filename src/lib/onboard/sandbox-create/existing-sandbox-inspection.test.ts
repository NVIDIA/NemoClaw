// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { shouldInspectExistingSandbox } from "./orchestration";

describe("existing sandbox inspection selection (#12740)", () => {
  it("skips provider cleanup inspection when the sandbox is absent", () => {
    expect(
      shouldInspectExistingSandbox({
        liveExists: false,
        portableLifecycle: false,
        resumingVerifiedCreate: false,
      }),
    ).toBe(false);
  });

  it("inspects an existing non-portable sandbox", () => {
    expect(
      shouldInspectExistingSandbox({
        liveExists: true,
        portableLifecycle: false,
        resumingVerifiedCreate: false,
      }),
    ).toBe(true);
  });

  it.each([
    { label: "portable lifecycle", portableLifecycle: true, resumingVerifiedCreate: false },
    { label: "verified create resume", portableLifecycle: false, resumingVerifiedCreate: true },
  ])("skips inspection for $label", ({ portableLifecycle, resumingVerifiedCreate }) => {
    expect(
      shouldInspectExistingSandbox({
        liveExists: true,
        portableLifecycle,
        resumingVerifiedCreate,
      }),
    ).toBe(false);
  });
});
