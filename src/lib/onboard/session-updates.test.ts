// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterSafeUpdates } from "../state/onboard-session";
import { toSessionUpdates } from "./session-updates";

describe("toSessionUpdates", () => {
  it("carries Station checkpoint proof to binding without persisting it", () => {
    const updates = toSessionUpdates({
      provider: "vllm-local",
      model: "nemotron-ultra",
      stationExpressModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    });

    expect(updates.stationExpressModelIdentity).toBe(
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    );
    expect(filterSafeUpdates(updates)).toEqual({
      provider: "vllm-local",
      model: "nemotron-ultra",
    });
  });

  it("carries the recorded compatible-endpoint reasoning effort (#7940)", () => {
    const updates = toSessionUpdates({
      provider: "compatible-endpoint",
      model: "mock/deepseek-compatible",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
    });

    expect(updates.compatibleEndpointReasoningEffort).toBe("high");
    expect(filterSafeUpdates(updates)).toMatchObject({
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
    });
  });

  it.each([
    { label: "an explicit clear", value: null, expected: null },
    { label: "an unrecognized effort", value: "extreme", expected: null },
  ])("clears the recorded reasoning effort for $label", ({ value, expected }) => {
    expect(
      toSessionUpdates({ compatibleEndpointReasoningEffort: value })
        .compatibleEndpointReasoningEffort,
    ).toBe(expected);
  });

  it("leaves the recorded reasoning effort unchanged when the caller omits it", () => {
    const updates = toSessionUpdates({ provider: "compatible-endpoint" });

    expect("compatibleEndpointReasoningEffort" in updates).toBe(false);
    expect(filterSafeUpdates(updates)).toEqual({ provider: "compatible-endpoint" });
  });
});
