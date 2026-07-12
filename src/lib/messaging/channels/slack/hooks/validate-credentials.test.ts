// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runMessagingHook } from "../../../hooks/hook-runner";
import { MessagingHookRegistry } from "../../../hooks/registry";
import { slackManifest } from "../manifest";
import {
  createSlackValidateCredentialsHook,
  SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
  type SlackValidateCredentialsHookOptions,
} from "./validate-credentials";

function registry(options: SlackValidateCredentialsHookOptions): MessagingHookRegistry {
  return new MessagingHookRegistry([
    {
      id: SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
      handler: createSlackValidateCredentialsHook(options),
    },
  ]);
}

function slackValidationHook() {
  const hook = slackManifest.hooks.find((entry) => entry.id === "slack-credential-validation");
  if (!hook) throw new Error("missing Slack credential validation hook");
  return hook;
}

describe("Slack credential validation hook", () => {
  it("uses the Slack-specific reachability handler declared by the manifest", () => {
    expect(slackValidationHook()).toMatchObject({
      phase: "reachability-check",
      handler: SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
      inputs: ["botToken", "appToken"],
      onFailure: "skip-channel",
    });
  });

  it("validates the collected bot and app tokens without exposing them in outputs", async () => {
    const validated: Array<{ readonly botToken: string; readonly appToken: string }> = [];

    await expect(
      runMessagingHook(
        slackValidationHook(),
        registry({
          validateCredentials: (tokens) => {
            validated.push(tokens);
            return { ok: true };
          },
          log: () => {},
        }),
        {
          channelId: "slack",
          inputs: {
            botToken: "xoxb-test-slack-token",
            appToken: "xapp-test-slack-token",
          },
        },
      ),
    ).resolves.toMatchObject({
      handlerId: SLACK_VALIDATE_CREDENTIALS_HOOK_HANDLER_ID,
      phase: "reachability-check",
      outputs: {},
    });
    expect(validated).toEqual([
      {
        botToken: "xoxb-test-slack-token",
        appToken: "xapp-test-slack-token",
      },
    ]);
  });

  it("logs skip-env validation warnings without failing the hook", async () => {
    const logs: string[] = [];

    await runMessagingHook(
      slackValidationHook(),
      registry({
        validateCredentials: () => ({
          ok: true,
          skipped: true,
          message: "Live Slack API validation skipped because test.",
        }),
        log: (message) => logs.push(message),
      }),
      {
        channelId: "slack",
        inputs: {
          botToken: "xoxb-test-slack-token",
          appToken: "xapp-test-slack-token",
        },
      },
    );

    expect(logs.join("\n")).toContain("Live Slack API validation skipped because test.");
  });

  it("skips Slack when the Slack API rejects a credential", async () => {
    const logs: string[] = [];

    await expect(
      runMessagingHook(
        slackValidationHook(),
        registry({
          validateCredentials: () => ({
            ok: false,
            kind: "rejected",
            tokenKind: "app",
            credential: "app",
            error: "invalid_auth",
            httpStatus: 200,
            curlStatus: 0,
            message: "Slack app token was rejected by Slack API: invalid_auth.",
          }),
          log: (message) => logs.push(message),
        }),
        {
          channelId: "slack",
          inputs: {
            botToken: "xoxb-fake-bot-token",
            appToken: "xapp-fake-app-token",
          },
        },
      ),
    ).rejects.toThrow("Slack credential validation failed");
    expect(logs.join("\n")).toContain("Slack app token was rejected by Slack API");
    expect(logs.join("\n")).toContain("Skipped slack (invalid Slack credentials)");
    expect(logs.join("\n")).not.toContain("xoxb-fake-bot-token");
    expect(logs.join("\n")).not.toContain("xapp-fake-app-token");
  });

  it("skips Slack when Slack API validation is unavailable", async () => {
    const logs: string[] = [];

    await expect(
      runMessagingHook(
        slackValidationHook(),
        registry({
          validateCredentials: () => ({
            ok: false,
            kind: "indeterminate",
            tokenKind: "bot",
            credential: "bot",
            httpStatus: 0,
            curlStatus: 7,
            message: "Slack bot token could not be validated because Slack API was unreachable.",
          }),
          log: (message) => logs.push(message),
        }),
        {
          channelId: "slack",
          inputs: {
            botToken: "xoxb-fake-bot-token",
            appToken: "xapp-fake-app-token",
          },
        },
      ),
    ).rejects.toThrow("Slack credential validation failed");
    expect(logs.join("\n")).toContain("Slack API validation unavailable");
  });

  it("requires both Slack hook inputs", async () => {
    await expect(
      runMessagingHook(
        slackValidationHook(),
        registry({ validateCredentials: () => ({ ok: true }) }),
        {
          channelId: "slack",
          inputs: {
            botToken: "xoxb-test-slack-token",
          },
        },
      ),
    ).rejects.toThrow("Slack credential validation requires botToken and appToken");
  });
});
