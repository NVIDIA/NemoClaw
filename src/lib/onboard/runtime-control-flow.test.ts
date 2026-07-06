// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import { applyOnboardRuntimeControlRequests, updateSessionAgent } from "./runtime-control-flow";

afterEach(() => {
  delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
});

describe("onboard runtime control flow", () => {
  it("normalizes explicit runtime control requests for session bootstrap", () => {
    expect(
      applyOnboardRuntimeControlRequests({
        toolDisclosure: "direct",
        observabilityEnabled: true,
      }),
    ).toEqual({
      requestedToolDisclosure: "direct",
      requestedObservabilityEnabled: true,
    });
    delete process.env.NEMOCLAW_TOOL_DISCLOSURE;
    expect(applyOnboardRuntimeControlRequests({})).toEqual({
      requestedToolDisclosure: null,
      requestedObservabilityEnabled: null,
    });
  });

  it("records the selected DCode agent when observability is enabled", () => {
    const session = createSession({ observabilityEnabled: true });

    expect(updateSessionAgent(session, "langchain-deepagents-code")).toBe(session);
    expect(session.agent).toBe("langchain-deepagents-code");
  });

  it("rejects enabled observability for a non-DCode agent", () => {
    const session = createSession({ observabilityEnabled: true });
    const error = vi.fn();
    const exitProcess = vi.fn(() => {
      throw new Error("exit 1");
    });

    expect(() => updateSessionAgent(session, "openclaw", { error, exitProcess })).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      "  --observability is supported only with --agent langchain-deepagents-code.",
    );
    expect(exitProcess).toHaveBeenCalledWith(1);
  });
});
