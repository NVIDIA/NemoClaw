// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isOnboardAutoYesNonInteractive } from "./no-tty-auto-yes";

describe("onboard no-TTY --yes classification", () => {
  it.each([
    [false, true],
    [false, false],
  ])("treats auto-yes resume as non-interactive when stdin=%s and stdout=%s", (stdinIsTty, stdoutIsTty) => {
    expect(isOnboardAutoYesNonInteractive(true, true, { stdinIsTty, stdoutIsTty })).toBe(true);
  });

  it.each([
    [true, true],
    [true, false],
  ])("keeps auto-yes resume interactive when stdin=%s and stdout=%s", (stdinIsTty, stdoutIsTty) => {
    expect(isOnboardAutoYesNonInteractive(true, true, { stdinIsTty, stdoutIsTty })).toBe(false);
  });

  it("keeps fresh no-TTY auto-yes interactive", () => {
    expect(
      isOnboardAutoYesNonInteractive(true, false, { stdinIsTty: false, stdoutIsTty: false }),
    ).toBe(false);
  });
});
