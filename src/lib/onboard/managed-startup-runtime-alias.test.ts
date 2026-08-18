// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { slackManifest } from "../messaging/channels/slack/manifest.ts";
import {
  type ManagedStartupJsonObject,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile.ts";

const [slackBotAlias] = slackManifest.runtime.hermes.envAliases;

function profileWithAliases(aliases: readonly ManagedStartupJsonObject[]): ManagedStartupProfile {
  const profile = managedStartupE2eProfile("hermes");
  return {
    ...profile,
    messaging: {
      plan: {
        schemaVersion: 1,
        agent: "hermes",
        runtimeSetup: {
          nodePreloads: [],
          envAliases: aliases.map((alias) => ({ channelId: "slack", ...alias })),
          secretScans: [],
        },
      },
    },
  };
}

describe("managed startup runtime aliases", () => {
  it("accepts the stock Slack runtime aliases (#9397)", () => {
    expect(() =>
      validateManagedStartupProfile(profileWithAliases(slackManifest.runtime.hermes.envAliases)),
    ).not.toThrow();
  });

  it.each([
    ["an invalid environment key", { ...slackBotAlias, envKey: "BAD KEY" }],
    [
      "an unanchored resolver expression",
      { ...slackBotAlias, match: "openshell:resolve:env:SLACK_BOT_TOKEN" },
    ],
    [
      "a resolver expression for another key",
      {
        ...slackBotAlias,
        match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
      },
    ],
    [
      "a placeholder for another key",
      { ...slackBotAlias, value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN" },
    ],
    ["a raw credential", { ...slackBotAlias, value: `xoxb-${"a".repeat(32)}` }],
  ])("rejects %s (#9397)", (_label, alias) => {
    expect(() => validateManagedStartupProfile(profileWithAliases([alias]))).toThrow(
      /credential-shaped string data/,
    );
  });

  it.each([slackBotAlias.match, slackBotAlias.value])(
    "rejects runtime alias data outside the schema-owned path (#9397)",
    (runtimeAliasData) => {
      const profile = profileWithAliases([]);
      expect(() =>
        validateManagedStartupProfile({
          ...profile,
          messaging: {
            plan: {
              ...profile.messaging.plan,
              note: runtimeAliasData,
            },
          },
        }),
      ).toThrow(/credential-shaped string data/);
    },
  );
});
