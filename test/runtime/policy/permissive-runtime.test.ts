// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  buildRuntimePermissivePolicy,
  type ExactManagedMcpPolicy,
} from "../../../src/lib/shields/permissive-runtime.js";
import {
  listMessagingPolicyPresetMetadata,
  listMessagingProviderNamesForChannel,
} from "../../../src/lib/messaging/channels/metadata.js";
import type { MessagingAgentId } from "../../../src/lib/messaging/manifest";
import { loadMessagingChannelPolicyPreset } from "../../../src/lib/messaging/channels/policy.js";

const BASE_PERMISSIVE = YAML.stringify({
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/proc", "/etc"],
    read_write: ["/tmp", "/sandbox/.openclaw"],
  },
  landlock: { compatibility: "best_effort" },
});

const EMPTY_NETWORK_PERMISSIVE = YAML.stringify({ network_policies: {} });

const MANAGED_POLICY: ExactManagedMcpPolicy = {
  key: "mcp_bridge_alpha",
  networkPolicy: {
    endpoints: [{ host: "alpha.example.com", port: 443, protocol: "mcp" }],
    binaries: [{ path: "/opt/hermes/.venv/bin/python*" }],
  },
  policyName: "mcp-bridge-alpha",
  server: "alpha",
};

const HERMES_MESSAGING_PERMISSIVE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../agents/hermes/policy-permissive.yaml"),
  "utf8",
);

const OPENCLAW_MESSAGING_PERMISSIVE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../agents/openclaw/policy-permissive.yaml"),
  "utf8",
);

const MESSAGING_PERMISSIVE_BY_AGENT: Record<MessagingAgentId, string> = {
  hermes: HERMES_MESSAGING_PERMISSIVE,
  openclaw: OPENCLAW_MESSAGING_PERMISSIVE,
};

const SHIELDS_CREDENTIAL_FREE_ROUTE_CASES = [
  ["whatsapp", "enabled", true],
  ["whatsapp", "disabled", false],
] as const;

const MISSING_PLAN_SHIELDS_CASES = [
  [
    "a live credential-free WhatsApp route",
    YAML.stringify({
      network_policies: {
        whatsapp: { endpoints: [{ host: "web.whatsapp.com", port: 443 }] },
      },
    }),
    "channel 'whatsapp'",
  ],
  ["an unreadable live policy", "", "the live policy could not be read"],
] as const;

const SLACK_PROVIDER_CASES = (["openclaw", "hermes"] as const).flatMap((agent) => {
  const sandboxName = `${agent}-box`;
  const expectedProviders = listMessagingProviderNamesForChannel(sandboxName, "slack", { agent });
  const slackPolicy = listMessagingPolicyPresetMetadata({ agent }).find(
    (policy) => policy.channelId === "slack",
  )!;
  const livePolicyKey = (slackPolicy.agentPolicyKeys[agent] ?? slackPolicy.policyKeys)[0]!;
  return [
    ...(agent === "openclaw"
      ? ([[agent, "exact", sandboxName, livePolicyKey, expectedProviders, true]] as const)
      : []),
    [agent, "absent", sandboxName, livePolicyKey, [], false],
    [agent, "partial", sandboxName, livePolicyKey, expectedProviders.slice(0, 1), false],
    [
      agent,
      "mismatched",
      sandboxName,
      livePolicyKey,
      [...expectedProviders, `${sandboxName}-unexpected-provider`],
      false,
    ],
  ] as const;
});

type SlackEndpoint = {
  access?: string;
  credential_binding?: { provider?: string };
  host?: string;
  path?: string;
  rules?: Array<{ allow?: { method?: string; path?: string } }>;
};

function enabledMessagingSelection(...channelIds: string[]) {
  return {
    channels: channelIds.map((channelId) => ({ channelId, active: true, disabled: false })),
    disabledChannels: [],
  };
}

function expectExactHermesSlackCredentialRoutes(endpoints: SlackEndpoint[]): void {
  expect(
    endpoints.map((endpoint) => ({
      access: endpoint.access,
      host: endpoint.host,
      path: endpoint.path,
      provider: endpoint.credential_binding?.provider,
      routes:
        endpoint.rules?.map(
          (rule) => `${String(rule.allow?.method)} ${String(rule.allow?.path)}`,
        ) ?? [],
    })),
  ).toEqual([
    {
      access: undefined,
      host: "slack.com",
      path: "/api/apps.connections.open",
      provider: "hermes-box-slack-app",
      routes: ["POST /api/apps.connections.open"],
    },
    {
      access: undefined,
      host: "slack.com",
      path: undefined,
      provider: "hermes-box-slack-bridge",
      routes: ["GET /**", "POST /**"],
    },
    {
      access: undefined,
      host: "api.slack.com",
      path: undefined,
      provider: "hermes-box-slack-bridge",
      routes: ["GET /**", "POST /**"],
    },
    {
      access: undefined,
      host: "hooks.slack.com",
      path: undefined,
      provider: "hermes-box-slack-bridge",
      routes: ["GET /**", "POST /**"],
    },
    {
      access: undefined,
      host: "wss-primary.slack.com",
      path: undefined,
      provider: "hermes-box-slack-app",
      routes: ["GET /**", "WEBSOCKET_TEXT /**"],
    },
    {
      access: undefined,
      host: "wss-backup.slack.com",
      path: undefined,
      provider: "hermes-box-slack-app",
      routes: ["GET /**", "WEBSOCKET_TEXT /**"],
    },
  ]);
}

const tempFilesToClean: string[] = [];

function trackTempForCleanup(out: string, basePath: string): void {
  // Defensive: if the helper degrades to the static base path we must
  // never try to `rm -rf` its parent dir — that would target the
  // user's checkout. Only enqueue paths that the helper actually
  // produced via mkdtemp.
  if (out === basePath) return;
  const tempRoot = path.resolve(os.tmpdir());
  const parent = path.resolve(path.dirname(out));
  const rel = path.relative(tempRoot, parent);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
  tempFilesToClean.push(out);
}

afterEach(() => {
  while (tempFilesToClean.length > 0) {
    const p = tempFilesToClean.pop();
    if (!p) continue;
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("buildRuntimePermissivePolicy (#3942)", () => {
  it("keeps exact OpenClaw Telegram and Slack providers together in Shields down (#10153)", () => {
    let stagedPolicy = "";
    buildRuntimePermissivePolicy("/unused-openclaw-permissive.yaml", {
      livePolicyYaml: YAML.stringify({
        network_policies: {
          telegram_bot: {
            endpoints: [
              {
                credential_binding: { provider: "openclaw-box-telegram-bridge" },
              },
            ],
          },
          slack: {
            endpoints: [
              {
                credential_binding: { provider: "openclaw-box-slack-app" },
              },
              {
                credential_binding: { provider: "openclaw-box-slack-bridge" },
              },
            ],
          },
        },
      }),
      messagingAgent: "openclaw",
      messagingPlan: enabledMessagingSelection("telegram", "slack"),
      readBasePolicy: () => OPENCLAW_MESSAGING_PERMISSIVE,
      sandboxName: "openclaw-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-openclaw-permissive.yaml";
      },
    });

    const policies = YAML.parse(stagedPolicy).network_policies;
    const telegramPolicy = YAML.parse(
      loadMessagingChannelPolicyPreset("telegram", {
        agent: "openclaw",
        sandboxName: "openclaw-box",
      })!,
    );
    const slackPolicy = YAML.parse(
      loadMessagingChannelPolicyPreset("slack", {
        agent: "openclaw",
        sandboxName: "openclaw-box",
      })!,
    );
    expect(policies.telegram_bot).toEqual(telegramPolicy.network_policies.telegram_bot);
    expect(policies.slack).toEqual(slackPolicy.network_policies.slack);
    expect(
      new Set(
        policies.telegram_bot.endpoints.map(
          (endpoint: SlackEndpoint) => endpoint.credential_binding?.provider,
        ),
      ),
    ).toEqual(new Set(["openclaw-box-telegram-bridge"]));
    expect(
      new Set(
        policies.slack.endpoints.map(
          (endpoint: SlackEndpoint) => endpoint.credential_binding?.provider,
        ),
      ),
    ).toEqual(new Set(["openclaw-box-slack-app", "openclaw-box-slack-bridge"]));
    expect(
      policies.slack.endpoints.find(
        (endpoint: SlackEndpoint) =>
          endpoint.host === "slack.com" &&
          endpoint.credential_binding?.provider === "openclaw-box-slack-app",
      ),
    ).toMatchObject({
      rules: [{ allow: { method: "POST", path: "/api/apps.connections.open" } }],
    });
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it("omits OpenClaw Telegram egress when the live provider binding is absent (#10153)", () => {
    let stagedPolicy = "";
    buildRuntimePermissivePolicy("/unused-openclaw-permissive.yaml", {
      livePolicyYaml: YAML.stringify({ network_policies: {} }),
      messagingAgent: "openclaw",
      messagingPlan: enabledMessagingSelection("telegram"),
      readBasePolicy: () => OPENCLAW_MESSAGING_PERMISSIVE,
      sandboxName: "openclaw-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-openclaw-permissive.yaml";
      },
    });

    expect(YAML.parse(stagedPolicy).network_policies.telegram_bot).toBeUndefined();
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it.each(SHIELDS_CREDENTIAL_FREE_ROUTE_CASES)(
    "keeps the OpenClaw %s route %s in Shields down (#10153)",
    (channelId, _state, enabled) => {
      let stagedPolicy = "";
      buildRuntimePermissivePolicy("/unused-openclaw-permissive.yaml", {
        livePolicyYaml: YAML.stringify({ network_policies: {} }),
        messagingAgent: "openclaw",
        messagingPlan: enabled
          ? enabledMessagingSelection(channelId)
          : {
              channels: [{ channelId, active: false, disabled: true }],
              disabledChannels: [channelId],
            },
        readBasePolicy: () => OPENCLAW_MESSAGING_PERMISSIVE,
        sandboxName: "openclaw-box",
        writeTempPolicy: (yaml) => {
          stagedPolicy = yaml;
          return "/staged-openclaw-permissive.yaml";
        },
      });
      const policies = YAML.parse(stagedPolicy).network_policies;
      expect(policies[channelId] !== undefined).toBe(enabled);
    },
  );

  it.each(MISSING_PLAN_SHIELDS_CASES)(
    "rejects Shields down without staging when the plan is unavailable with %s (#10153)",
    (_case, livePolicyYaml, expectedFailure) => {
      const writeTempPolicy = vi.fn(() => "/must-not-stage.yaml");
      let failure = "";
      try {
        buildRuntimePermissivePolicy("/unused-openclaw-permissive.yaml", {
          livePolicyYaml,
          messagingAgent: "openclaw",
          messagingPlan: null,
          readBasePolicy: () => OPENCLAW_MESSAGING_PERMISSIVE,
          sandboxName: "missing-plan",
          writeTempPolicy,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      expect(failure).toContain(expectedFailure);
      expect(writeTempPolicy).not.toHaveBeenCalled();
    },
  );

  it("keeps the Hermes Discord provider binding in Shields down", () => {
    let stagedPolicy = "";
    const out = buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
      livePolicyYaml: YAML.stringify({
        network_policies: {
          discord: {
            endpoints: [
              {
                host: "discord.com",
                credential_binding: { provider: "hermes-box-discord-bridge" },
              },
            ],
          },
        },
      }),
      messagingAgent: "hermes",
      messagingPlan: enabledMessagingSelection("discord"),
      readBasePolicy: () => EMPTY_NETWORK_PERMISSIVE,
      sandboxName: "hermes-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-hermes-permissive.yaml";
      },
    });

    expect(out).toBe("/staged-hermes-permissive.yaml");
    const policy = YAML.parse(stagedPolicy);
    const endpoints = policy.network_policies.discord.endpoints as Array<{
      host: string;
      credential_binding?: { provider?: string };
    }>;
    const credentialEndpoints = endpoints.filter((endpoint) =>
      ["discord.com", "gateway.discord.gg", "*.discord.gg"].includes(endpoint.host),
    );
    expect(credentialEndpoints.map((endpoint) => endpoint.host).sort()).toEqual([
      "*.discord.gg",
      "discord.com",
      "gateway.discord.gg",
    ]);
    expect(credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      "hermes-box-discord-bridge",
      "hermes-box-discord-bridge",
      "hermes-box-discord-bridge",
    ]);
    expect(
      endpoints.find((endpoint) => endpoint.host === "cdn.discordapp.com")?.credential_binding,
    ).toBeUndefined();
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it("omits Hermes Discord egress when no live provider binding exists", () => {
    let stagedPolicy = "";
    const out = buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
      livePolicyYaml: "",
      messagingAgent: "hermes",
      messagingPlan: enabledMessagingSelection("discord"),
      readBasePolicy: () => HERMES_MESSAGING_PERMISSIVE,
      sandboxName: "hermes-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-hermes-permissive.yaml";
      },
    });

    expect(out).toBe("/staged-hermes-permissive.yaml");
    expect(YAML.parse(stagedPolicy).network_policies.discord).toBeUndefined();
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it("keeps the exact Hermes Slack provider pair in Shields down", () => {
    let stagedPolicy = "";
    buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
      livePolicyYaml: YAML.stringify({
        network_policies: {
          slack: {
            endpoints: [
              {
                host: "slack.com",
                credential_binding: { provider: "hermes-box-slack-app" },
              },
              {
                host: "api.slack.com",
                credential_binding: { provider: "hermes-box-slack-bridge" },
              },
            ],
          },
        },
      }),
      messagingAgent: "hermes",
      messagingPlan: enabledMessagingSelection("slack"),
      readBasePolicy: () => HERMES_MESSAGING_PERMISSIVE,
      sandboxName: "hermes-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-hermes-permissive.yaml";
      },
    });

    const policy = YAML.parse(stagedPolicy);
    expectExactHermesSlackCredentialRoutes(policy.network_policies.slack.endpoints);
    expect(policy.network_policies.discord).toBeUndefined();
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it("keeps exact Hermes Slack and Discord providers together in Shields down", () => {
    let stagedPolicy = "";
    buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
      livePolicyYaml: YAML.stringify({
        network_policies: {
          discord: {
            endpoints: [
              {
                credential_binding: { provider: "hermes-box-discord-bridge" },
              },
            ],
          },
          slack: {
            endpoints: [
              {
                credential_binding: { provider: "hermes-box-slack-app" },
              },
              {
                credential_binding: { provider: "hermes-box-slack-bridge" },
              },
            ],
          },
        },
      }),
      messagingAgent: "hermes",
      messagingPlan: enabledMessagingSelection("discord", "slack"),
      readBasePolicy: () => HERMES_MESSAGING_PERMISSIVE,
      sandboxName: "hermes-box",
      writeTempPolicy: (yaml) => {
        stagedPolicy = yaml;
        return "/staged-hermes-permissive.yaml";
      },
    });

    const policies = YAML.parse(stagedPolicy).network_policies;
    expect(policies.discord).toBeDefined();
    expect(policies.slack).toBeDefined();
    expectExactHermesSlackCredentialRoutes(policies.slack.endpoints);
    expect(stagedPolicy).not.toContain("{sandboxName}");
  });

  it.each(SLACK_PROVIDER_CASES)(
    "%s keeps Slack egress only when the live provider set is exact; observed %s (#10153)",
    (agent, _providerState, sandboxName, livePolicyKey, providers, shouldKeep) => {
      let stagedPolicy = "";
      buildRuntimePermissivePolicy(`/unused-${agent}-permissive.yaml`, {
        livePolicyYaml: YAML.stringify({
          network_policies: {
            [livePolicyKey]: {
              endpoints: providers.map((provider) => ({ credential_binding: { provider } })),
            },
          },
        }),
        messagingAgent: agent,
        messagingPlan: enabledMessagingSelection("slack"),
        readBasePolicy: () => MESSAGING_PERMISSIVE_BY_AGENT[agent],
        sandboxName,
        writeTempPolicy: (yaml) => {
          stagedPolicy = yaml;
          return `/staged-${agent}-permissive.yaml`;
        },
      });

      const slackPolicy = YAML.parse(stagedPolicy).network_policies.slack;
      expect(slackPolicy !== undefined).toBe(shouldKeep);
      expect(stagedPolicy).not.toContain("{sandboxName}");
    },
  );

  it("rejects an unsafe Hermes sandbox name before staging Slack Shields down", () => {
    const writeTempPolicy = vi.fn(() => "/must-not-stage.yaml");
    let message = "";

    try {
      buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
        livePolicyYaml: YAML.stringify({
          network_policies: {
            slack: {
              endpoints: [
                { credential_binding: { provider: "bad:provider-slack-app" } },
                { credential_binding: { provider: "bad:provider-slack-bridge" } },
              ],
            },
          },
        }),
        messagingAgent: "hermes",
        messagingPlan: enabledMessagingSelection("slack"),
        readBasePolicy: () => EMPTY_NETWORK_PERMISSIVE,
        sandboxName: "bad:provider",
        writeTempPolicy,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Cannot materialize the Shields-down credential provider binding");
    expect(writeTempPolicy).not.toHaveBeenCalled();
  });

  it("rejects an unsafe Hermes sandbox name before staging Shields down", () => {
    const writeTempPolicy = vi.fn(() => "/must-not-stage.yaml");

    expect(() =>
      buildRuntimePermissivePolicy("/unused-hermes-permissive.yaml", {
        livePolicyYaml: YAML.stringify({
          network_policies: {
            discord: {
              endpoints: [
                {
                  credential_binding: { provider: "bad:provider-discord-bridge" },
                },
              ],
            },
          },
        }),
        messagingAgent: "hermes",
        messagingPlan: enabledMessagingSelection("discord"),
        readBasePolicy: () => EMPTY_NETWORK_PERMISSIVE,
        sandboxName: "bad:provider",
        writeTempPolicy,
      }),
    ).toThrow("Cannot materialize the Shields-down credential provider binding");
    expect(writeTempPolicy).not.toHaveBeenCalled();
  });

  it("preserves exact managed MCP entries without copying unrelated live egress (#7952)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
      network_policies: {
        mcp_bridge_alpha: MANAGED_POLICY.networkPolicy,
        unrelated_live_entry: {
          endpoints: [{ host: "unrelated.example.com", port: 443 }],
        },
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      managedMcpPolicies: [MANAGED_POLICY],
      readBasePolicy: () =>
        YAML.stringify({
          ...YAML.parse(BASE_PERMISSIVE),
          network_policies: {
            permissive_baseline: {
              endpoints: [{ host: "*", port: 443 }],
            },
          },
        }),
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.network_policies).toMatchObject({
      mcp_bridge_alpha: MANAGED_POLICY.networkPolicy,
      permissive_baseline: {
        endpoints: [{ host: "*", port: 443 }],
      },
    });
    expect(result.network_policies).not.toHaveProperty("unrelated_live_entry");
  });

  it("preserves /proc when the live GPU sandbox has it in read_write", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        read_only: ["/etc", "/usr"],
        // GPU enrichment from src/lib/onboard/initial-policy.ts:57.
        read_write: ["/tmp", "/proc", "/home/linuxbrew"],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.read_write).toEqual(
      expect.arrayContaining(["/tmp", "/sandbox/.openclaw", "/proc", "/home/linuxbrew"]),
    );
    // /proc must NOT also appear in read_only; rw wins.
    expect(result.filesystem_policy.read_only).not.toContain("/proc");
  });

  it("preserves non-list filesystem_policy fields (e.g. include_workdir)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"], read_only: ["/usr"] },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.include_workdir).toBe(true);
  });

  it("merges live read_only paths into base read_only without clobbering rw", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        // /tmp is in base read_write — live ro should NOT downgrade it.
        read_only: ["/usr", "/tmp"],
        read_write: [],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.filesystem_policy.read_write).toContain("/tmp");
    expect(result.filesystem_policy.read_only).toContain("/usr");
    expect(result.filesystem_policy.read_only).not.toContain("/tmp");
  });

  it("deduplicates entries within each list and across lists", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: {
        read_only: ["/etc", "/etc"],
        read_write: ["/tmp", "/tmp", "/proc"],
      },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");
    expect(out).not.toBe("/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    const rwCount = result.filesystem_policy.read_write.filter((p: string) => p === "/tmp").length;
    const roCount = result.filesystem_policy.read_only.filter((p: string) => p === "/etc").length;
    expect(rwCount).toBe(1);
    expect(roCount).toBe(1);
    const rwSet = new Set(result.filesystem_policy.read_write);
    const readOnlyPaths = result.filesystem_policy.read_only as string[];
    expect(readOnlyPaths.every((pathname) => !rwSet.has(pathname))).toBe(true);
  });

  it("returns the static base path when live policy is empty", () => {
    const basePath = "/path/to/static.yaml";
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: "",
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    expect(out).toBe(basePath);
  });

  it("carries the live landlock stanza so a startup-sealed field is not changed (#8461)", () => {
    // Deep Agents Code starts with `strict` but ships no permissive policy of
    // its own, so the base is the OpenClaw document with `best_effort`.
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
      landlock: { compatibility: "strict" },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "strict" });
  });

  it("carries a live landlock stanza that already equals the base (#8461)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
      landlock: { compatibility: "best_effort" },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "best_effort" });
  });

  it("keeps the base landlock stanza when the live policy carries none (#8461)", () => {
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_only: ["/etc"], read_write: ["/tmp"] },
    });

    const out = buildRuntimePermissivePolicy("/unused-base.yaml", {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, "/unused-base.yaml");

    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "best_effort" });
  });

  it("carries Landlock when the live policy has no filesystem paths (#8461)", () => {
    const basePath = "/unused-base.yaml";
    const liveYaml = YAML.stringify({ landlock: { compatibility: "strict" } });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
    });
    trackTempForCleanup(out, basePath);

    expect(out).not.toBe(basePath);
    const result = YAML.parse(fs.readFileSync(out, "utf-8"));
    expect(result.landlock).toEqual({ compatibility: "strict" });
  });

  it("returns the static base path when readBasePolicy throws (I/O failure)", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBe(basePath);
  });

  it("fails closed when the base cannot be read with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/Cannot read the Shields-down policy/);
  });

  it("fails closed when the base is not a mapping with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => "[]",
      }),
    ).toThrow(/Cannot parse the Shields-down policy/);
  });

  it("fails closed when staging fails with managed MCP policies active (#7952)", () => {
    expect(() =>
      buildRuntimePermissivePolicy("/path/to/static.yaml", {
        livePolicyYaml: "version: 1\nnetwork_policies: {}\n",
        managedMcpPolicies: [MANAGED_POLICY],
        readBasePolicy: () => BASE_PERMISSIVE,
        writeTempPolicy: () => {
          throw new Error("ENOSPC: simulated /tmp full");
        },
      }),
    ).toThrow(/Cannot stage the Shields-down policy/);
  });

  it("returns the static base path when base YAML is unparseable", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => "::: not yaml :::",
    });
    expect(out).toBe(basePath);
  });

  it("returns the static base path when temp-file write throws", () => {
    const basePath = "/path/to/static.yaml";
    const liveYaml = YAML.stringify({
      filesystem_policy: { read_write: ["/proc"] },
    });
    let writeAttempts = 0;
    const out = buildRuntimePermissivePolicy(basePath, {
      livePolicyYaml: liveYaml,
      readBasePolicy: () => BASE_PERMISSIVE,
      writeTempPolicy: () => {
        writeAttempts += 1;
        throw new Error("ENOSPC: simulated /tmp full");
      },
    });
    expect(out).toBe(basePath);
    expect(writeAttempts).toBe(1);
  });
});
