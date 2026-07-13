// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

describe("sandbox create intent machine boundary", () => {
  it("rejects deterministic create conflicts before resume recreation mutates state (#6226)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const resolveSandboxCreateIntent = vi.fn(async () => {
      throw new Error("messaging provider conflict");
    });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getStoredMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "1" }),
      hydrateMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "0" }),
      messagingChannelConfigsEqual: () => false,
      resolveSandboxCreateIntent,
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
    ).rejects.toThrow("messaging provider conflict");

    expect(resolveSandboxCreateIntent).toHaveBeenCalledTimes(1);
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.repairSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("produces equivalent complete intent for equivalent fresh and resumed selections (#6226)", async () => {
    const variants = [
      { fresh: false, resume: false, env: {} },
      { fresh: true, resume: false, env: {} },
      { fresh: false, resume: true, env: { NEMOCLAW_NON_INTERACTIVE: "1" } },
    ];
    const resolvedIntents: unknown[] = [];

    for (const variant of variants) {
      const session = createSession({ sandboxName: "same-sandbox" });
      const { deps, calls } = createDeps();
      calls.setupMessaging.mockResolvedValue(["telegram"]);
      await handleSandboxState({
        ...baseOptions(deps, session),
        ...variant,
        sandboxName: "same-sandbox",
        selectedMessagingChannels: ["telegram"],
      });
      const createIntent = calls.createSandbox.mock.calls[0]?.at(-1) as unknown as {
        resolved: unknown;
      };
      expect(createIntent).toMatchObject({
        resolved: {
          sandboxName: "same-sandbox",
          activeMessagingChannels: [],
          messagingProviderRequests: [],
          reusableMessagingProviders: [],
          extraProviders: [],
          staleExtraProviders: [],
          hermesToolGateways: [],
          policy: {
            basePolicyPath: "/repo/policy.yaml",
            activeMessagingChannels: [],
            options: {
              directGpu: false,
              additionalPresets: [],
              policyTier: null,
            },
          },
          gpuCreateArgs: [],
          resourceCreateArgs: [],
          gpuRoutePlan: "none",
          sandboxGpuLogMessage: null,
          disabledChannelNames: [],
          extraPlaceholderKeys: [],
        },
        recreate: expect.any(Boolean),
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        extraProviders: [],
      });
      const serializedIntent = JSON.stringify(createIntent);
      expect(JSON.parse(serializedIntent)).toEqual(createIntent);
      expect(serializedIntent).not.toMatch(/stored-|resolved-|secret-value|token-value/iu);
      resolvedIntents.push(createIntent.resolved);
      expect(calls.startStep).toHaveBeenCalledWith("sandbox", {
        sandboxName: "same-sandbox",
        provider: "provider",
        model: "model",
      });
      expect(session).not.toHaveProperty("resolved");
    }

    expect(resolvedIntents[1]).toEqual(resolvedIntents[0]);
    expect(resolvedIntents[2]).toEqual(resolvedIntents[0]);
  });
});
