// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyMessagingAgentRenderToEnvLines } from "../../messaging/applier/build/messaging-build-applier.mts";
import type { SandboxMessagingPlan } from "../../messaging/manifest/types";
import {
  extractPreservedEnvAssignments,
  HERMES_PRESERVED_ENV_INVENTORY,
  mergeHermesPreservedEnvIntoMessagingPlan,
  validatePreservedEnvFiles,
} from "./index";

const inventory = HERMES_PRESERVED_ENV_INVENTORY[0]!;

function hermesPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "hermes",
    workflow: "rebuild",
    channels: [
      {
        channelId: "slack",
        displayName: "Slack",
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
    agentRender: [
      {
        channelId: "slack",
        renderId: "slack-hermes-env",
        kind: "env-lines",
        agent: "hermes",
        target: "~/.hermes/.env",
        lines: ["SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN"],
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("preserved environment inventory", () => {
  it("captures home-channel assignments for every supported Hermes channel (#7803)", () => {
    const contents = [
      "TELEGRAM_HOME_CHANNEL=-100123",
      'DISCORD_HOME_CHANNEL_NAME="release #1"',
      "SLACK_HOME_CHANNEL=C0123",
      "SLACK_HOME_CHANNEL_THREAD_ID=",
      "WHATSAPP_HOME_CHANNEL=1203630@g.us",
      "WEIXIN_HOME_CHANNEL=wx-room",
      "TEAMS_HOME_CHANNEL=19:meeting@example",
      "SLACK_BOT_TOKEN=xoxb-secret",
      "MATRIX_HOME_ROOM=!room:example",
      "EMAIL_HOME_ADDRESS=ops@example.com",
      "",
    ].join("\n");

    expect(extractPreservedEnvAssignments(contents, inventory)).toEqual([
      "TELEGRAM_HOME_CHANNEL=-100123",
      'DISCORD_HOME_CHANNEL_NAME="release #1"',
      "SLACK_HOME_CHANNEL=C0123",
      "SLACK_HOME_CHANNEL_THREAD_ID=",
      "WHATSAPP_HOME_CHANNEL=1203630@g.us",
      "WEIXIN_HOME_CHANNEL=wx-room",
      "TEAMS_HOME_CHANNEL=19:meeting@example",
    ]);
  });

  it("rejects duplicate matching assignments instead of choosing one (#7803)", () => {
    expect(() =>
      extractPreservedEnvAssignments(
        "SLACK_HOME_CHANNEL=C1\nexport SLACK_HOME_CHANNEL=C2\n",
        inventory,
      ),
    ).toThrow(/repeats key 'SLACK_HOME_CHANNEL'/);
  });

  it("validates prepared backup assignments against the current inventory (#7803)", () => {
    expect(
      validatePreservedEnvFiles(
        [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C1"] }],
        HERMES_PRESERVED_ENV_INVENTORY,
      ),
    ).toBe(true);
    expect(
      validatePreservedEnvFiles(
        [{ path: ".env", assignments: ["SLACK_BOT_TOKEN=xoxb-secret"] }],
        HERMES_PRESERVED_ENV_INVENTORY,
      ),
    ).toBe(false);
    expect(
      validatePreservedEnvFiles(
        [{ path: ".env", assignments: ["SLACK_HOME_CHANNEL=C1\nINJECTED=1"] }],
        HERMES_PRESERVED_ENV_INVENTORY,
      ),
    ).toBe(false);
  });

  it("applies restored values before current manifest renders (#7803)", () => {
    const plan = hermesPlan();
    const currentRender = plan.agentRender[0];
    expect(currentRender?.kind).toBe("env-lines");
    const currentEnvRender = currentRender as SandboxMessagingPlan["agentRender"][number] & {
      kind: "env-lines";
      lines: string[];
    };
    const merged = mergeHermesPreservedEnvIntoMessagingPlan(
      {
        ...plan,
        agentRender: [
          {
            ...currentEnvRender,
            lines: [...currentEnvRender.lines, "SLACK_HOME_CHANNEL=CURRENT"],
          },
        ],
      },
      [
        {
          path: ".env",
          assignments: [
            "SLACK_HOME_CHANNEL=C0123",
            "SLACK_HOME_CHANNEL_NAME=alerts",
            "SLACK_HOME_CHANNEL_THREAD_ID=",
          ],
        },
      ],
    );

    expect(merged?.agentRender.map((render) => render.renderId)).toEqual([
      "hermes-preserved-home-channels",
      "slack-hermes-env",
    ]);
    expect(merged?.agentRender[0]).toMatchObject({
      channelId: "slack",
      target: "~/.hermes/.env",
      lines: [
        "SLACK_HOME_CHANNEL=C0123",
        "SLACK_HOME_CHANNEL_NAME=alerts",
        "SLACK_HOME_CHANNEL_THREAD_ID=",
      ],
    });
    const envLines: string[] = [];
    applyMessagingAgentRenderToEnvLines(envLines, merged, "~/.hermes/.env");
    expect(envLines).toContain("SLACK_HOME_CHANNEL=CURRENT");
    expect(envLines).not.toContain("SLACK_HOME_CHANNEL=C0123");
  });

  it("retains restored values when the current manifest leaves them unset (#7803)", () => {
    const merged = mergeHermesPreservedEnvIntoMessagingPlan(
      { ...hermesPlan(), workflow: "onboard" },
      [
        {
          path: ".env",
          assignments: ["SLACK_HOME_CHANNEL=C0123"],
        },
      ],
    );
    const envLines: string[] = [];
    applyMessagingAgentRenderToEnvLines(envLines, merged, "~/.hermes/.env");
    expect(envLines).toContain("SLACK_HOME_CHANNEL=C0123");
  });

  it("rejects unscoped assignments at the merge boundary (#7803)", () => {
    expect(() =>
      mergeHermesPreservedEnvIntoMessagingPlan(hermesPlan(), [
        { path: ".env", assignments: ["SLACK_BOT_TOKEN=xoxb-secret"] },
      ]),
    ).toThrow("Invalid preserved environment assignments");
  });

  it("does not apply preserved values without an active Hermes environment render (#7803)", () => {
    const plan = hermesPlan();
    const inactivePlan: SandboxMessagingPlan = {
      ...plan,
      channels: plan.channels.map((channel) => ({ ...channel, active: false })),
    };

    expect(
      mergeHermesPreservedEnvIntoMessagingPlan(inactivePlan, [
        { path: ".env", assignments: ["SLACK_HOME_CHANNEL=C0123"] },
      ]),
    ).toBe(inactivePlan);
  });
});
