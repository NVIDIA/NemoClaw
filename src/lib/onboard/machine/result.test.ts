// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  advanceTo,
  branchTo,
  completeOnboardMachine,
  failOnboardMachine,
  retryTo,
  transitionTo,
} from "./result";

describe("onboard state result helpers", () => {
  it("builds transition results with optional updates and metadata", () => {
    expect(
      transitionTo("gateway", {
        updates: { sandboxName: "my-assistant" },
        metadata: { reason: "test" },
      }),
    ).toEqual({
      type: "transition",
      next: "gateway",
      transitionKind: undefined,
      updates: { sandboxName: "my-assistant" },
      metadata: { reason: "test" },
    });
  });

  it("labels advance, retry, and branch transitions", () => {
    expect(advanceTo("preflight")).toMatchObject({
      type: "transition",
      next: "preflight",
      transitionKind: "advance",
    });
    expect(retryTo("provider_selection")).toMatchObject({
      type: "transition",
      next: "provider_selection",
      transitionKind: "retry",
    });
    expect(branchTo("agent_setup")).toMatchObject({
      type: "transition",
      next: "agent_setup",
      transitionKind: "branch",
    });
  });

  it("builds terminal completion and failure results", () => {
    expect(completeOnboardMachine({ sandboxName: "my-assistant" }, { verified: true })).toEqual({
      type: "complete",
      updates: { sandboxName: "my-assistant" },
      metadata: { verified: true },
    });
    expect(failOnboardMachine("boom", { step: "gateway", metadata: { phase: 2 } })).toEqual({
      type: "failed",
      error: "boom",
      step: "gateway",
      metadata: { phase: 2 },
    });
  });
});
