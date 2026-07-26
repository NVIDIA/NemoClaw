// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../../../inference/ollama-runtime-context";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("handleProviderInferenceState Ollama context resume (#6760)", () => {
  it("verifies the exact recorded Hermes model before using resume shortcuts", async () => {
    const session = createSession({
      agent: "hermes",
      provider: "ollama-local",
      model: "qwen3.5:35b",
    });
    session.steps.provider_selection.status = "complete";
    const routeReady = vi.fn(() => true);
    const { deps, calls } = createDeps({ isInferenceRouteReady: routeReady });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "hermes-local",
      agent: { name: "hermes" },
    });

    expect(calls.repair).toHaveBeenCalledWith({
      provider: "ollama-local",
      model: "qwen3.5:35b",
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      isNonInteractive: deps.isNonInteractive,
    });
    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(routeReady).toHaveBeenCalledWith("nemoclaw", "ollama-local", "qwen3.5:35b");
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("records a strict context repair failure and stops resume shortcuts", async () => {
    const failure = "Ollama loaded the recorded model below 64000 tokens.";
    const session = createSession({
      agent: "hermes",
      provider: "ollama-local",
      model: "qwen3.5:35b",
    });
    session.steps.provider_selection.status = "complete";
    const routeReady = vi.fn(() => true);
    const { deps, calls } = createDeps({ isInferenceRouteReady: routeReady });
    calls.repair.mockImplementation(() => {
      throw new Error(failure);
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "hermes-local",
        agent: { name: "hermes" },
      }),
    ).rejects.toThrow(failure);

    const repairMetadata = { repair: "ollama-systemd-loopback" };
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "provider_selection",
      metadata: repairMetadata,
    });
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.failed", {
      state: "provider_selection",
      error: failure,
      metadata: repairMetadata,
    });
    expect(calls.repairEvent).not.toHaveBeenCalledWith("state.repair.completed", expect.anything());
    expect(routeReady).not.toHaveBeenCalled();
    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.skipped).not.toHaveBeenCalledWith("inference", expect.anything());
  });
});
