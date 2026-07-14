// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

describe("handleSandboxState resume recreation", () => {
  it("honors explicit recreate requests for completed ready sandboxes", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      planRegisteredExtraProviders: vi.fn(() => ({
        extraProviders: ["healthy-extra-provider"],
        staleExtraProviders: [],
      })),
      getSandboxRegistryEntry: () => ({
        name: "saved",
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
    });
    calls.createSandbox.mockResolvedValue("saved");

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      recreateSandbox: () => true,
    });

    expect(calls.skipped).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Recreate sandbox requested; recreating sandbox.",
    );
    expect(deps.planRegisteredExtraProviders).toHaveBeenCalledWith("nemoclaw");
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
    expect(createSandboxCall[4]).toBe("saved");
    expect(createSandboxCall[14]).toMatchObject({
      extraProviders: ["healthy-extra-provider"],
      recreate: true,
    });
    expect(result.sandboxName).toBe("saved");
  });

  it("passes an authoritative empty extra-provider list after reconciliation prunes stale names", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      planRegisteredExtraProviders: vi.fn(() => ({
        extraProviders: [],
        staleExtraProviders: ["stale-extra-provider"],
      })),
    });
    calls.createSandbox.mockResolvedValue("saved");

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(deps.planRegisteredExtraProviders).toHaveBeenCalledWith("nemoclaw");
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
    expect(createSandboxCall[14]).toMatchObject({
      extraProviders: [],
      recreate: true,
      resolved: expect.objectContaining({ staleExtraProviders: ["stale-extra-provider"] }),
    });
  });
});
