// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  clearCompatibleEndpointReasoning,
  configureCompatibleEndpointReasoning,
  describeIgnoredReasoningEnv,
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

describe("describeIgnoredReasoningEnv", () => {
  it("names the recorded value and the recreate command when the env disagrees (#7462)", () => {
    const message = describeIgnoredReasoningEnv("false", "nemoclaw", {
      NEMOCLAW_REASONING: "true",
    });
    expect(message).toContain("Ignoring NEMOCLAW_REASONING=true");
    expect(message).toContain("recorded as reasoning=false");
    expect(message).toContain("nemoclaw onboard --fresh --name <sandbox> --recreate-sandbox");
  });

  it("names the calling CLI so Deep Agents gets its own command (#7462)", () => {
    expect(
      describeIgnoredReasoningEnv("false", "nemo-deepagents", { NEMOCLAW_REASONING: "true" }),
    ).toContain("nemo-deepagents onboard --fresh --name <sandbox> --recreate-sandbox");
  });

  it("normalizes both sides before comparing them (#7462)", () => {
    expect(
      describeIgnoredReasoningEnv("no", "nemoclaw", { NEMOCLAW_REASONING: " YES " }),
    ).toContain("Ignoring NEMOCLAW_REASONING=true");
    expect(describeIgnoredReasoningEnv("yes", "nemoclaw", { NEMOCLAW_REASONING: "1" })).toBeNull();
  });

  it("stays silent when there is nothing to ignore (#7462)", () => {
    expect(describeIgnoredReasoningEnv("false", "nemoclaw", {})).toBeNull();
    expect(
      describeIgnoredReasoningEnv("false", "nemoclaw", { NEMOCLAW_REASONING: "maybe" }),
    ).toBeNull();
    expect(
      describeIgnoredReasoningEnv(null, "nemoclaw", { NEMOCLAW_REASONING: "true" }),
    ).toBeNull();
  });
});
