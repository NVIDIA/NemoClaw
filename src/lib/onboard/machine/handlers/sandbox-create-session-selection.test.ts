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

describe("handleSandboxState create selection recovery (#12864)", () => {
  it("publishes the session-recorded model when resume reaches create with an empty options model", async () => {
    const session = createSession({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
    });
    const { deps, calls } = createDeps({}, session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
      model: "",
      provider: "ollama-local",
    });

    expect(calls.createSandbox).toHaveBeenCalledOnce();
    const createArgs = calls.createSandbox.mock.calls[0]!;
    expect(createArgs).toHaveLength(17);
    expect(createArgs.at(-16)).toBe("qwen3.5:9b");
    expect(createArgs.at(-15)).toBe("ollama-local");
    expect(createArgs.at(-3)).toMatchObject({
      sessionId: session.sessionId,
      selection: { model: "qwen3.5:9b", provider: "ollama-local" },
    });
    expect(calls.startStep).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ model: "qwen3.5:9b", provider: "ollama-local" }),
    );
    expect(calls.updateSandbox).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ model: "qwen3.5:9b", provider: "ollama-local" }),
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "sandbox",
      expect.objectContaining({ model: "qwen3.5:9b", provider: "ollama-local" }),
    );
  });

  it("recovers a starved provider from the session record the same way", async () => {
    const session = createSession({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
    });
    const { deps, calls } = createDeps({}, session);

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
      model: "",
      provider: "",
    });

    const createArgs = calls.createSandbox.mock.calls[0]!;
    expect(createArgs.at(-16)).toBe("qwen3.5:9b");
    expect(createArgs.at(-15)).toBe("ollama-local");
    expect(createArgs.at(-3)).toMatchObject({
      selection: { model: "qwen3.5:9b", provider: "ollama-local" },
    });
  });
});
