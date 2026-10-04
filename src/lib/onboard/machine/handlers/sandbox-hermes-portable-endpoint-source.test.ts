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

describe("Hermes portable sandbox endpoint provenance", () => {
  it("continues a configuring lifecycle instead of reusing its Ready sandbox (#9211)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    session.machine.state = "agent_setup";
    const createSandbox = vi.fn(async () => "saved");
    const { deps, calls } = createDeps({
      createSandbox,
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        agent: "hermes",
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        pendingRouteReservation: true,
        reservationSessionId: "session-1",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      hermesPortableLifecycle: true,
      sandboxName: "saved",
      agent: { name: "hermes", displayName: "Hermes" },
    });

    expect(calls.skipped).not.toHaveBeenCalledWith("sandbox", "saved");
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ recreate: false });
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ sandboxName: "saved" }),
    );
  });

  it("preserves the selected endpoint source for fresh Hermes portable creation (#9203)", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      fresh: true,
      agent: { name: "hermes" },
      endpointSource: null,
      hostLocalInferenceRouteOnly: false,
      hermesPortableLifecycle: true,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ endpointSource: null });
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ endpointSource: null }),
    );
  });

  it("preserves the selected endpoint source for ordinary fresh Hermes creation (#9833)", async () => {
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps),
      fresh: true,
      agent: { name: "hermes" },
      endpointSource: null,
      hostLocalInferenceRouteOnly: false,
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-2)).toMatchObject({ endpointSource: null });
  });
});
