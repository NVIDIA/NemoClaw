// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { isNonInteractiveEnv, isNonInteractiveSession } from "./non-interactive";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("non-interactive environment detection", () => {
  it("treats only the canonical explicit value as non-interactive", () => {
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "true" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(isNonInteractiveEnv({ NEMOCLAW_NON_INTERACTIVE: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isNonInteractiveEnv({ NEMOCLAW_YES: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isNonInteractiveEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env when called without an argument", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
    expect(isNonInteractiveEnv()).toBe(true);

    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "true");
    expect(isNonInteractiveEnv()).toBe(false);
  });
});

describe("non-interactive session detection", () => {
  it("treats a session without a stdin terminal as non-interactive (#8877)", () => {
    expect(isNonInteractiveSession({} as NodeJS.ProcessEnv, false)).toBe(true);
    expect(isNonInteractiveSession({} as NodeJS.ProcessEnv, true)).toBe(false);
  });

  it("keeps the explicit environment value authoritative on a terminal", () => {
    expect(
      isNonInteractiveSession({ NEMOCLAW_NON_INTERACTIVE: "1" } as NodeJS.ProcessEnv, true),
    ).toBe(true);
  });

  it("reads process.stdin when called without a terminal argument", () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "");
    const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      expect(isNonInteractiveSession()).toBe(false);

      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: undefined });
      expect(isNonInteractiveSession()).toBe(true);
    } finally {
      originalDescriptor
        ? Object.defineProperty(process.stdin, "isTTY", originalDescriptor)
        : Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
});
