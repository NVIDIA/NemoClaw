// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

describe("handleSandboxState destructive resume rollback (#7194)", () => {
  it("restores the removed registry row, including baseline exclusions, when replacement creation fails", async () => {
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
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      agentSupportsWebSearch: () => false,
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn(
        (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
      ),
    });
    const removalReceipt = {
      entry: {
        name: "saved",
        baselineExclusions: [
          { version: 1 as const, agent: "openclaw", key: "nous_research", digest: "abc" },
        ],
      },
      wasDefault: false,
      fallbackDefault: null,
      postRemovalDefaultSelectionRevision: 1,
    };
    calls.removeSandbox.mockReturnValue(removalReceipt);
    calls.createSandbox.mockRejectedValueOnce(new Error("openshell create failed"));

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true },
      }),
    ).rejects.toThrow("openshell create failed");

    expect(calls.removeSandbox).toHaveBeenCalledWith("saved");
    expect(calls.restoreSandboxRegistryEntryIfMissing).toHaveBeenCalledWith(removalReceipt);
  });

  it("restores the removed row from the exit hook before process termination", async () => {
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
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      agentSupportsWebSearch: () => false,
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn(
        (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
      ),
    });
    const removalReceipt = {
      entry: {
        name: "saved",
        baselineExclusions: [
          { version: 1 as const, agent: "openclaw", key: "nous_research", digest: "abc" },
        ],
      },
      wasDefault: false,
      fallbackDefault: null,
      postRemovalDefaultSelectionRevision: 1,
    };
    let exitListener: ((code: number) => void) | null = null;
    const processOnce = vi.spyOn(process, "once").mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      expect(event).toBe("exit");
      exitListener = listener as (code: number) => void;
      return process;
    }) as typeof process.once);
    const processRemoveListener = vi
      .spyOn(process, "removeListener")
      .mockImplementation(() => process);
    calls.removeSandbox.mockReturnValue(removalReceipt);
    calls.createSandbox.mockImplementationOnce(async () => {
      exitListener?.(1);
      throw new Error("simulated process exit");
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        webSearchConfig: { fetchEnabled: true },
      }),
    ).rejects.toThrow("simulated process exit");

    expect(processOnce).toHaveBeenCalledWith("exit", expect.any(Function));
    expect(calls.restoreSandboxRegistryEntryIfMissing).toHaveBeenCalledTimes(1);
    expect(calls.restoreSandboxRegistryEntryIfMissing).toHaveBeenCalledWith(removalReceipt);
    expect(processRemoveListener).toHaveBeenCalledWith("exit", expect.any(Function));
  });
});
