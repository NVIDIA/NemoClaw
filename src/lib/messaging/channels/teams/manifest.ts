// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const teamsManifest = {
  schemaVersion: 1,
  id: "teams",
  displayName: "Microsoft Teams",
  description: "Microsoft Teams bot messaging (experimental)",
  enrollmentNotes: [
    "Microsoft Teams requires a public HTTPS webhook endpoint at /api/messages; expose the configured Teams webhook port before installing the Teams app.",
    "Use Azure AD object IDs in TEAMS_ALLOWED_USERS so only authorized users can interact with the bot.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "appId",
      kind: "config",
      required: true,
      envKey: "MSTEAMS_APP_ID",
      envAliases: ["TEAMS_CLIENT_ID"],
      statePath: "teamsConfig.appId",
      prompt: {
        label: "Microsoft Teams Client ID",
        help: "Run `teams app create --endpoint https://<public-url>/api/messages`, then copy CLIENT_ID.",
      },
    },
    {
      id: "clientSecret",
      kind: "secret",
      required: true,
      envKey: "MSTEAMS_APP_PASSWORD",
      envAliases: ["TEAMS_CLIENT_SECRET"],
      prompt: {
        label: "Microsoft Teams Client Secret",
        help: "Use the CLIENT_SECRET printed by `teams app create`. It is shown once; rotate it in Entra ID if it was lost.",
      },
    },
    {
      id: "tenantId",
      kind: "config",
      required: true,
      envKey: "MSTEAMS_TENANT_ID",
      envAliases: ["TEAMS_TENANT_ID"],
      statePath: "teamsConfig.tenantId",
      prompt: {
        label: "Microsoft Teams Tenant ID",
        help: "Use the TENANT_ID printed by `teams app create` or shown by `teams status --verbose`.",
      },
    },
    {
      id: "allowedUsers",
      kind: "config",
      required: false,
      envKey: "TEAMS_ALLOWED_USERS",
      envAliases: ["MSTEAMS_ALLOWED_USERS"],
      statePath: "allowedIds.teams",
      prompt: {
        label: "Microsoft Teams AAD Object IDs (comma-separated allowlist)",
        help: "Recommended: run `teams status --verbose` and enter the Azure AD object IDs allowed to use the bot.",
      },
    },
    {
      id: "webhookPort",
      kind: "config",
      required: false,
      envKey: "MSTEAMS_PORT",
      envAliases: ["TEAMS_PORT"],
      statePath: "teamsConfig.webhookPort",
      defaultValue: "3978",
      prompt: {
        label: "Microsoft Teams webhook port",
        help: "Local bot webhook port to expose publicly. Defaults to 3978 and serves /api/messages.",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "TEAMS_REQUIRE_MENTION",
      statePath: "teamsConfig.requireMention",
      validValues: ["0", "1"],
      defaultValue: "1",
      prompt: {
        label: "Microsoft Teams mention mode",
        help: "Controls OpenClaw group and channel behavior only. Direct messages are unaffected.",
      },
    },
  ],
  credentials: [
    {
      id: "teamsClientSecret",
      sourceInput: "clientSecret",
      providerName: "{sandboxName}-teams-bridge",
      providerEnvKey: "MSTEAMS_APP_PASSWORD",
      placeholder: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
      primary: true,
    },
  ],
  policyPresets: [{ name: "teams", policyKeys: ["teams"] }],
  hostForward: {
    port: "{{teamsConfig.webhookPort}}",
    label: "Microsoft Teams webhook",
  },
  render: [
    {
      id: "teams-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.msteams",
        value: {
          enabled: true,
          appId: "{{teamsConfig.appId}}",
          appPassword: "{{credential.teamsClientSecret.placeholder}}",
          tenantId: "{{teamsConfig.tenantId}}",
          webhook: {
            port: "{{teamsConfig.webhookPort}}",
            path: "/api/messages",
          },
          healthMonitor: {
            enabled: false,
          },
          dmPolicy: "{{allowedIds.teams.dmPolicy}}",
          allowFrom: "{{allowedIds.teams.values}}",
          groupPolicy: "open",
          requireMention: "{{teamsConfig.requireMention}}",
        },
      },
    },
    {
      id: "teams-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.msteams",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "teams-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "TEAMS_CLIENT_ID={{teamsConfig.appId}}",
        "TEAMS_CLIENT_SECRET={{credential.teamsClientSecret.placeholder}}",
        "TEAMS_TENANT_ID={{teamsConfig.tenantId}}",
        "TEAMS_ALLOWED_USERS={{allowedIds.teams.csv}}",
        "TEAMS_PORT={{teamsConfig.webhookPort}}",
      ],
    },
    {
      id: "teams-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.teams",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "msteams",
      visibility: {
        configKeys: ["msteams"],
        logPatterns: ["msteams", "teams"],
      },
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/msteams@{{openclaw.version}}",
      pin: true,
      required: true,
    },
    {
      id: "hermesTeamsAppsPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "microsoft-teams-apps==2.0.13.4",
      required: true,
    },
    {
      id: "hermesAiohttpPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "aiohttp==3.14.1",
      required: true,
    },
  ],
  state: {
    persist: {
      teamsConfig: ["appId", "tenantId", "webhookPort", "requireMention"],
      allowedIds: ["allowedUsers"],
    },
    rebuildHydration: [
      {
        statePath: "teamsConfig.appId",
        env: "MSTEAMS_APP_ID",
      },
      {
        statePath: "teamsConfig.tenantId",
        env: "MSTEAMS_TENANT_ID",
      },
      {
        statePath: "allowedIds.teams",
        env: "TEAMS_ALLOWED_USERS",
      },
      {
        statePath: "teamsConfig.webhookPort",
        env: "MSTEAMS_PORT",
      },
      {
        statePath: "teamsConfig.requireMention",
        env: "TEAMS_REQUIRE_MENTION",
      },
    ],
  },
  hooks: [
    {
      id: "teams-host-forward-port-conflict",
      phase: "pre-enable",
      handler: "teams.hostForwardPortConflict",
      inputs: ["webhookPort"],
      onFailure: "abort",
    },
    {
      id: "teams-host-forward-port-status",
      phase: "status",
      handler: "teams.hostForwardPortStatus",
      outputs: [
        {
          id: "hostForwardPortOverlaps",
          kind: "status",
        },
      ],
    },
    {
      id: "teams-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "clientSecret",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "teams-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "appId",
          kind: "config",
          required: true,
        },
        {
          id: "tenantId",
          kind: "config",
          required: true,
        },
        {
          id: "allowedUsers",
          kind: "config",
        },
        {
          id: "webhookPort",
          kind: "config",
        },
        {
          id: "requireMention",
          kind: "config",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
