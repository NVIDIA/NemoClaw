// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression guards for #4869: the generated openclaw.json Slack account must
// keep its DM and channel allowlists synchronized to SLACK_ALLOWED_USERS, and
// an unset allowlist must leave every allowlist key absent. The positive
// users-only and allowed-channels paths are covered in
// generate-openclaw-config.test.ts (#3729); these guards pin the two halves the
// issue is named after — the backward-compatibility negative path and the
// scope-synchronization invariant — without growing that file past its budget.

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";
import {
  applyMessagingAgentRenderToObject,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

/** Minimal env for a valid config-generation run with Slack enabled. */
function slackEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return withLegacyMessagingPlanEnv(
    {
      NEMOCLAW_MODEL: "test-model",
      NEMOCLAW_PROVIDER_KEY: "test-provider",
      NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
      NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
      NEMOCLAW_INFERENCE_API: "openai",
      NEMOCLAW_AGENT_TIMEOUT: "600",
      HOME: "/tmp",
      NEMOCLAW_MESSAGING_CHANNELS_B64: Buffer.from(JSON.stringify(["slack"])).toString("base64"),
      ...overrides,
    },
    "openclaw",
  );
}

function slackAccount(env: Record<string, string>): any {
  const config = buildConfig(env as any);
  applyMessagingAgentRenderToObject(
    config,
    readMessagingBuildPlanFromEnv(env, "openclaw"),
    "openclaw.json",
  );
  return config.channels.slack.accounts.default;
}

describe("generate-openclaw-config.mts: Slack allowlist guards (#4869)", () => {
  // Backward-compatibility negative path: when Slack is enabled but no allowlist
  // is configured, all four allowlist keys must stay absent. This proves
  // dmPolicy / allowFrom / groupPolicy / channels are derived only from
  // SLACK_ALLOWED_USERS and that an unset allowlist never silently broadens
  // (listen everywhere) or narrows (disable) channel scope.
  it("keeps all Slack allowlist keys absent when no allowlist is configured", () => {
    const slack = slackAccount(slackEnv());

    expect(slack.enabled).toBe(true);
    expect(slack.dmPolicy).toBeUndefined();
    expect(slack.allowFrom).toBeUndefined();
    expect(slack.groupPolicy).toBeUndefined();
    expect(slack.channels).toBeUndefined();
  });

  // Scope synchronization: #4869 reported channels['*'] coming back empty while
  // allowFrom was populated. Assert the per-channel wildcard allowlist is fully
  // populated and that its users are the exact same IDs as the DM allowFrom
  // list, so the two scopes can never drift out of lockstep.
  it("keeps Slack DM and channel allowlists synchronized to SLACK_ALLOWED_USERS", () => {
    const allowedUsers = ["U_DUMMY_ALLOW1", "U_DUMMY_ALLOW2"];
    const slack = slackAccount(
      slackEnv({
        NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: Buffer.from(
          JSON.stringify({ slack: allowedUsers }),
        ).toString("base64"),
      }),
    );

    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(allowedUsers);
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.channels?.["*"]).toEqual({
      enabled: true,
      requireMention: true,
      users: allowedUsers,
    });
    expect(slack.channels["*"].users).toEqual(slack.allowFrom);
  });
});
