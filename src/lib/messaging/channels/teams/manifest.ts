// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";
import { TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT } from "./contract.ts";

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
  // requiredAtCreate - the preset carries this channel's credential_binding:
  // - The provider profile is endpointless, so the binding is the only thing that
  //   makes MSTEAMS_APP_PASSWORD injectable.
  // - The sandbox reads the provider environment once, at boot, so a preset
  //   applied afterwards never reaches the running agent.
  policyPresets: [{ name: "teams", policyKeys: ["teams"], requiredAtCreate: true }],
  hostForward: {
    port: "{{teamsConfig.webhookPort}}",
    label: "Microsoft Teams webhook",
  },
  render: [
    {
      id: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.renderId,
      kind: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.kind,
      agent: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.agent,
      target: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.target,
      fragment: {
        path: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.configPath,
        value: {
          enabled: true,
          appId: "{{teamsConfig.appId}}",
          // No appPassword here: OpenShell 0.0.106 injects
          // MSTEAMS_APP_PASSWORD as a revision-scoped placeholder and rejects
          // the canonical form once the policy binds the credential. The
          // OpenClaw Teams token resolver falls back to
          // process.env.MSTEAMS_APP_PASSWORD. Hermes receives the same runtime
          // placeholder under TEAMS_CLIENT_SECRET through its runtime alias.
          tenantId: "{{teamsConfig.tenantId}}",
          webhook: {
            port: "{{teamsConfig.webhookPort}}",
            path: TEAMS_OPENCLAW_WEBHOOK_RENDER_CONTRACT.webhookPath,
          },
          healthMonitor: {
            enabled: false,
          },
          // OpenClaw Teams streaming can duplicate or collapse preview and final messages.
          // Keep final-only mode until that path is fixed and covered by runtime validation.
          streaming: {
            mode: "off",
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
      nodePreloads: [
        {
          module: "msteams-message-hints",
          injectInto: ["boot", "connect"],
          // Require the packaged asset at setup time. The preload itself fails
          // open at runtime so an upstream shape change preserves Teams with a
          // bounded warning instead of preventing the gateway from starting.
          optional: false,
          installMessage:
            "[channels] Installing Microsoft Teams message hint patch (native mentions)",
          installedMessage:
            "[channels] Microsoft Teams message hint patch installed (NODE_OPTIONS updated)",
        },
      ],
    },
    hermes: {
      envAliases: [
        {
          envKey: "MSTEAMS_APP_PASSWORD",
          targetEnvKey: "TEAMS_CLIENT_SECRET",
          match: "^openshell:resolve:env:v[0-9]+_MSTEAMS_APP_PASSWORD$",
          value: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/msteams@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/msteams/-/msteams-2026.7.1.tgz",
      },
      required: true,
    },
    {
      id: "hermesTeamsAppsPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "microsoft-teams-apps==2.0.13.4",
      required: true,
    },
  ],
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
