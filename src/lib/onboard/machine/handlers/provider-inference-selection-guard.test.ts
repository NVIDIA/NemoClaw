// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { type Agent, baseOptions, createDeps } from "./provider-inference.test-support";

describe("OpenClaw unreadable-selection guard", () => {
  it("stops before inference mutation for an unreadable ready selection", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();
    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        sandboxName: "my-assistant",
        agent: { name: "openclaw" } as Agent,
        isOpenclawReady: async () => true,
        inspectSandboxForCreate: () => ({ existingEntry: {} as never, liveExists: true }),
        getOpenclawSelectionDrift: () => ({
          changed: true,
          providerChanged: false,
          modelChanged: false,
          existingProvider: null,
          existingModel: null,
          requestedProvider: "nvidia-prod",
          requestedModel: "nvidia/test",
          unknown: true,
        }),
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error.mock.calls.flat().join("\n")).toContain("could not read");
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.reupsertRoutedProvider).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
  });

  it("does not block when the sandbox is not registered", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();
    const isOpenclawReady = vi.fn(async () => true);
    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
      agent: { name: "openclaw" } as Agent,
      isOpenclawReady,
      inspectSandboxForCreate: () => ({ existingEntry: null, liveExists: false }),
      getOpenclawSelectionDrift: () => ({
        changed: true,
        providerChanged: false,
        modelChanged: false,
        existingProvider: null,
        existingModel: null,
        requestedProvider: "nvidia-prod",
        requestedModel: "nvidia/test",
        unknown: true,
      }),
    });

    expect(calls.setupInference).toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
    expect(isOpenclawReady).not.toHaveBeenCalled();
  });

  it("allows explicit recreation for an unreadable ready selection", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();
    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
      agent: { name: "openclaw" } as Agent,
      recreateSandboxRequested: true,
      isOpenclawReady: async () => true,
      inspectSandboxForCreate: () => ({ existingEntry: {} as never, liveExists: true }),
      getOpenclawSelectionDrift: () => ({
        changed: true,
        providerChanged: false,
        modelChanged: false,
        existingProvider: null,
        existingModel: null,
        requestedProvider: "nvidia-prod",
        requestedModel: "nvidia/test",
        unknown: true,
      }),
    });

    expect(calls.setupInference).toHaveBeenCalled();
    expect(calls.error).not.toHaveBeenCalled();
  });
});
