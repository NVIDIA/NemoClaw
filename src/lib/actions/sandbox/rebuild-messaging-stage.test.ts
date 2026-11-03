// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression: stageMessagingManifestPlanForRebuild() must clear any stale
// NEMOCLAW_MESSAGING_PLAN_B64 and skip planning for agents unsupported by
// channel manifests, so a non-messaging sandbox rebuild cannot
// carry messaging-plan state into the Dockerfile patch step.
//
import { afterEach, describe, expect, it, vi } from "vitest";

import * as defs from "../../agent/defs";
import * as sandboxTransport from "../../adapters/sandbox/command-transport";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../../messaging/channels";
import { MessagingWorkflowPlanner } from "../../messaging/compiler";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-stage";
import { runMessagingHealthChecksAfterRebuild } from "./rebuild-messaging-phase";

const emptyStoredMessagingPlan = {
  schemaVersion: 1,
  sandboxName: "openclaw-sandbox",
  agent: "openclaw",
  workflow: "remove-channel",
  channels: [],
  disabledChannels: [],
  credentialBindings: [],
  networkPolicy: { presets: [], entries: [] },
  agentRender: [],
  buildSteps: [],
  stateUpdates: [],
  healthChecks: [],
} satisfies SandboxMessagingPlan;

describe("stageMessagingManifestPlanForRebuild non-messaging agent guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the skip message for any agent whose name is not supported by channel manifests", async () => {
    const loadAgentSpy = vi
      .spyOn(defs, "loadAgent")
      .mockReturnValue({ name: "future-non-messaging-agent" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "future-sandbox",
      { name: "future-sandbox" },
      "future-non-messaging-agent",
      (msg) => messages.push(msg),
    );

    expect(loadAgentSpy).toHaveBeenCalledWith("future-non-messaging-agent");
    expect(clearPlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain(
      "Messaging manifest rebuild plan skipped: agent 'future-non-messaging-agent' is not supported by any channel manifest",
    );
    expect(messages.some((msg) => msg.includes("has no supported messaging channels"))).toBe(false);
    expect(result).toBeNull();
  });

  it("stages an explicit empty rebuild plan so token-backed channels are not rediscovered", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi
      .spyOn(MessagingSetupApplier, "writePlanToEnv")
      .mockImplementation(() => undefined);

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        messaging: { schemaVersion: 1, plan: emptyStoredMessagingPlan },
      },
      "openclaw",
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "rebuild",
        channels: [],
      }),
    );
    expect(messages).toContain("Messaging manifest rebuild plan staged: no configured channels");
    expect(result).toMatchObject({ workflow: "rebuild", channels: [] });
  });

  it("stages a plan for a known agent using channel-manifest supported channels", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");

    const sandboxEntryWithStoredPlan = {
      name: "openclaw-sandbox",
      messaging: {
        schemaVersion: 1,
        plan: {
          schemaVersion: 1,
          sandboxName: "openclaw-sandbox",
          agent: "openclaw",
          workflow: "rebuild",
          channels: [
            {
              channelId: "telegram",
              displayName: "telegram",
              authMode: "token-paste",
              active: true,
              selected: true,
              configured: true,
              disabled: false,
              inputs: [],
              hooks: [],
            },
          ],
          disabledChannels: [],
          credentialBindings: [],
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    } satisfies SandboxEntry;

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      sandboxEntryWithStoredPlan,
      "openclaw",
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain("Messaging manifest rebuild plan staged: telegram");
    expect(result).not.toBeNull();
  });
});

describe("manifest-owned health checks after rebuild", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      channel: "discord",
      condition: "the native probe fails",
      status: 1,
      config: {},
      log: "invalid-output-with-secret",
      messages: [expect.stringContaining("The Discord gateway connection could not be verified")],
      command: "openclaw channels status --channel discord --probe --json --timeout 8000",
      timeout: 8_000,
    },
    {
      channel: "telegram",
      condition: "the provider starts",
      config: {
        channels: {
          telegram: {
            enabled: true,
            accounts: { default: { dmPolicy: "allowlist", allowFrom: [] } },
          },
        },
      },
      log: "[telegram] [default] starting provider\n",
      messages: [
        expect.stringContaining("'telegram' bridge startup detected"),
        expect.stringContaining("Telegram direct-message allowlist is empty"),
      ],
      command: "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
      timeout: 10_000,
    },
    {
      channel: "slack",
      condition: "credentials are rejected",
      config: { channels: { slack: { enabled: true } } },
      log: "[channels] [slack] provider failed to start: invalid_auth\n",
      messages: [
        expect.stringContaining("'slack' bridge logged credential/startup warnings"),
        expect.stringContaining("invalid_auth"),
      ],
      command: "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
      timeout: 10_000,
    },
    {
      channel: "telegram",
      condition: "the channel is not enabled",
      config: { channels: { telegram: {} } },
      log: "",
      messages: [expect.stringContaining("was not marked enabled in the current")],
      command: "cat /sandbox/.openclaw/openclaw.json 2>/dev/null || true",
      timeout: 10_000,
    },
    {
      channel: "telegram",
      condition: "startup logs are empty",
      config: { channels: { telegram: { enabled: true } } },
      log: "",
      messages: [expect.stringContaining("did not log a startup breadcrumb")],
      command: "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
      timeout: 10_000,
    },
    {
      channel: "telegram",
      condition: "startup times out",
      config: { channels: { telegram: { enabled: true } } },
      log: "[telegram] [default] bridge did not start within 15s; check channels.telegram.enabled",
      messages: [expect.stringContaining("did not start within")],
      forbidden: "bridge startup detected",
      command: "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
      timeout: 10_000,
    },
    {
      channel: "telegram",
      condition: "the credential placeholder mismatches",
      config: { channels: { telegram: { enabled: true } } },
      log: "[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder",
      messages: [expect.stringContaining("logged credential/startup warnings")],
      command: "tail -n 400 /tmp/gateway.log 2>/dev/null || true",
      timeout: 10_000,
    },
  ])("reports $channel health when $condition", async (fixture) => {
    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      undefined,
      createBuiltInRenderTemplateResolver(),
    ).buildPlan({
      sandboxName: "alpha",
      agent: "openclaw",
      workflow: "rebuild",
      isInteractive: false,
      configuredChannels: [fixture.channel],
      credentialAvailability: {
        DISCORD_BOT_TOKEN: true,
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });
    const runtimeSelection = { gatewayName: "recorded", workspace: "default" as const };
    const execute = vi
      .spyOn(sandboxTransport, "executeSandboxExecCommand")
      .mockImplementation(async (_name, command) => ({
        status: fixture.status ?? 0,
        stdout: command.includes("openclaw.json") ? JSON.stringify(fixture.config) : fixture.log,
        stderr: "",
      }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMessagingHealthChecksAfterRebuild("alpha", plan, vi.fn(), runtimeSelection);

    expect(execute).toHaveBeenCalledWith("alpha", fixture.command, fixture.timeout, {
      runtimeSelection,
      honorCallerTimeout: true,
    });
    expect(log.mock.calls.flat()).toEqual(expect.arrayContaining(fixture.messages));
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      fixture.forbidden ?? "invalid-output-with-secret",
    );
  });
});
