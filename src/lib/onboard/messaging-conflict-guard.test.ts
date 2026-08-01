// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
  tgBinding,
  tgChannel,
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
    const { deps, error, promptContinue } = makeDeps();
    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled for sandbox 'alice'"),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("resolve the messaging pre-enable conflict above"),
    );
    expect(promptContinue).not.toHaveBeenCalled();
  });

  it("aborts an interactive Slack gateway conflict without prompting (#7808)", async () => {
    const promptContinue = vi.fn(async () => true);
    const { deps, error } = makeDeps({ isNonInteractive: () => false, promptContinue });
    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled for sandbox 'alice'"),
    );
    expect(promptContinue).not.toHaveBeenCalled();
  });

  it("aborts a reused Slack app token across gateways without prompting (#7808)", async () => {
    const sharedAppHash = "shared-app-hash";
    const currentPlan = {
      ...slackPlan("bob"),
      credentialBindings: slackBindings("bob-bot-hash", sharedAppHash, "bob"),
    };
    const otherPlan = {
      ...slackPlan("alice"),
      credentialBindings: slackBindings("alice-bot-hash", sharedAppHash, "alice"),
    };
    const otherSlack = {
      ...planEntry("alice", otherPlan),
      gatewayName: "nemoclaw-9090",
    };
    const promptContinue = vi.fn(async () => true);
    const { deps, error } = makeDeps({
      currentPlan,
      registry: {
        listSandboxes: () => ({ sandboxes: [otherSlack], defaultSandbox: "alice" }),
        updateSandbox: vi.fn(() => true),
      },
      isNonInteractive: () => false,
      promptContinue,
    });

    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("same slack credential"));
    expect(promptContinue).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "interactive", nonInteractive: false },
    { mode: "non-interactive", nonInteractive: true },
  ])("aborts an enabled credential-bearing channel with an unavailable hash in $mode mode (#7808)", async ({
    nonInteractive,
  }) => {
    const currentPlan = makePlan("bob", {
      channels: [tgChannel()],
      credentialBindings: [{ ...tgBinding(), credentialAvailable: false }],
    });
    const listSandboxes = vi.fn(() => ({
      sandboxes: [
        planEntry(
          "alice",
          makePlan("alice", {
            channels: [tgChannel()],
            credentialBindings: [tgBinding("alice-hash")],
          }),
        ),
      ],
    }));
    const promptContinue = vi.fn(async () => true);
    const { deps, error, exit } = makeDeps({
      currentPlan,
      registry: {
        listSandboxes,
        updateSandbox: vi.fn(() => true),
      },
      isNonInteractive: () => nonInteractive,
      promptContinue,
    });

    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("credential hashes are unavailable for telegram"),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Onboarding and rebuild do not support a conflict override"),
    );
    expect(listSandboxes).not.toHaveBeenCalled();
    expect(promptContinue).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("aborts when the credential conflict registry read fails (#7808)", async () => {
    const promptContinue = vi.fn(async () => true);
    const { deps, error, exit } = makeDeps({
      registry: {
        listSandboxes: () => {
          throw new Error("registry unavailable");
        },
        updateSandbox: vi.fn(() => true),
      },
      isNonInteractive: () => false,
      promptContinue,
    });

    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(
      "  Could not verify messaging channel conflicts: registry unavailable",
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Onboarding and rebuild do not support a conflict override"),
    );
    expect(promptContinue).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("aborts when the pre-enable registry read fails (#7808)", async () => {
    const listSandboxes = vi
      .fn()
      .mockReturnValueOnce({ sandboxes: [], defaultSandbox: null })
      .mockImplementationOnce(() => {
        throw new Error("registry unavailable");
      });
    const promptContinue = vi.fn(async () => true);
    const { deps, error, exit } = makeDeps({
      registry: {
        listSandboxes,
        updateSandbox: vi.fn(() => true),
      },
      isNonInteractive: () => false,
      promptContinue,
    });

    await expect(enforceMessagingChannelConflicts(deps as never)).rejects.toBeInstanceOf(
      AbortError,
    );
    expect(error).toHaveBeenCalledWith(
      "  Could not verify messaging pre-enable checks: registry unavailable",
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Onboarding and rebuild do not support a conflict override"),
    );
    expect(promptContinue).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
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
      credentialBindings: slackBindings("bob-bot-hash", "bob-app-hash", "bob"),
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
