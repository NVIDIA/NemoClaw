// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

// Compatibility boundary: Hermes' Slack adapter requires Bolt-shaped xoxb-/xapp-
// placeholders in .env, while older OpenShell persisted bindings may still pass
// generic openshell:resolve:env:SLACK_* runtime env values into startup. The
// manifest owns these aliases, the reduced runtime plan carries them to the
// Hermes entrypoint, and runtime-config-guard only applies them for active,
// non-disabled Slack channels. The no-runtime-plan fallback is intentionally
// limited to runtime-config-guard.py's LEGACY_PROVIDER_PLACEHOLDER_KEYS; new
// channels must ship runtime-plan metadata instead of extending ambient fallback
// behavior. Remove this normalization once all persisted Hermes legacy bindings
// render manifest placeholders directly.
const slackRuntimeEnvAliases = [
  {
    envKey: "SLACK_BOT_TOKEN",
    match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
    value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    message:
      "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
  },
  {
    envKey: "SLACK_APP_TOKEN",
    match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
    value: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    message:
      "[channels] Normalized SLACK_APP_TOKEN runtime placeholder to the Bolt-compatible alias",
  },
] as const;

export const slackManifest = {
  schemaVersion: 1,
  id: "slack",
  displayName: "Slack",
  description: "Slack bot messaging",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "SLACK_BOT_TOKEN",
      formatPattern: "^xoxb-[A-Za-z0-9_-]+$",
      formatHint: "Slack bot tokens start with 'xoxb-' (e.g. xoxb-<workspace>-<bot>-<redacted>).",
      prompt: {
        label: "Slack Bot Token",
        help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
      },
    },
    {
      id: "appToken",
      kind: "secret",
      required: true,
      envKey: "SLACK_APP_TOKEN",
      formatPattern: "^xapp-[A-Za-z0-9_-]+$",
      formatHint:
        "Slack app tokens start with 'xapp-' (e.g. xapp-<version>-<app-id>-<team-id>-<redacted>).",
      prompt: {
        label: "Slack App Token (Socket Mode)",
        help: "Slack API → Your Apps → Basic Information → App-Level Tokens (xapp-...).",
      },
    },
    {
      id: "allowedUsers",
      kind: "config",
      required: false,
      envKey: "SLACK_ALLOWED_USERS",
      statePath: "allowedIds.slack",
      prompt: {
        label: "Slack Member IDs (comma-separated allowlist)",
        help: "In Slack, open each allowed human user's profile -> More -> Copy member ID. Enter one or more comma-separated member IDs, not the app or bot user ID. Member IDs look like U01ABC2DEF3.",
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    {
      id: "allowedChannels",
      kind: "config",
      required: false,
      envKey: "SLACK_ALLOWED_CHANNELS",
      statePath: "slackConfig.allowedChannels",
      prompt: {
        label: "Slack Channel IDs (comma-separated allowlist)",
        help: "Optional: enter comma-separated Slack channel IDs where the bot may answer @mentions. Channel IDs look like C012AB3CD.",
        emptyValueMessage: "channel @mentions stay unrestricted by channel ID",
      },
    },
  ],
  credentials: [
    {
      id: "slackBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-slack-bridge",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      primary: true,
    },
    {
      id: "slackAppToken",
      sourceInput: "appToken",
      providerName: "{sandboxName}-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    },
  ],
  policyPresets: [{ name: "slack", requiredAtCreate: true }],
  render: [
    {
      id: "slack-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.slack",
        value: {
          enabled: true,
          accounts: {
            default: {
              botToken: "{{credential.slackBotToken.placeholder}}",
              appToken: "{{credential.slackAppToken.placeholder}}",
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
              dmPolicy: "{{allowedIds.slack.dmPolicy}}",
              allowFrom: "{{allowedIds.slack.values}}",
              groupPolicy: "{{allowedIds.slack.groupPolicy}}",
              channels: "{{allowedIds.slack.channels}}",
            },
          },
        },
      },
    },
    {
      id: "slack-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.slack",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "slack-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "SLACK_BOT_TOKEN={{credential.slackBotToken.placeholder}}",
        "SLACK_APP_TOKEN={{credential.slackAppToken.placeholder}}",
        "SLACK_ALLOWED_USERS={{allowedIds.slack.csv}}",
        "SLACK_ALLOWED_CHANNELS={{slackConfig.allowedChannels.csv}}",
      ],
    },
    {
      id: "slack-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.slack",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "slack",
      visibility: {
        configKeys: ["slack"],
        logPatterns: ["slack"],
      },
      envAliases: slackRuntimeEnvAliases,
      nodePreloads: [
        {
          module: "slack-channel-guard",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Slack channel guard (unhandled-rejection safety net)",
          installedMessage: "[channels] Slack channel guard installed (NODE_OPTIONS updated)",
        },
      ],
      secretScans: [
        {
          path: "/sandbox/.openclaw/openclaw.json",
          pattern: "(?:xoxb|xapp)-(?!OPENSHELL-RESOLVE-ENV-)",
          message: "[SECURITY] Slack token leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    },
    hermes: {
      envAliases: slackRuntimeEnvAliases,
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/slack@{{openclaw.version}}",
      pin: true,
      required: true,
    },
  ],
  state: {
    persist: {
      allowedIds: ["allowedUsers"],
      slackConfig: ["allowedChannels"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.slack",
        env: "SLACK_ALLOWED_USERS",
      },
      {
        statePath: "slackConfig.allowedChannels",
        env: "SLACK_ALLOWED_CHANNELS",
      },
    ],
  },
  hooks: [
    {
      id: "slack-socket-mode-gateway-conflict",
      phase: "pre-enable",
      handler: "slack.socketModeGatewayConflict",
      onFailure: "abort",
    },
    {
      id: "slack-openclaw-bridge-health",
      phase: "health-check",
      handler: "slack.openclawBridgeHealth",
      agents: ["openclaw"],
      onFailure: "abort",
    },
    {
      id: "slack-socket-mode-gateway-status",
      phase: "status",
      handler: "slack.socketModeGatewayStatus",
      outputs: [
        {
          id: "gatewayOverlaps",
          kind: "status",
        },
      ],
    },
    {
      id: "slack-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
        {
          id: "appToken",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "slack-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "allowedChannels",
          kind: "config",
        },
      ],
    },
    {
      id: "slack-credential-validation",
      phase: "reachability-check",
      handler: "slack.validateCredentials",
      inputs: ["botToken", "appToken"],
      onFailure: "skip-channel",
    },
  ],
} as const satisfies ChannelManifest;
