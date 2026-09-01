// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { slackCredentialBindingEvidence } from "../live/messaging-providers-helpers.ts";

const SLACK_POLICY_SANDBOX = "e2e-msg-policy";

type SyntheticSlackEndpoint = {
  host: string;
  port: number;
  protocol: string;
  enforcement: string;
  request_body_credential_rewrite: boolean;
  path?: string;
  credential_binding?: { provider: string };
  rules: Array<{ allow: { method: string; path: string } }>;
};

const SYNTHETIC_SLACK_ENDPOINTS: readonly SyntheticSlackEndpoint[] = [
  {
    host: "slack.com",
    port: 443,
    protocol: "rest",
    enforcement: "enforce",
    request_body_credential_rewrite: true,
    path: "/api/apps.connections.open",
    credential_binding: { provider: `${SLACK_POLICY_SANDBOX}-slack-app` },
    rules: [{ allow: { method: "POST", path: "/api/apps.connections.open" } }],
  },
  ...["slack.com", "api.slack.com", "hooks.slack.com"].map((host) => ({
    host,
    port: 443,
    protocol: "rest",
    enforcement: "enforce",
    request_body_credential_rewrite: true,
    credential_binding: { provider: `${SLACK_POLICY_SANDBOX}-slack-bridge` },
    rules: [{ allow: { method: "GET", path: "/**" } }, { allow: { method: "POST", path: "/**" } }],
  })),
];

function syntheticSlackPolicy(mutate?: (endpoints: SyntheticSlackEndpoint[]) => void): string {
  const endpoints = structuredClone(SYNTHETIC_SLACK_ENDPOINTS) as SyntheticSlackEndpoint[];
  mutate?.(endpoints);
  return YAML.stringify({
    version: 1,
    network_policies: { slack: { name: "slack", endpoints } },
  });
}

function mutateSlackEndpoint(
  host: string,
  provider: string,
  mutate: (endpoint: SyntheticSlackEndpoint) => void,
): string {
  return syntheticSlackPolicy((endpoints) => {
    const endpoint = endpoints.find(
      (candidate) => candidate.host === host && candidate.credential_binding?.provider === provider,
    );
    expect(endpoint).toBeDefined();
    mutate(endpoint!);
  });
}

const CREDENTIAL_BOUND_SLACK_POLICY = syntheticSlackPolicy();

describe("messaging provider Slack policy evidence", () => {
  it("accepts Slack bot and app credential bindings and rejects policies without them", () => {
    const legacyPolicy = `
network_policies:
  slack:
    name: slack
    endpoints:
      - host: slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: POST, path: "/**" }
`;

    expect(
      slackCredentialBindingEvidence(CREDENTIAL_BOUND_SLACK_POLICY, SLACK_POLICY_SANDBOX),
    ).toEqual({ app: true, bot: true });
    expect(slackCredentialBindingEvidence(legacyPolicy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });

  it.each([
    ["port", (endpoint: SyntheticSlackEndpoint) => (endpoint.port = 80)],
    ["protocol", (endpoint: SyntheticSlackEndpoint) => (endpoint.protocol = "websocket")],
    ["enforcement", (endpoint: SyntheticSlackEndpoint) => (endpoint.enforcement = "audit")],
    [
      "app rule",
      (endpoint: SyntheticSlackEndpoint) =>
        (endpoint.rules = [{ allow: { method: "GET", path: "/api/apps.connections.open" } }]),
    ],
  ])("rejects an app credential endpoint with the wrong %s", (_field, mutate) => {
    const policy = mutateSlackEndpoint("slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, mutate);
    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: true,
    });
  });

  it("rejects a bot credential endpoint without both broad Slack API rules", () => {
    const policy = mutateSlackEndpoint(
      "slack.com",
      `${SLACK_POLICY_SANDBOX}-slack-bridge`,
      (endpoint) => {
        endpoint.rules = endpoint.rules.filter((rule) => rule.allow.method !== "GET");
      },
    );
    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: true,
      bot: false,
    });
  });

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint when its credential provider is wrong",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        endpoint.credential_binding = { provider: "wrong-provider" };
      });
      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint when its credential provider is absent",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        delete endpoint.credential_binding;
      });
      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each([
    ["app", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-app`, false, true],
    ["broad bot", "slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["API bot", "api.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
    ["webhook bot", "hooks.slack.com", `${SLACK_POLICY_SANDBOX}-slack-bridge`, true, false],
  ] as const)(
    "rejects the %s endpoint with an extra credential-bearing permission",
    (_label, host, provider, expectedApp, expectedBot) => {
      const policy = mutateSlackEndpoint(host, provider, (endpoint) => {
        endpoint.rules.push({ allow: { method: "DELETE", path: "/**" } });
      });
      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: expectedApp,
        bot: expectedBot,
      });
    },
  );

  it.each(["api.slack.com", "hooks.slack.com"])(
    "rejects the %s bot route without credential rewrite",
    (host) => {
      const policy = mutateSlackEndpoint(
        host,
        `${SLACK_POLICY_SANDBOX}-slack-bridge`,
        (endpoint) => {
          endpoint.request_body_credential_rewrite = false;
        },
      );
      expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
        app: true,
        bot: false,
      });
    },
  );

  it("rejects an extra unbound broad Slack REST endpoint", () => {
    const policy = syntheticSlackPolicy((endpoints) => {
      endpoints.push({
        host: "slack.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: false,
        rules: [
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "POST", path: "/**" } },
        ],
      });
    });
    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });

  it("treats a malformed Slack endpoint as missing credential evidence", () => {
    const policy = `
network_policies:
  slack:
    endpoints:
      - null
`;
    expect(slackCredentialBindingEvidence(policy, SLACK_POLICY_SANDBOX)).toEqual({
      app: false,
      bot: false,
    });
  });
});
