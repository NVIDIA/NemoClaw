// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { isNonInteractiveEnv } from "./non-interactive";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("non-interactive environment detection", () => {
  it("treats only the canonical value as non-interactive", () => {
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "true" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isNonInteractiveEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env when called without an argument", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    expect(isNonInteractiveEnv()).toBe(true);

    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "true");
    expect(isNonInteractiveEnv()).toBe(false);
  });
});
