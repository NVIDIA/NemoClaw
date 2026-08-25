// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

describe("sandbox route publication", () => {
  it("publishes the current inference reservation after completing Ready sandbox reuse", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps(
      {
        createSandbox: vi.fn(async () => "saved"),
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: (name) => ({
          name,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
          toolDisclosure: "progressive",
        }),
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.finalizeRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "saved",
      session.sessionId,
    );
    expect(calls.finalizeRouteReservation.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.updateSandbox.mock.invocationCallOrder[0]!,
    );
    expect(calls.finalizeRouteReservation.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recordSkip.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps a created registration pending when post-create metadata fails", async () => {
    const { deps, calls } = createDeps({
      updateSandboxRegistry: vi.fn(() => {
        throw new Error("metadata write failed");
      }),
    });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("metadata write failed");

    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.finalizeRouteReservation).not.toHaveBeenCalled();
  });

  it("rejects Ready sandbox reuse after route reservation ownership changes", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps(
      {
        createSandbox: vi.fn(async () => "saved"),
        finalizeSandboxRouteReservation: vi.fn(() => false),
        getSandboxReuseState: () => "ready",
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      "  Error: sandbox 'saved' inference route reservation changed while onboarding was in progress. Retry onboarding.",
    );
    expect(calls.recordSkip).toHaveBeenCalled();
  });
});
