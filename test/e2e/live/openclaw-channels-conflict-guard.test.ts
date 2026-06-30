// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxMessagingPlan } from "../../../src/lib/messaging/manifest";
import { hashCredential } from "../../../src/lib/security/credential-hash";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { CHANNELS, type MessagingChannel } from "./channels-lifecycle-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.resolve(
  process.env.NEMOCLAW_CLI_BIN ?? path.join(REPO_ROOT, "bin", "nemoclaw.js"),
);
const CONFLICT_TIMEOUT_MS = 30_000;
const runLiveTest = shouldRunLiveE2E() ? test : test.skip;

type SecretFixture = {
  credentialId: string;
  sourceInput: string;
  providerEnvKey: string;
  providerName: (sandboxName: string) => string;
  placeholder: string;
  token: string;
};

type ChannelFixture = {
  displayName: string;
  authMode: SandboxMessagingPlan["channels"][number]["authMode"];
  secrets: readonly SecretFixture[];
  env: NodeJS.ProcessEnv;
};

const CHANNEL_FIXTURES: Record<MessagingChannel, ChannelFixture> = {
  telegram: {
    displayName: "Telegram",
    authMode: "token-paste",
    secrets: [
      {
        credentialId: "telegramBotToken",
        sourceInput: "botToken",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        providerName: (sandboxName) => `${sandboxName}-telegram-bridge`,
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        token: "123456:openclaw-channels-conflict-guard-fake-token",
      },
    ],
    env: {
      TELEGRAM_ALLOWED_IDS: "123456789",
      NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    },
  },
  discord: {
    displayName: "Discord",
    authMode: "token-paste",
    secrets: [
      {
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        providerName: (sandboxName) => `${sandboxName}-discord-bridge`,
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        token: "test-fake-discord-conflict-guard-token",
      },
    ],
    env: {
      DISCORD_SERVER_ID: "1491590992753590594",
      DISCORD_USER_ID: "1005536447329222676",
      DISCORD_REQUIRE_MENTION: "0",
    },
  },
  wechat: {
    displayName: "WeChat",
    authMode: "host-qr",
    secrets: [
      {
        credentialId: "wechatBotToken",
        sourceInput: "botToken",
        providerEnvKey: "WECHAT_BOT_TOKEN",
        providerName: (sandboxName) => `${sandboxName}-wechat-bridge`,
        placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        token: "test-fake-wechat-conflict-guard-token",
      },
    ],
    env: {
      WECHAT_ACCOUNT_ID: "e2e-conflict-guard-wechat-account",
      WECHAT_BASE_URL: "https://ilinkai.wechat.com",
      WECHAT_USER_ID: "wxid_conflict_guard",
      WECHAT_ALLOWED_IDS: "wxid_conflict_guard",
    },
  },
  slack: {
    displayName: "Slack",
    authMode: "token-paste",
    secrets: [
      {
        credentialId: "slackBotToken",
        sourceInput: "botToken",
        providerEnvKey: "SLACK_BOT_TOKEN",
        providerName: (sandboxName) => `${sandboxName}-slack-bridge`,
        placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        token: "xoxb-openclaw-channels-conflict-guard",
      },
      {
        credentialId: "slackAppToken",
        sourceInput: "appToken",
        providerEnvKey: "SLACK_APP_TOKEN",
        providerName: (sandboxName) => `${sandboxName}-slack-app`,
        placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
        token: "xapp-openclaw-channels-conflict-guard",
      },
    ],
    env: {
      SLACK_ALLOWED_USERS: "U0123456789",
      NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1",
    },
  },
  whatsapp: {
    displayName: "WhatsApp",
    authMode: "in-sandbox-qr",
    secrets: [],
    env: {
      WHATSAPP_ALLOWED_IDS: "15551234567",
    },
  },
  teams: {
    displayName: "Microsoft Teams",
    authMode: "token-paste",
    secrets: [
      {
        credentialId: "teamsClientSecret",
        sourceInput: "clientSecret",
        providerEnvKey: "MSTEAMS_APP_PASSWORD",
        providerName: (sandboxName) => `${sandboxName}-teams-bridge`,
        placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        token: "test-fake-teams-conflict-guard-secret",
      },
    ],
    env: {
      MSTEAMS_APP_ID: "test-teams-app-id-openclaw-channels-conflict-guard",
      MSTEAMS_TENANT_ID: "test-teams-tenant-id-openclaw-channels-conflict-guard",
      TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
      MSTEAMS_PORT: "3978",
      TEAMS_REQUIRE_MENTION: "0",
    },
  },
};

function mustHash(value: string): string {
  const hash = hashCredential(value);
  if (!hash) throw new Error("test fixture credential must hash");
  return hash;
}

function channelPlan(channel: MessagingChannel): SandboxMessagingPlan["channels"][number] {
  const fixture = CHANNEL_FIXTURES[channel];
  return {
    channelId: channel,
    displayName: fixture.displayName,
    authMode: fixture.authMode,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

function credentialBindings(
  sandboxName: string,
  channel: MessagingChannel,
): SandboxMessagingPlan["credentialBindings"] {
  return CHANNEL_FIXTURES[channel].secrets.map((secret) => ({
    channelId: channel,
    credentialId: secret.credentialId,
    sourceInput: secret.sourceInput,
    providerName: secret.providerName(sandboxName),
    providerEnvKey: secret.providerEnvKey,
    placeholder: secret.placeholder,
    credentialAvailable: true,
    credentialHash: mustHash(secret.token),
  }));
}

function channelPlanWithCredential(
  sandboxName: string,
  channel: MessagingChannel,
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [channelPlan(channel)],
    disabledChannels: [],
    credentialBindings: credentialBindings(sandboxName, channel),
    networkPolicy: {
      presets: [channel],
      entries: [
        {
          channelId: channel,
          presetName: channel,
          policyKeys: [channel],
          source: "manifest",
        },
      ],
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function writeConflictRegistry(homeDir: string, channel: MessagingChannel): string {
  const registryDir = path.join(homeDir, ".nemoclaw");
  const registryFile = path.join(registryDir, "sandboxes.json");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify(
      {
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: {
            name: "alpha",
            createdAt: "2026-01-01T00:00:00.000Z",
            gpuEnabled: false,
            policies: [],
            agent: "openclaw",
            gatewayName: "nemoclaw",
          },
          bob: {
            name: "bob",
            createdAt: "2026-01-01T00:00:01.000Z",
            gpuEnabled: false,
            policies: [channel],
            agent: "openclaw",
            gatewayName: "nemoclaw",
            messaging: {
              schemaVersion: 1,
              plan: channelPlanWithCredential("bob", channel),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return registryFile;
}

function commandEnv(homeDir: string, channel: MessagingChannel): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ["PATH", "Path", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "SystemRoot"].flatMap((key) => {
      const value = process.env[key];
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
  return {
    ...inherited,
    HOME: homeDir,
    NO_COLOR: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SKIP_TELEGRAM_REACHABILITY: "1",
    OPENSHELL_GATEWAY: "nemoclaw",
    ...CHANNEL_FIXTURES[channel].env,
    ...Object.fromEntries(
      CHANNEL_FIXTURES[channel].secrets.map((secret) => [secret.providerEnvKey, secret.token]),
    ),
  };
}

for (const channel of CHANNELS) {
  const title =
    channel === "whatsapp"
      ? "openclaw channels conflict guard documents WhatsApp QR-only credential boundary"
      : `openclaw channels conflict guard handles duplicate ${channel} credentials without leaking secrets`;
  runLiveTest(title, testTimeoutOptions(CONFLICT_TIMEOUT_MS), async ({ artifacts, host }) => {
    const tokens = CHANNEL_FIXTURES[channel].secrets.map((secret) => secret.token);
    const hashes = tokens.map(mustHash);
    artifacts.addRedactionValues([...tokens, ...hashes]);
    if (channel === "whatsapp") {
      await artifacts.writeJson("openclaw-channels-conflict-guard-whatsapp.json", {
        channel,
        assertion:
          "WhatsApp is covered by CHANNELS but has no host-side credential in the manifest, so duplicate credential conflict detection intentionally has no token/hash to compare.",
      });
      expect(CHANNEL_FIXTURES[channel].secrets).toHaveLength(0);
      return;
    }

    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      `NemoClaw CLI entrypoint missing: ${CLI_ENTRYPOINT}`,
    ).toBe(true);

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-conflict-guard-"));
    try {
      const registryFile = writeConflictRegistry(homeDir, channel);
      const before = fs.readFileSync(registryFile, "utf8");
      await artifacts.writeJson(`openclaw-channels-conflict-guard-${channel}-seed.json`, {
        registryFile,
        currentSandbox: "alpha",
        conflictingSandbox: "bob",
        channel,
        credentialHashChars: hashes.map((hash) => hash.length),
      });

      const add = await host.command(
        process.execPath,
        [CLI_ENTRYPOINT, "alpha", "channels", "add", channel],
        {
          artifactName: `channels-add-${channel}-conflict-guard`,
          cwd: REPO_ROOT,
          env: commandEnv(homeDir, channel),
          redactionValues: [...tokens, ...hashes],
          timeoutMs: CONFLICT_TIMEOUT_MS,
        },
      );
      const output = resultText(add);

      expect(add.timedOut).toBe(false);
      expect(add.signal).toBeNull();
      expect(add.exitCode).toBe(1);
      expect(output).toContain(`Sandbox 'bob' uses the same ${channel} credential`);
      expect(output).toContain("Aborting");
      expect(output).toContain("--force");
      expect(output).toContain(`channels remove ${channel}`);
      for (const value of [...tokens, ...hashes]) {
        expect(output).not.toContain(value);
      }
      expect(output).not.toContain("[REDACTED]");

      const after = fs.readFileSync(registryFile, "utf8");
      expect(after).toBe(before);
      const parsed = JSON.parse(after) as {
        sandboxes?: {
          alpha?: { messaging?: unknown };
          bob?: { messaging?: unknown };
        };
      };
      expect(parsed.sandboxes?.alpha?.messaging).toBeUndefined();
      expect(parsed.sandboxes?.bob?.messaging).toBeDefined();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
}
