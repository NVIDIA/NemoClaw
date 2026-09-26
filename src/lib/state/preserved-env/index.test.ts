// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  extractPreservedEnvAssignments,
  HERMES_PRESERVED_ENV_INVENTORY,
  validatePreservedEnvFiles,
} from "./index";

const inventory = HERMES_PRESERVED_ENV_INVENTORY[0]!;

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
});
