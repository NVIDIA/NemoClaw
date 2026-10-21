// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

/**
 * The created sandbox is registered from the selection this phase hands to
 * `createSandbox`, so a reasoning effort dropped here never reaches the
 * registry and `status` reports `endpoint-default` for a route that asked for
 * an explicit effort (#12744).
 */
function recordedCreateSelection(
  calls: ReturnType<typeof createDeps>["calls"],
): Record<string, unknown> | null {
  const args = calls.createSandbox.mock.calls[0] ?? [];
  return (
    args
      .map((arg) => (arg as { selection?: Record<string, unknown> } | null)?.selection)
      .find((selection): selection is Record<string, unknown> => Boolean(selection)) ?? null
  );
}

describe("handleSandboxState compatible-endpoint reasoning effort", () => {
  it("carries the requested effort into the created sandbox selection (#12744)", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" }, session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      provider: "compatible-endpoint",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "false",
      compatibleEndpointReasoningEffort: "high",
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(recordedCreateSelection(calls)).toMatchObject({
      provider: "compatible-endpoint",
      compatibleEndpointReasoningEffort: "high",
    });
  });

  it("keeps an absent effort absent so the endpoint default still applies", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" }, session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      provider: "compatible-endpoint",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "false",
      compatibleEndpointReasoningEffort: null,
      sandboxName: "my-assistant",
    });

    expect(recordedCreateSelection(calls)).toMatchObject({
      compatibleEndpointReasoningEffort: null,
    });
  });

  it("drops an effort recorded against a provider that cannot use it", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" }, session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      provider: "nvidia-prod",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: "high",
      sandboxName: "my-assistant",
    });

    // normalizeInferenceSelection() owns that rule; this pins that the phase
    // does not smuggle the value past it.
    expect(recordedCreateSelection(calls)).toMatchObject({
      compatibleEndpointReasoningEffort: null,
    });
  });
});
