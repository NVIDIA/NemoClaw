// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPlannerForTests, withPlannerEnv } from "../__test-utils__/planner-harness";

describe("planner empty-env normalization", () => {
  it("does not persist an empty TELEGRAM_REQUIRE_MENTION env var into the plan at the planner source boundary", async () => {
    const plan = await withPlannerEnv({ TELEGRAM_REQUIRE_MENTION: "" }, () =>
      createPlannerForTests().buildPlan({
        sandboxName: "demo",
        agent: "openclaw",
        workflow: "onboard",
        isInteractive: false,
        configuredChannels: ["telegram"],
        credentialAvailability: { TELEGRAM_BOT_TOKEN: true },
      }),
    );

    const requireMention = plan.channels
      .find((channel) => channel.channelId === "telegram")
      ?.inputs.find((input) => input.inputId === "requireMention");
    expect(requireMention).toBeDefined();
    expect(requireMention?.value).not.toBe("");
  });

  it("does not persist an empty DISCORD_REQUIRE_MENTION env var into the plan at the planner source boundary", async () => {
    const plan = await withPlannerEnv({ DISCORD_REQUIRE_MENTION: "" }, () =>
      createPlannerForTests().buildPlan({
        sandboxName: "demo",
        agent: "openclaw",
        workflow: "onboard",
        isInteractive: false,
        configuredChannels: ["discord"],
        credentialAvailability: { DISCORD_BOT_TOKEN: true },
      }),
    );

    const requireMention = plan.channels
      .find((channel) => channel.channelId === "discord")
      ?.inputs.find((input) => input.inputId === "requireMention");
    expect(requireMention?.value).not.toBe("");
  });

  it("does not persist an empty TEAMS_REQUIRE_MENTION env var into the plan at the planner source boundary", async () => {
    const plan = await withPlannerEnv(
      {
        TEAMS_REQUIRE_MENTION: "",
        MSTEAMS_APP_ID: "test-teams-app-id",
        MSTEAMS_TENANT_ID: "test-teams-tenant-id",
        TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
        MSTEAMS_PORT: "3977",
      },
      () =>
        createPlannerForTests().buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: false,
          configuredChannels: ["teams"],
          credentialAvailability: { MSTEAMS_APP_PASSWORD: true },
        }),
    );

    const requireMention = plan.channels
      .find((channel) => channel.channelId === "teams")
      ?.inputs.find((input) => input.inputId === "requireMention");
    expect(requireMention?.value).not.toBe("");
  });

  it("does not persist an empty TELEGRAM_GROUP_POLICY env var into the plan at the planner source boundary", async () => {
    const plan = await withPlannerEnv({ TELEGRAM_GROUP_POLICY: "" }, () =>
      createPlannerForTests().buildPlan({
        sandboxName: "demo",
        agent: "openclaw",
        workflow: "onboard",
        isInteractive: false,
        configuredChannels: ["telegram"],
        credentialAvailability: { TELEGRAM_BOT_TOKEN: true },
      }),
    );

    const groupPolicy = plan.channels
      .find((channel) => channel.channelId === "telegram")
      ?.inputs.find((input) => input.inputId === "groupPolicy");
    expect(groupPolicy?.value).not.toBe("");
  });
});
