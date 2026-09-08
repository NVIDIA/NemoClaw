// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { fingerprintSandboxRegistryEntry } from "../../sandbox-recreate-transaction";
import { handleSandboxState } from "./sandbox";
import { baseOptions, bindJournaledRecreate, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

describe("handleSandboxState journaled replacement failure", () => {
  it("keeps the registry row unchanged when replacement creation fails (#7194)", async () => {
    const session = createSession({
      sandboxName: "saved",
      webSearchConfig: { fetchEnabled: true },
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: false,
        resourceProfile: false,
      },
    });
    const sourceEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      preferredInferenceApi: "openai-completions",
      toolDisclosure: "progressive",
      webSearchEnabled: true,
    } satisfies SandboxEntry;
    const journal = bindJournaledRecreate(session);
    const getSandboxRegistryEntry = vi.fn(() => sourceEntry);
    const createSandbox = vi.fn(async () => {
      throw new Error("openshell create failed");
    });
    const { deps, calls } = createDeps(
      {
        agentSupportsWebSearch: () => false,
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        getSandboxRegistryEntry,
        createSandbox,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true },
      }),
    ).rejects.toThrow("openshell create failed");

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(getSandboxRegistryEntry).toHaveBeenCalledWith("saved");
    expect(deps.getSandboxRegistryEntry("saved")).toBe(sourceEntry);
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.restoreSandboxRegistryEntryIfMissing).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      sandboxName: "saved",
      phase: "planned",
      sourceRegistryFingerprint: fingerprintSandboxRegistryEntry(sourceEntry),
    });
  });
});
