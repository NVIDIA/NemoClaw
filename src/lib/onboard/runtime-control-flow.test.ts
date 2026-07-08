// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import {
  applyOnboardRuntimeControlRequests,
  applySelectedAgentTransition,
  updateSessionAgent,
} from "./runtime-control-flow";

afterEach(() => {
  delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
});

describe("onboard runtime control flow", () => {
  it("normalizes explicit runtime control requests for session bootstrap", () => {
    expect(
      applyOnboardRuntimeControlRequests({
        toolDisclosure: "direct",
        observabilityEnabled: true,
        dcodeAutoApprovalMode: "thread-opt-in",
      }),
    ).toEqual({
      requestedToolDisclosure: "direct",
      requestedObservabilityEnabled: true,
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });
    delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
    expect(applyOnboardRuntimeControlRequests({})).toEqual({
      requestedToolDisclosure: null,
      requestedObservabilityEnabled: null,
      requestedDcodeAutoApprovalMode: null,
    });
  });

  it("keeps an authoritative inherited observability value out of explicit request handling", () => {
    expect(
      applyOnboardRuntimeControlRequests({
        observabilityEnabled: false,
        observabilityRequestedExplicitly: false,
      }),
    ).toEqual({
      requestedToolDisclosure: null,
      requestedObservabilityEnabled: null,
      requestedDcodeAutoApprovalMode: null,
    });
  });

  it("records the selected DCode agent when observability is enabled", () => {
    const session = createSession({ observabilityEnabled: true });

    expect(updateSessionAgent(session, "langchain-deepagents-code")).toBe(session);
    expect(session.agent).toBe("langchain-deepagents-code");
  });

  it("rejects enabled observability for a non-DCode agent", () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    expect(() => updateSessionAgent(session, "openclaw", { error, exitProcess })).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      "  Recorded observability belongs to Deep Agents Code. Pass --no-observability explicitly when switching agents.",
    );
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(session).toEqual(before);
  });

  it("rejects an invalid resumed agent transition before router or session mutation", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      provider: "nvidia",
      routerPid: 1234,
    });
    const before = structuredClone(session);
    const stopTrackedModelRouterForAgentChange = vi.fn(async () => undefined);
    const clearAgentScopedResumeState = vi.fn((current) => current);
    const setOnboardBrandingAgent = vi.fn();
    const updateSession = vi.fn((mutator) => mutator(session) ?? session);
    const note = vi.fn();
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    await expect(
      applySelectedAgentTransition(
        {
          resume: true,
          session,
          selectedAgentName: "openclaw",
          routerPort: 4000,
          note,
        },
        {
          stopTrackedModelRouterForAgentChange,
          clearAgentScopedResumeState,
          setOnboardBrandingAgent,
          updateSession,
          error,
          exitProcess,
        },
      ),
    ).rejects.toThrow("exit 1");

    expect(stopTrackedModelRouterForAgentChange).not.toHaveBeenCalled();
    expect(clearAgentScopedResumeState).not.toHaveBeenCalled();
    expect(setOnboardBrandingAgent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(session).toEqual(before);
  });
});
