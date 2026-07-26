// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Compatible-endpoint context-window regression cases for
// handleProviderInferenceState. Split out of provider-inference.test.ts so the
// primary handler spec stays within the growth guardrail (PR #6293 PRA-6).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyCompatibleEndpointContextWindow,
  resetCompatibleEndpointContextWindowAutoState,
} from "../../../inference/compatible-endpoint-context";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

beforeEach(() => {
  resetCompatibleEndpointContextWindowAutoState();
  delete process.env.NEMOCLAW_CONTEXT_WINDOW;
});

afterEach(() => {
  delete process.env.NEMOCLAW_CONTEXT_WINDOW;
  resetCompatibleEndpointContextWindowAutoState();
});

describe("handleProviderInferenceState context window", () => {
  it("clears a stale auto-detected compatible-endpoint context window before re-selecting (#6177)", async () => {
    // Simulate an earlier compatible-endpoint pass auto-detecting a window.
    await applyCompatibleEndpointContextWindow("https://endpoint-a.example/v1", "model-a", {
      env: process.env,
      fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(process.env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // The next fresh provider-selection pass must clear it before selection,
    // so Dockerfile patching for a different provider never sees the stale value.
    const observed: Array<string | undefined> = [];
    const setupNim = vi.fn(async () => {
      observed.push(process.env.NEMOCLAW_CONTEXT_WINDOW);
      return { ...baseSelection };
    });
    const { deps } = createDeps({ setupNim });
    await handleProviderInferenceState(baseOptions(deps));

    expect(setupNim).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([undefined]);
  });

  it("clears the stale auto-detected context window on the resume path too (#6293)", async () => {
    // Simulate an earlier compatible-endpoint pass auto-detecting a window.
    await applyCompatibleEndpointContextWindow("https://endpoint-a.example/v1", "model-a", {
      env: process.env,
      fetchModels: () => ({ data: [{ id: "model-a", max_model_len: 65_536 }] }),
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(process.env.NEMOCLAW_CONTEXT_WINDOW).toBe("65536");

    // PRA-3: the clear now runs at the top of the provider-selection loop, so a
    // resume pass drops the stale auto value just like a fresh selection — it is
    // no longer gated on the fresh-only branch.
    const observed: Array<string | undefined> = [];
    const setupNim = vi.fn(async () => {
      observed.push(process.env.NEMOCLAW_CONTEXT_WINDOW);
      return { ...baseSelection };
    });
    const { deps } = createDeps({ setupNim });
    await handleProviderInferenceState({ ...baseOptions(deps), resume: true });

    expect(process.env.NEMOCLAW_CONTEXT_WINDOW).toBeUndefined();
    expect(observed).toEqual([undefined]);
  });
});
