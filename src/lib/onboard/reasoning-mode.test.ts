// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  clearCompatibleEndpointReasoning,
  configureCompatibleEndpointReasoning,
  normalizeReasoningFlag,
} from "./reasoning-mode";

describe("compatible endpoint reasoning mode", () => {
  afterEach(() => {
    delete process.env.NEMOCLAW_REASONING;
  });

  it("normalizes supported boolean aliases (#3279)", () => {
    for (const value of ["true", "1", "yes", "y", " YES "]) {
      expect(normalizeReasoningFlag(value)).toBe("true");
    }
    for (const value of ["false", "0", "no", "n", " NO "]) {
      expect(normalizeReasoningFlag(value)).toBe("false");
    }
    expect(normalizeReasoningFlag("maybe")).toBeNull();
  });

  it("defaults an unset or invalid flag to false (#3279)", async () => {
    await expect(configureCompatibleEndpointReasoning()).resolves.toBe("false");
    expect(process.env.NEMOCLAW_REASONING).toBe("false");

    process.env.NEMOCLAW_REASONING = "maybe";
    await expect(configureCompatibleEndpointReasoning()).resolves.toBe("false");
    expect(process.env.NEMOCLAW_REASONING).toBe("false");
  });

  it("restores stored state and clears it when the provider changes (#3279)", async () => {
    process.env.NEMOCLAW_REASONING = "false";
    await expect(configureCompatibleEndpointReasoning("yes")).resolves.toBe("true");
    expect(process.env.NEMOCLAW_REASONING).toBe("true");

    expect(clearCompatibleEndpointReasoning()).toBeNull();
    expect(process.env.NEMOCLAW_REASONING).toBeUndefined();
  });
});
