// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as registry from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

describe("sandbox create baseline exclusion locking (#7194)", () => {
  it("resolves the complete create intent only after acquiring the sandbox mutation lock", async () => {
    let lockHeld = false;
    const { deps, calls } = createDeps({
      withSandboxMutationLock: async (_sandboxName, action) => {
        expect(lockHeld).toBe(false);
        lockHeld = true;
        try {
          return await action();
        } finally {
          lockHeld = false;
        }
      },
    });
    const resolveCreateIntent = calls.resolveCreateIntent.getMockImplementation();
    const createSandbox = calls.createSandbox.getMockImplementation();
    calls.resolveCreateIntent.mockImplementation(async (...args) => {
      expect(lockHeld).toBe(true);
      return await resolveCreateIntent!(...args);
    });
    calls.createSandbox.mockImplementation(async (...args) => {
      expect(lockHeld).toBe(true);
      return await createSandbox!(...args);
    });

    await handleSandboxState(baseOptions(deps));

    expect(calls.resolveCreateIntent).toHaveBeenCalledOnce();
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(lockHeld).toBe(false);
  });

  it("rejects a transaction that appears while onboarding waits for its sandbox lock", async () => {
    let lockHeld = false;
    const transitionSpy = vi
      .spyOn(registry, "getBaselineExclusionTransition")
      .mockImplementation(() =>
        lockHeld
          ? {
              id: "00000000-0000-4000-8000-000000000001",
              operation: "exclude",
              exclusion: {
                version: 1,
                agent: "openclaw",
                key: "nous_research",
                digest: "a".repeat(64),
                acknowledgedAt: "2026-07-19T00:00:00.000Z",
              },
              targetLiveDigest: null,
              startedAt: "2026-07-19T00:00:00.000Z",
            }
          : null,
      );
    try {
      const { deps, calls } = createDeps({
        withSandboxMutationLock: async (_sandboxName, action) => {
          lockHeld = true;
          try {
            return await action();
          } finally {
            lockHeld = false;
          }
        },
      });

      await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow(
        "needs repair before sandbox creation",
      );

      expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
      expect(calls.removeSandbox).not.toHaveBeenCalled();
      expect(calls.createSandbox).not.toHaveBeenCalled();
    } finally {
      transitionSpy.mockRestore();
    }
  });

  it("rejects exclusion intent that changes before the destructive create edge", async () => {
    const original = {
      version: 1 as const,
      agent: "openclaw",
      key: "nous_research",
      digest: "a".repeat(64),
      acknowledgedAt: "2026-07-19T00:00:00.000Z",
      appliedAgentVersion: null,
    };
    const changed = { ...original, digest: "b".repeat(64) };
    const transitionSpy = vi
      .spyOn(registry, "getBaselineExclusionTransition")
      .mockReturnValue(null);
    const exclusionsSpy = vi
      .spyOn(registry, "getBaselineExclusions")
      .mockReturnValueOnce([original])
      .mockReturnValue([changed]);
    try {
      const { deps, calls } = createDeps({
        withSandboxMutationLock: async (_sandboxName, action) => await action(),
      });

      await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow(
        "changed while sandbox creation was being prepared",
      );

      expect(calls.resolveCreateIntent).toHaveBeenCalledWith(
        expect.objectContaining({ baselineExclusions: [original] }),
      );
      expect(calls.removeSandbox).not.toHaveBeenCalled();
      expect(calls.createSandbox).not.toHaveBeenCalled();
    } finally {
      exclusionsSpy.mockRestore();
      transitionSpy.mockRestore();
    }
  });
});
