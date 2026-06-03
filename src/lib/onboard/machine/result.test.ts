// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  advanceTo,
  branchTo,
  completeOnboardMachine,
  failOnboardMachine,
  type OnboardStateResultTransitionKind,
  type OnboardStateTransitionHelperOptions,
  retryTo,
  transitionTo,
} from "./result";
import type { OnboardNonTerminalMachineState } from "./types";

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

  it("restricts transition results to non-terminal transition paths", () => {
    expectTypeOf(transitionTo).parameter(0).toEqualTypeOf<OnboardNonTerminalMachineState>();
    expectTypeOf<OnboardStateResultTransitionKind>().toEqualTypeOf<
      "advance" | "retry" | "branch"
    >();
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

  it("type-checks helper options without accepting transition kind overrides", () => {
    expectTypeOf(advanceTo).parameter(1).toEqualTypeOf<
      OnboardStateTransitionHelperOptions | undefined
    >();

    advanceTo("preflight", {
      updates: { sandboxName: "my-assistant" },
      metadata: { reason: "typed" },
    });

    // @ts-expect-error transitionKind is controlled by each specialized helper.
    advanceTo("preflight", { transitionKind: "retry" });
    // @ts-expect-error updates must match the persisted onboarding session shape.
    retryTo("provider_selection", { updates: { unknown: "value" } });
    // @ts-expect-error metadata must be an object or null.
    branchTo("agent_setup", { metadata: "bad" });
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
