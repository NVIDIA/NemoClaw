// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

type Endpoint = {
  host?: string;
  protocol?: string;
  enforcement?: string;
  access?: string;
  tls?: string;
  request_body_credential_rewrite?: boolean;
  websocket_credential_rewrite?: boolean;
  rules?: Array<{ allow?: { method?: string; path?: string } }>;
};

function channelPolicy(channel: string, agent: "openclaw" | "hermes"): Record<string, any> {
  const file = path.join(
    REPO_ROOT,
    "src/lib/messaging/channels",
    channel,
    "policy",
    `${agent}.yaml`,
  );
  return YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

function allEndpoints(policy: Record<string, any>): Endpoint[] {
  return Object.values(
    (policy.network_policies ?? {}) as Record<string, { endpoints?: Endpoint[] }>,
  ).flatMap((entry) => entry.endpoints ?? []);
}

function requireNonEmpty<T>(items: T[], label: string): T[] {
  expect(items[0], label).toBeDefined();
  return items;
}

function expectInspectedWebSocket(endpoint: Endpoint | undefined): void {
  expect(endpoint).toBeTruthy();
  expect(endpoint).toMatchObject({
    protocol: "websocket",
    enforcement: "enforce",
    websocket_credential_rewrite: true,
  });
  expect(endpoint).not.toHaveProperty("access");
  expect(endpoint).not.toHaveProperty("tls");
  expect(endpoint?.rules).toEqual(
    expect.arrayContaining([
      { allow: { method: "GET", path: "/**" } },
      { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
    ]),
  );
}

describe("channel-owned messaging policy YAML", () => {
  it("Slack REST endpoints opt into OpenShell request-body credential rewrite", () => {
    const sources = [
      channelPolicy("slack", "openclaw"),
      channelPolicy("slack", "hermes"),
      YAML.parse(
        fs.readFileSync(path.join(REPO_ROOT, "agents/hermes/policy-permissive.yaml"), "utf8"),
      ),
      YAML.parse(
        fs.readFileSync(
          path.join(REPO_ROOT, "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml"),
          "utf8",
        ),
      ),
    ];
    const slackRestHosts = new Set(["slack.com", "api.slack.com", "hooks.slack.com"]);
    const slackRestEndpoints = requireNonEmpty(
      sources.flatMap(allEndpoints).filter((entry) => slackRestHosts.has(entry.host ?? "")),
      "expected Slack REST endpoints in channel and permissive policies",
    );

    for (const endpoint of slackRestEndpoints) {
      expect(endpoint).toMatchObject({
        protocol: "rest",
        request_body_credential_rewrite: true,
      });
    }
  });

  it("Hermes messaging gateway policies use native inspected WebSocket policy", () => {
    const cases = [
      { policy: channelPolicy("discord", "hermes"), hosts: ["gateway.discord.gg", "*.discord.gg"] },
      {
        policy: channelPolicy("slack", "hermes"),
        hosts: ["wss-primary.slack.com", "wss-backup.slack.com"],
      },
    ];

    for (const { policy, hosts } of cases) {
      const endpoints = allEndpoints(policy);
      for (const host of hosts) {
        expectInspectedWebSocket(endpoints.find((endpoint) => endpoint.host === host));
      }
    }
  });

  it("Hermes Discord REST mutations are scoped to discord.com", () => {
    const networkPolicies = channelPolicy("discord", "hermes").network_policies as Record<
      string,
      { endpoints?: Endpoint[] }
    >;
    const rulesFor = (policy: string, host: string) =>
      (networkPolicies[policy]?.endpoints ?? [])
        .filter((endpoint) => endpoint.host === host)
        .flatMap((endpoint) => endpoint.rules ?? [])
        .map((rule) => rule.allow)
        .filter((rule): rule is { method: string; path: string } =>
          Boolean(rule?.method && rule?.path),
        );
    const sortRules = (rules: Array<{ method: string; path: string }>) =>
      [...rules].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));

    const discordEndpoints = requireNonEmpty(
      networkPolicies.discord?.endpoints ?? [],
      "expected Hermes Discord endpoints",
    );
    const nonDiscordMutationRules = discordEndpoints
      .filter((endpoint) => endpoint.host !== "discord.com")
      .flatMap((endpoint) => endpoint.rules ?? [])
      .map((rule) => rule.allow)
      .filter((rule): rule is { method: string; path: string } =>
        Boolean(rule?.method && rule?.path),
      )
      .filter((rule) => ["PUT", "PATCH", "DELETE"].includes(rule.method));
    expect(nonDiscordMutationRules).toEqual([]);

    const discordMutationRules = sortRules(
      rulesFor("discord", "discord.com").filter((rule) =>
        ["PUT", "PATCH", "DELETE"].includes(rule.method),
      ),
    );
    expect(discordMutationRules).toEqual(
      sortRules([
        { method: "PUT", path: "/api/v*/applications/*/commands" },
        { method: "PUT", path: "/api/v*/channels/*/messages/*/reactions/*/@me" },
        { method: "PATCH", path: "/api/v*/applications/*" },
        { method: "PATCH", path: "/api/v*/applications/*/commands/*" },
        { method: "PATCH", path: "/api/v*/channels/*/messages/*" },
        { method: "PATCH", path: "/api/v*/webhooks/*/*/messages/*" },
        { method: "DELETE", path: "/api/v*/applications/*/commands/*" },
        { method: "DELETE", path: "/api/v*/channels/*/messages/*" },
        { method: "DELETE", path: "/api/v*/channels/*/messages/*/reactions/*/*" },
        { method: "DELETE", path: "/api/v*/webhooks/*/*/messages/*" },
      ]),
    );
    expect(discordMutationRules.some((rule) => rule.path === "/**")).toBe(false);
  });
});
