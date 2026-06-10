// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
} from "../../../../../test/helpers/sandbox-handler-fixtures";

describe("handleSandboxState messaging plans", () => {
  it("uses recorded messaging channels on non-interactive resume", async () => {
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["discord"]);
    const { deps, calls } = createDeps({
      getRecordedMessagingChannelsForResume,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps),
      resume: true,
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(getRecordedMessagingChannelsForResume).toHaveBeenCalledWith(
      true,
      expect.any(Object),
      "my-assistant",
    );
    expect(calls.note).toHaveBeenCalledWith(
      "  [non-interactive] Reusing messaging channel configuration: discord",
    );
    expect(result.selectedMessagingChannels).toEqual(["discord"]);
  });

  it("persists plan from env into session after fresh messaging setup", async () => {
    const mockPlan = makeMinimalPlan("my-assistant");
    const { deps, getSession } = createDeps({
      readMessagingPlanFromEnv: () => mockPlan,
    });

    await handleSandboxState({ ...baseOptions(deps) });

    expect(getSession().messagingPlan).toEqual(mockPlan);
  });

  it("restores registry plan to env on non-interactive resume when env is empty", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
    });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).toHaveBeenCalledWith(registryPlan);
  });

  it("prefers env-staged plan over registry plan on non-interactive resume", async () => {
    const registryPlan = makeMinimalPlan("my-assistant");
    const rebuiltPlan = makeMinimalPlan("my-assistant");
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
    });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => rebuiltPlan,
      getRegistrySandboxMessagingPlan: () => registryPlan,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(rebuiltPlan);
  });

  it("preserves an env-staged empty plan on non-interactive resume", async () => {
    const emptyPlan = makeMinimalPlan("my-assistant");
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: emptyPlan,
    });
    const getRecordedMessagingChannelsForResume = vi.fn(() => [] as string[]);
    const { deps, calls, getSession } = createDeps({
      getRecordedMessagingChannelsForResume,
      readMessagingPlanFromEnv: () => emptyPlan,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual([]);
    expect(getSession().messagingPlan).toEqual(emptyPlan);
  });

  it("does not restore plan to env when registry has no entry", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
    });
    const getRecordedMessagingChannelsForResume = vi.fn(() => ["telegram"]);
    const writePlanToEnv = vi.fn();
    const { deps } = createDeps({
      getRecordedMessagingChannelsForResume,
      writePlanToEnv,
      readMessagingPlanFromEnv: () => null,
      getRegistrySandboxMessagingPlan: () => null,
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(writePlanToEnv).not.toHaveBeenCalled();
  });
});
