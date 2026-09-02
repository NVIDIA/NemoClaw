// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MessagingHookRegistry, runMessagingHook } from "../hooks";
import type { ChannelHookSpec } from "../manifest";
import { createOpenClawBridgeHealthHookRegistration } from "./openclaw-bridge-health";

const SLACK_HEALTH_HOOK = {
  id: "slack-openclaw-bridge-health",
  phase: "health-check",
  handler: "slack.openclawBridgeHealth",
} as const satisfies ChannelHookSpec;

describe("OpenClaw bridge health hook", () => {
  it("logs channel startup warnings through the injected sandbox runner", async () => {
    const logs: string[] = [];
    const commands: string[] = [];
    const registry = new MessagingHookRegistry([
      createOpenClawBridgeHealthHookRegistration(
        {
          channelId: "slack",
          handlerId: "slack.openclawBridgeHealth",
        },
        {
          sandboxName: "alpha",
          log: (message) => logs.push(message),
          executeSandboxCommand: (command) => {
            commands.push(command);
            if (command.includes("openclaw.json")) {
              return {
                status: 0,
                stdout: JSON.stringify({
                  channels: {
                    slack: {
                      enabled: true,
                    },
                  },
                }),
              };
            }
            if (command.includes("gateway.log")) {
              return {
                status: 0,
                stdout: "[channels] [slack] provider failed to start: invalid_auth",
              };
            }
            return null;
          },
        },
      ),
    ]);

    await expect(
      runMessagingHook(SLACK_HEALTH_HOOK, registry, { channelId: "slack" }),
    ).resolves.toMatchObject({
      hookId: "slack-openclaw-bridge-health",
      handlerId: "slack.openclawBridgeHealth",
      phase: "health-check",
      outputs: {},
    });

    expect(commands).toEqual([
      "cat /sandbox/.openclaw/openclaw.json 2>/dev/null || true",
      "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
    ]);
    expect(logs.join("\n")).toContain("'slack' bridge logged credential/startup warnings");
    expect(logs.join("\n")).toContain("invalid_auth");
  });

  it("requires a sandbox command runner", async () => {
    const registry = new MessagingHookRegistry([
      createOpenClawBridgeHealthHookRegistration({
        channelId: "slack",
        handlerId: "slack.openclawBridgeHealth",
      }),
    ]);

    await expect(
      runMessagingHook(SLACK_HEALTH_HOOK, registry, { channelId: "slack" }),
    ).rejects.toThrow("OpenClaw bridge health check requires executeSandboxCommand");
  });

  it("does not classify a revision-scoped credential receipt as a startup warning (#10847)", async () => {
    const logs: string[] = [];
    const registry = new MessagingHookRegistry([
      createOpenClawBridgeHealthHookRegistration(
        {
          channelId: "telegram",
          handlerId: "telegram.openclawBridgeHealth",
        },
        {
          sandboxName: "alpha",
          log: (message) => logs.push(message),
          executeSandboxCommand: (command) =>
            command.includes("openclaw.json")
              ? {
                  status: 0,
                  stdout: JSON.stringify({ channels: { telegram: { enabled: true } } }),
                }
              : {
                  status: 0,
                  stdout:
                    "[telegram] [default] runtime credential is ready (revision-scoped)",
                },
        },
      ),
    ]);

    await expect(
      runMessagingHook(
        {
          id: "telegram-openclaw-bridge-health",
          phase: "health-check",
          handler: "telegram.openclawBridgeHealth",
        },
        registry,
        { channelId: "telegram" },
      ),
    ).resolves.toMatchObject({ outputs: {} });

    expect(logs.join("\n")).not.toContain("credential/startup warnings");
    expect(logs.join("\n")).toContain("no startup confirmation yet");
  });
});
