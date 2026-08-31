// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import YAML from "yaml";

import { describe, expect, it } from "vitest";

import type { ChannelManifest, ChannelPolicyPresetReference } from "../manifest";
import { resolveMessagingChannelPolicyPresetPath } from "./policy";
import {
  getMessagingChannelForCredentialEnvKey,
  getMessagingConfigEnvAliases,
  getMessagingCredentialEnvKeysByChannel,
  getMessagingPolicyKeyAliases,
  getMessagingPolicyKeysByChannel,
  getMessagingPolicyPresetValidationWarnings,
  getMessagingProviderSuffixesByChannel,
  listAvailableMessagingChannelIds,
  listBuiltInMessagingChannelManifests,
  listMessagingChannelsWithoutCredentials,
  listMessagingConfigEnvKeys,
  listMessagingCredentialEnvAssignments,
  listMessagingPackageInstallSpecs,
  listMessagingPolicyPresetMetadata,
  listMessagingProviderNamesForChannel,
  listOpenClawManagedChannelNames,
  listOpenClawPluginExtensionIds,
  listOpenClawRuntimeChannelMetadata,
  listRequiredCreateTimeMessagingPolicyPresetNames,
} from "./metadata";

describe("built-in messaging channel metadata", () => {
  it("lists available channels by agent from manifests", () => {
    expect(listAvailableMessagingChannelIds({ agent: "openclaw" })).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
      "googlechat",
    ]);
    expect(listAvailableMessagingChannelIds({ agent: "hermes" })).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
      "googlechat",
    ]);
  });

  it("resolves credential env keys, env-key ownership, and provider names", () => {
    expect(getMessagingCredentialEnvKeysByChannel()).toMatchObject({
      telegram: ["TELEGRAM_BOT_TOKEN"],
      discord: ["DISCORD_BOT_TOKEN"],
      wechat: ["WECHAT_BOT_TOKEN"],
      slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
      whatsapp: [],
      teams: ["MSTEAMS_APP_PASSWORD"],
    });
    expect(getMessagingChannelForCredentialEnvKey("SLACK_APP_TOKEN")).toBe("slack");
    expect(getMessagingChannelForCredentialEnvKey("WHATSAPP_ALLOWED_IDS")).toBeNull();
    expect(getMessagingProviderSuffixesByChannel()).toMatchObject({
      telegram: ["-telegram-bridge"],
      discord: ["-discord-bridge"],
      wechat: ["-wechat-bridge"],
      slack: ["-slack-bridge", "-slack-app"],
      teams: ["-teams-bridge"],
    });
    expect(listMessagingProviderNamesForChannel("demo", "slack")).toEqual([
      "demo-slack-bridge",
      "demo-slack-app",
    ]);
    expect(listMessagingChannelsWithoutCredentials()).toEqual(["whatsapp", "googlechat"]);
  });

  it("derives credential environment assignments from manifest render metadata", () => {
    expect(
      listMessagingCredentialEnvAssignments({ agent: "hermes" })
        .filter(({ sourceEnvKey, targetEnvKey }) => sourceEnvKey !== targetEnvKey)
        .map(({ channelId, sourceEnvKey, targetEnvKey }) => ({
          channelId,
          sourceEnvKey,
          targetEnvKey,
        })),
    ).toEqual([
      {
        channelId: "wechat",
        sourceEnvKey: "WECHAT_BOT_TOKEN",
        targetEnvKey: "WEIXIN_TOKEN",
      },
      {
        channelId: "teams",
        sourceEnvKey: "MSTEAMS_APP_PASSWORD",
        targetEnvKey: "TEAMS_CLIENT_SECRET",
      },
    ]);
    expect(
      listMessagingCredentialEnvAssignments({ agent: "openclaw" }).filter(
        ({ channelId }) => channelId === "teams",
      ),
    ).toEqual([]);
  });

  it("ignores stale runtime aliases for unsupported agents (#10079)", () => {
    const wechatManifest = listBuiltInMessagingChannelManifests().find(
      (manifest) => manifest.id === "wechat",
    );
    expect(wechatManifest).toBeDefined();
    const staleManifest: ChannelManifest = {
      ...wechatManifest!,
      supportedAgents: ["openclaw"],
    };

    expect(
      listMessagingCredentialEnvAssignments({ manifests: [staleManifest] }).filter(
        ({ agent }) => agent === "hermes",
      ),
    ).toEqual([]);
  });

  it("resolves config env keys from manifests and compatibility aliases from metadata", () => {
    expect(listMessagingConfigEnvKeys()).toEqual([
      "TELEGRAM_ALLOWED_IDS",
      "TELEGRAM_REQUIRE_MENTION",
      "TELEGRAM_GROUP_POLICY",
      "DISCORD_SERVER_ID",
      "DISCORD_REQUIRE_MENTION",
      "DISCORD_USER_ID",
      "WECHAT_ACCOUNT_ID",
      "WECHAT_BASE_URL",
      "WECHAT_USER_ID",
      "WECHAT_ALLOWED_IDS",
      "SLACK_ALLOWED_USERS",
      "SLACK_ALLOWED_CHANNELS",
      "WHATSAPP_MODE",
      "WHATSAPP_ALLOWED_IDS",
      "MSTEAMS_APP_ID",
      "MSTEAMS_TENANT_ID",
      "TEAMS_ALLOWED_USERS",
      "MSTEAMS_PORT",
      "TEAMS_REQUIRE_MENTION",
      "GOOGLECHAT_AUDIENCE_TYPE",
      "GOOGLECHAT_AUDIENCE",
      "GOOGLECHAT_APP_PRINCIPAL",
      "GOOGLECHAT_ALLOWED_USERS",
      "GOOGLE_CHAT_PROJECT_ID",
      "GOOGLE_CHAT_SUBSCRIPTION_NAME",
    ]);
    expect(getMessagingConfigEnvAliases()).toEqual({
      DISCORD_SERVER_ID: ["DISCORD_SERVER_IDS"],
      DISCORD_USER_ID: ["DISCORD_ALLOWED_IDS"],
      MSTEAMS_APP_ID: ["TEAMS_CLIENT_ID"],
      MSTEAMS_TENANT_ID: ["TEAMS_TENANT_ID"],
      TEAMS_ALLOWED_USERS: ["MSTEAMS_ALLOWED_USERS"],
      MSTEAMS_PORT: ["TEAMS_PORT"],
    });
  });

  it("resolves policy aliases, OpenClaw runtime keys, and package specs", () => {
    expect(getMessagingPolicyKeyAliases()).toMatchObject({
      telegram: ["telegram_bot", "telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
      teams: ["teams"],
    });
    expect(getMessagingPolicyKeysByChannel({ agent: "hermes" })).toMatchObject({
      telegram: ["telegram"],
      discord: ["discord"],
      wechat: ["wechat_bridge"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
      teams: ["teams"],
    });
    // A preset that carries a credential_binding must be create-time required:
    // the sandbox reads the provider environment once, at boot, so a binding
    // added afterwards never reaches the running agent.
    expect(listRequiredCreateTimeMessagingPolicyPresetNames()).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "teams",
    ]);
    expect(getMessagingPolicyPresetValidationWarnings().discord).toContain(
      "https://discord.com/api/v10/gateway or validate the configured",
    );
    expect(listOpenClawManagedChannelNames()).toEqual([
      "telegram",
      "discord",
      "openclaw-weixin",
      "slack",
      "whatsapp",
      "msteams",
      "googlechat",
    ]);
    expect(listOpenClawPluginExtensionIds()).toEqual([
      "discord",
      "openclaw-weixin",
      "slack",
      "whatsapp",
      "msteams",
      "googlechat",
    ]);
    expect(
      Object.fromEntries(
        listOpenClawRuntimeChannelMetadata().map((entry) => [entry.channelId, entry.configKeys]),
      ),
    ).toMatchObject({
      telegram: ["telegram"],
      discord: ["discord"],
      wechat: ["openclaw-weixin"],
      slack: ["slack"],
      whatsapp: ["whatsapp"],
      teams: ["msteams"],
    });
    expect(
      Object.fromEntries(
        listMessagingPackageInstallSpecs({ agent: "openclaw" }).map((entry) => [
          entry.channelId,
          entry.spec,
        ]),
      ),
    ).toMatchObject({
      discord: "npm:@openclaw/discord@{{openclaw.version}}",
      wechat: "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      slack: "npm:@openclaw/slack@{{openclaw.version}}",
      whatsapp: "npm:@openclaw/whatsapp@{{openclaw.version}}",
      teams: "npm:@openclaw/msteams@{{openclaw.version}}",
    });
    expect(listMessagingPackageInstallSpecs({ agent: "hermes" })).toEqual([
      {
        channelId: "teams",
        packageId: "hermesTeamsAppsPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "microsoft-teams-apps==2.0.13.4",
      },
      {
        channelId: "googlechat",
        packageId: "hermesGooglePubsubPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "google-cloud-pubsub==2.39.0",
      },
      {
        channelId: "googlechat",
        packageId: "hermesGoogleApiClientPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "google-api-python-client==2.194.0",
      },
      {
        channelId: "googlechat",
        packageId: "hermesGoogleAuthPackage",
        agents: ["hermes"],
        manager: "hermes-uv-pip",
        spec: "google-auth==2.55.1",
      },
    ]);
  });

  it("requires committed npm integrity pins for built-in OpenClaw plugin installs", () => {
    const npmPluginInstalls = listBuiltInMessagingChannelManifests({ agent: "openclaw" }).flatMap(
      (manifest) =>
        (manifest.agentPackages ?? [])
          .filter(
            (agentPackage) =>
              agentPackage.agent === "openclaw" &&
              agentPackage.manager === "openclaw-plugin" &&
              agentPackage.spec.startsWith("npm:"),
          )
          .map((agentPackage) => ({
            packageKey: `${manifest.id}/${agentPackage.id}`,
            committedIntegrity:
              agentPackage.integrity ?? agentPackage.integrityByVersion?.["2026.7.1"],
          })),
    );

    expect(npmPluginInstalls).toEqual([
      {
        packageKey: "discord/openclawPluginPackage",
        committedIntegrity:
          "sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==",
      },
      {
        packageKey: "wechat/openclawPluginPackage",
        committedIntegrity:
          "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==",
      },
      {
        packageKey: "slack/openclawPluginPackage",
        committedIntegrity:
          "sha512-dwVGEVCmoTQrOIeZaSCIOPg8pT7hB883QQEXdp9EZUDzTGuvSc+KxH2iERSOV/59hROQctYdcobGn/vdB1H4XA==",
      },
      {
        packageKey: "whatsapp/openclawPluginPackage",
        committedIntegrity:
          "sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==",
      },
      {
        packageKey: "teams/openclawPluginPackage",
        committedIntegrity:
          "sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==",
      },
      {
        packageKey: "googlechat/openclawPluginPackage",
        committedIntegrity:
          "sha512-Dv0xOmcxAThEr6hoK+ioofHNu18hfbIceQrEHX3AHZPpOUiTJvToVpA5eX87NQINewwfSJf0gVhE6kSbSk2Aew==",
      },
    ]);
  });

  it("merges duplicate policy preset metadata by preset name", () => {
    const manifests: ChannelManifest[] = [
      manifestWithPreset("alpha", {
        name: "shared",
        policyKeys: ["alpha_key"],
        agentPolicyKeys: { hermes: ["alpha_hermes"] },
        validationWarningLines: ["alpha warning"],
      }),
      manifestWithPreset("beta", {
        name: "shared",
        policyKeys: ["beta_key"],
        validationWarningLines: ["beta warning"],
      }),
    ];

    expect(getMessagingPolicyKeyAliases({ manifests }).shared).toEqual([
      "alpha_key",
      "alpha_hermes",
      "beta_key",
    ]);
    expect(getMessagingPolicyPresetValidationWarnings({ manifests }).shared).toEqual([
      "alpha warning",
      "beta warning",
    ]);
  });

  it("derives OpenClaw managed channel names from explicit runtime metadata", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("matrix", "matrix"),
        render: [
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "channels.matrix", value: { enabled: true } },
          },
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "channels.matrix.rooms", value: ["#ops"] },
          },
          {
            kind: "json-fragment",
            agent: "hermes",
            target: "~/.hermes/config.yaml",
            fragment: { path: "channels.hermesOnly", value: { enabled: true } },
          },
          {
            kind: "json-fragment",
            agent: "openclaw",
            target: "openclaw.json",
            fragment: { path: "plugins.entries.matrix", value: { enabled: true } },
          },
        ],
        runtime: {
          openclaw: {
            channelName: "matrix-runtime",
            visibility: {
              configKeys: ["matrix-runtime"],
              logPatterns: ["matrix"],
            },
          },
        },
      },
    ];

    expect(listOpenClawManagedChannelNames({ manifests })).toEqual(["matrix-runtime"]);
  });

  it("lists package installs from manifest agent package metadata", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("alpha", "alpha"),
        agentPackages: [
          {
            id: "alphaPackage",
            agent: "openclaw",
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/alpha@{{openclaw.version}}",
          },
        ],
      },
    ];

    expect(listMessagingPackageInstallSpecs({ manifests })[0]?.agents).toEqual(["openclaw"]);
    expect(listMessagingPackageInstallSpecs({ manifests, agent: "hermes" })).toEqual([]);
  });

  it("lists channels that do not declare gateway credentials", () => {
    const manifests: ChannelManifest[] = [
      {
        ...manifestWithPreset("matrix", "matrix"),
        credentials: [
          {
            id: "matrixToken",
            sourceInput: "token",
            providerName: "{sandboxName}-matrix-bridge",
            providerEnvKey: "MATRIX_TOKEN",
            placeholder: "openshell:resolve:env:MATRIX_TOKEN",
          },
        ],
      },
      {
        ...manifestWithPreset("sessionOnly", "session-only"),
        credentials: [],
      },
    ];

    expect(listMessagingChannelsWithoutCredentials({ manifests })).toEqual(["sessionOnly"]);
  });
});

function manifestWithPreset(id: string, preset: ChannelPolicyPresetReference): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    supportedAgents: ["openclaw", "hermes"],
    auth: { mode: "none" },
    inputs: [],
    credentials: [],
    policyPresets: [preset],
    render: [],
    hooks: [],
  };
}

describe("messaging policy credential bindings", () => {
  const AGENTS = ["openclaw", "hermes"] as const;

  type PresetPolicyFile = {
    readonly label: string;
    readonly requiredAtCreate: boolean;
    readonly path: string;
  };

  function policyFiles(): PresetPolicyFile[] {
    return listMessagingPolicyPresetMetadata()
      .flatMap((preset) =>
        AGENTS.map((agent) => ({
          label: `${preset.channelId}/${agent}`,
          requiredAtCreate: preset.requiredAtCreate,
          path: resolveMessagingChannelPolicyPresetPath(preset.presetName, agent) ?? "",
        })),
      )
      .filter((entry: PresetPolicyFile) => entry.path.length > 0);
  }

  function presetsBindingACredentialWithoutCreateTimeApply(): string[] {
    return policyFiles()
      .filter((entry: PresetPolicyFile) => !entry.requiredAtCreate)
      .filter((entry: PresetPolicyFile) =>
        readFileSync(entry.path, "utf8").includes("credential_binding:"),
      )
      .map((entry: PresetPolicyFile) => entry.label);
  }

  type PolicyEndpoint = { readonly host?: string; readonly port?: number; readonly path?: string };

  function endpointsSharingAHostPortWithoutDistinctPaths(): string[] {
    return policyFiles()
      .flatMap((entry: PresetPolicyFile) => {
        const parsed = YAML.parse(readFileSync(entry.path, "utf8")) as {
          network_policies?: Record<string, { endpoints?: PolicyEndpoint[] }>;
        };
        return Object.entries(parsed.network_policies ?? {}).flatMap(([policyKey, policy]) => {
          const declared = (policy.endpoints ?? []).map((endpoint: PolicyEndpoint) => ({
            hostPort: `${endpoint.host}:${endpoint.port}`,
            selector: endpoint.path ?? "",
          }));
          const selectorsFor = (hostPort: string) =>
            declared.filter((endpoint) => endpoint.hostPort === hostPort).map((e) => e.selector);
          return [...new Set(declared.map((endpoint) => endpoint.hostPort))]
            .filter(
              (hostPort) => new Set(selectorsFor(hostPort)).size !== selectorsFor(hostPort).length,
            )
            .map((hostPort) => `${entry.label} ${policyKey} ${hostPort}`);
        });
      })
      .sort();
  }

  it("gives every repeated host and port a distinct path selector", () => {
    // A channel with two credentials on one host declares that host twice:
    // - OpenShell picks the endpoint by path specificity.
    // - Two entries scoring the same are rejected as ambiguous, which fails
    //   sandbox creation outright rather than degrading.
    expect(endpointsSharingAHostPortWithoutDistinctPaths()).toEqual([]);
  });

  it("keeps every preset that binds a credential create-time required", () => {
    // The binding is what makes the credential injectable:
    // - The sandbox reads the provider environment once, at boot; the agent
    //   inherits that read for the life of the container.
    // - A preset applied after boot leaves the agent with no credential at all.
    // - Slack was already create-time required. Discord and Teams were not,
    //   which is how their tokens went missing on OpenClaw.
    expect(presetsBindingACredentialWithoutCreateTimeApply()).toEqual([]);
  });
});
