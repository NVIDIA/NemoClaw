// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
} from "../../../test/helpers/messaging-conflict-fixtures";
import { SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID } from "../messaging/channels/slack/hooks";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { enforceMessagingChannelConflicts } from "./messaging-conflict-guard";

class AbortError extends Error {}

const SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK = {
  channelId: "slack",
  id: "slack-socket-mode-gateway-conflict",
  phase: "pre-enable",
  handler: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
  onFailure: "abort",
} as const satisfies SandboxMessagingPlan["channels"][number]["hooks"][number];

// Distinct per-sandbox token hashes so the credential-sharing axis stays
// silent and the gateway axis is exercised in isolation: the whole point of
// #4953 is that *different* Slack apps still collide on a shared gateway.
function slackPlan(sandboxName: string): SandboxMessagingPlan {
  return makePlan(sandboxName, {
    channels: [
      {
        ...slackChannel(),
        hooks: [SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK],
      },
    ],
    credentialBindings: slackBindings(`${sandboxName}-bot`, `${sandboxName}-app`, sandboxName),
  });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const log = vi.fn();
  const error = vi.fn();
  const promptContinue = vi.fn(async () => false);
  const exit = vi.fn((_code: number) => {
    throw new AbortError("exit");
  }) as unknown as (code: number) => never;
  const otherSlack = { ...planEntry("alice", slackPlan("alice")), gatewayName: "nemoclaw" };
  const deps = {
    sandboxName: "bob",
    gatewayName: "nemoclaw",
    currentPlan: slackPlan("bob"),
    registry: {
      listSandboxes: () => ({ sandboxes: [otherSlack], defaultSandbox: "alice" }),
      updateSandbox: vi.fn(() => true),
    },
    checkGatewayLiveness: () => false,
    providerExists: () => false,
    isNonInteractive: () => true,
    promptContinue,
    cliName: () => "nemoclaw",
    log,
    error,
    exit,
    ...overrides,
  };
  return { deps, log, error, promptContinue, exit };
}

describe("enforceMessagingChannelConflicts — Slack Socket Mode gateway axis (#4953)", () => {
  it("aborts a second Slack sandbox on the same gateway in non-interactive mode", async () => {
    const { deps, log, error } = makeDeps();
    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled for sandbox 'alice'"),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("resolve the messaging pre-enable conflict above"),
    );
  });

  it("aborts when the interactive operator declines to continue", async () => {
    const promptContinue = vi.fn(async () => false);
    const { deps } = makeDeps({ isNonInteractive: () => false, promptContinue });
    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(promptContinue).toHaveBeenCalled();
  });

  it("proceeds when the interactive operator overrides the conflict", async () => {
    const promptContinue = vi.fn(async () => true);
    const { deps, log } = makeDeps({ isNonInteractive: () => false, promptContinue });
    await expect(enforceMessagingChannelConflicts(deps as never)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled for sandbox 'alice'"),
    );
  });

  it("does not warn when the only other Slack sandbox is on a different gateway", async () => {
    const otherSlack = { ...planEntry("alice", slackPlan("alice")), gatewayName: "nemoclaw-9090" };
    const { deps, log, error } = makeDeps({
      registry: {
        listSandboxes: () => ({ sandboxes: [otherSlack], defaultSandbox: "alice" }),
        updateSandbox: vi.fn(() => true),
      },
    });
    await expect(enforceMessagingChannelConflicts(deps as never)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not block when Slack is stopped on the current sandbox (#4953)", async () => {
    // currentPlan still lists slack as configured/active, but the operator has
    // stopped it on this sandbox, so it must not count as a Socket Mode consumer.
    const { deps, log, error } = makeDeps({ currentSandboxDisabledChannels: ["slack"] });
    await expect(enforceMessagingChannelConflicts(deps as never)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled"),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rethrows unexpected pre-enable hook infrastructure failures", async () => {
    const badPlan = makePlan("bob", {
      channels: [
        {
          ...slackChannel(),
          hooks: [
            {
              ...SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK,
              handler: "slack.missingHandler",
            },
          ],
        },
      ],
      credentialBindings: [],
    });
    const { deps, log, error, promptContinue } = makeDeps({
      currentPlan: badPlan,
      isNonInteractive: () => false,
    });

    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toThrow(
      "Missing messaging hook handler 'slack.missingHandler'",
    );
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(promptContinue).not.toHaveBeenCalled();
  });

  it("is a no-op when the current plan does not enable Slack", async () => {
    const { deps, log } = makeDeps({ currentPlan: makePlan("bob") });
    await expect(enforceMessagingChannelConflicts(deps as never)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
