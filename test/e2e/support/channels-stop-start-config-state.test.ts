// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  type HermesRevisionScopedCredentialChannel,
  hermesRevisionScopedCredentialLinePattern,
} from "../fixtures/hermes-channel-credential-state.ts";
import {
  type OpenClawChannelConfigState,
  openClawChannelIsActive,
  openClawChannelIsInert,
  openClawChannelStateProbeScript,
} from "../live/channels-stop-start-config-state.ts";

const ABSENT: OpenClawChannelConfigState = {
  channelPresent: false,
  channelActivationUsesAccounts: false,
  channelEnabled: false,
  channelDisabled: false,
  channelHasEnabledAccount: false,
  channelHasSettings: false,
  pluginPresent: false,
  pluginEnabled: false,
  pluginDisabled: false,
  pluginHasSettings: false,
};

const MANAGED_IMAGE_DISABLED: OpenClawChannelConfigState = {
  ...ABSENT,
  channelPresent: true,
  channelDisabled: true,
  pluginPresent: true,
  pluginDisabled: true,
};

function parseRenderedOpenClawState(
  channel: string,
  config: Record<string, unknown>,
): OpenClawChannelConfigState {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-channel-state-"));
  const configPath = path.join(fixtureDir, "openclaw.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(
      "python3",
      ["-c", openClawChannelStateProbeScript(channel, configPath)],
      {
        encoding: "utf8",
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as OpenClawChannelConfigState;
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

describe("channels stop/start OpenClaw configuration state", () => {
  it.each([
    ["missing entries", ABSENT],
    ["managed-image disabled entries", MANAGED_IMAGE_DISABLED],
  ])("treats %s as inert (#9820)", (_case, state) => {
    expect(openClawChannelIsInert(state)).toBe(true);
    expect(openClawChannelIsActive(state)).toBe(false);
  });

  it("treats an enabled plugin without channel configuration as inert (#9820)", () => {
    const state = {
      ...ABSENT,
      pluginPresent: true,
      pluginEnabled: true,
    };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(true);
  });

  it("treats an enabled channel and plugin as active (#9820)", () => {
    const state = {
      ...MANAGED_IMAGE_DISABLED,
      channelEnabled: true,
      channelDisabled: false,
      channelHasSettings: true,
      pluginEnabled: true,
      pluginDisabled: false,
    };

    expect(openClawChannelIsActive(state)).toBe(true);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it("parses an enabled WeChat account and plugin as active (#9820)", () => {
    const state = parseRenderedOpenClawState("wechat", {
      channels: {
        "openclaw-weixin": { accounts: { "wechat-account": { enabled: true } } },
      },
      plugins: { entries: { "openclaw-weixin": { enabled: true } } },
    });

    expect(state.channelActivationUsesAccounts).toBe(true);
    expect(state.channelEnabled).toBe(false);
    expect(state.channelHasEnabledAccount).toBe(true);
    expect(openClawChannelIsActive(state)).toBe(true);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    "rejects one-sided WeChat account/plugin activation (%s/%s) (#9820)",
    (accountEnabled, pluginEnabled) => {
      const state = parseRenderedOpenClawState("wechat", {
        channels: {
          "openclaw-weixin": {
            accounts: { "wechat-account": { enabled: accountEnabled } },
          },
        },
        plugins: { entries: { "openclaw-weixin": { enabled: pluginEnabled } } },
      });

      expect(openClawChannelIsActive(state)).toBe(false);
      expect(openClawChannelIsInert(state)).toBe(false);
    },
  );

  it("rejects channel activation without an enabled plugin as active or inert (#9820)", () => {
    const overrides = { channelEnabled: true, channelDisabled: false };
    const state = { ...MANAGED_IMAGE_DISABLED, ...overrides };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it("rejects disabled channel settings as inert (#9820)", () => {
    const state = { ...MANAGED_IMAGE_DISABLED, channelHasSettings: true };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it("rejects a present channel entry without an explicit state as inert (#9820)", () => {
    const state = { ...MANAGED_IMAGE_DISABLED, channelDisabled: false };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(false);
  });
});

describe("channels stop/start Hermes configuration state", () => {
  it.each<
    [channel: HermesRevisionScopedCredentialChannel, targetEnvKey: string, credentialEnvKey: string]
  >([
    ["wechat", "WEIXIN_TOKEN", "WECHAT_BOT_TOKEN"],
    ["teams", "TEAMS_CLIENT_SECRET", "MSTEAMS_APP_PASSWORD"],
  ])(
    "accepts only a revision-scoped %s credential placeholder (#10079)",
    (channel, targetEnvKey, credentialEnvKey) => {
      const pattern = new RegExp(hermesRevisionScopedCredentialLinePattern(channel));

      expect(pattern.test(`${targetEnvKey}=openshell:resolve:env:v17_${credentialEnvKey}`)).toBe(
        true,
      );
      expect(pattern.test(`${targetEnvKey}=openshell:resolve:env:${credentialEnvKey}`)).toBe(false);
      expect(pattern.test(`${targetEnvKey}=raw-secret`)).toBe(false);
    },
  );
});
