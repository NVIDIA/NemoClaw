// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("handleProviderInferenceState sandbox name resolution", () => {
  it("resolves the sandbox name before provider selection in a fresh non-interactive run (#11440)", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();
    calls.complete.mockImplementation(async (...args: unknown[]) => {
      session.steps.provider_selection.status =
        args[0] === "provider_selection" ? "complete" : session.steps.provider_selection.status;
      return session;
    });

    const result = await handleProviderInferenceState(baseOptions(deps, session));

    expect(calls.promptName).toHaveBeenCalledOnce();
    expect(calls.promptName.mock.invocationCallOrder[0]).toBeLessThan(
      calls.setupNim.mock.invocationCallOrder[0]!,
    );
    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "my-assistant",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
      expect.any(Function),
    );
    expect(result.sandboxName).toBe("my-assistant");
    expect(calls.setupInference.mock.calls[0]?.[0]).toBe("my-assistant");
  });

  it("forwards a requested sandbox name to selection without prompting (#11440)", async () => {
    const { deps, calls } = createDeps();
    const session = createSession();

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "chosen-name",
      requestedSandboxName: "chosen-name",
    });

    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "chosen-name",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
      expect.any(Function),
    );
    expect(result.sandboxName).toBe("chosen-name");
  });

  it("leaves name prompting at the review stage in interactive runs (#11440)", async () => {
    const { deps, calls } = createDeps({ isNonInteractive: () => false });
    const session = createSession();

    const result = await handleProviderInferenceState(baseOptions(deps, session));

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      null,
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
      expect.any(Function),
    );
    expect(calls.promptName).toHaveBeenCalledOnce();
    expect(calls.setupNim.mock.invocationCallOrder[0]).toBeLessThan(
      calls.promptName.mock.invocationCallOrder[0]!,
    );
    expect(result.sandboxName).toBe("my-assistant");
  });
});
