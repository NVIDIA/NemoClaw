// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadManagedToolGatewayMatrix } from "../../agents/hermes/config/managed-tool-gateway.ts";
import { loadAgent } from "../../src/lib/agent/defs.ts";
import * as policies from "../../src/lib/policy";

type AllowRule = {
  allow?: {
    method?: string;
    path?: string;
  };
};

type Endpoint = {
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  access?: string;
  tls?: string;
  allowed_ips?: string[];
  request_body_credential_rewrite?: boolean;
  websocket_credential_rewrite?: boolean;
  credential_binding?: { provider?: string };
  rules?: AllowRule[];
};

type NetworkPolicy = {
  endpoints?: Endpoint[];
  binaries?: Array<{ path?: string }>;
  rules?: AllowRule[];
};

type PolicyDocument = {
  filesystem_policy?: { read_write?: string[] };
  network_policies?: Record<string, NetworkPolicy>;
};

const EXISTING_POLICY = YAML.stringify({
  version: 1,
  filesystem_policy: { read_write: ["/existing"] },
  network_policies: {
    existing: {
      name: "existing",
      endpoints: [{ host: "existing.example", port: 8443, access: "full", tls: "skip" }],
    },
  },
});

function composePresets(
  presetNames: string[],
  agent: "openclaw" | "hermes" = "openclaw",
): PolicyDocument {
  const result = policies.mergePresetNamesIntoPolicy(EXISTING_POLICY, presetNames, {
    agent,
    sandboxName: "effective-policy",
  });
  expect(result.appliedPresets).toEqual([...new Set(presetNames)]);
  expect(result.missingPresets).toEqual([]);

  const policy = YAML.parse(result.policy) as PolicyDocument;
  expect(policy.filesystem_policy?.read_write).toEqual(["/existing"]);
  expect(policy.network_policies?.existing).toBeDefined();
  return policy;
}

function requireNetworkPolicy(policy: PolicyDocument, name: string): NetworkPolicy {
  const entry = policy.network_policies?.[name];
  expect(entry, `expected effective network policy ${name}`).toBeDefined();
  return entry ?? {};
}

function requireEndpoint(policy: NetworkPolicy, host: string): Endpoint {
  const endpoint = (policy.endpoints ?? []).find((candidate) => candidate.host === host);
  expect(endpoint, `expected effective endpoint ${host}`).toBeDefined();
  return endpoint ?? {};
}

function rules(endpoint: Endpoint): Array<{ method?: string; path?: string }> {
  return (endpoint.rules ?? []).map((rule) => rule.allow ?? {});
}

function methods(endpoint: Endpoint): string[] {
  return rules(endpoint)
    .map((rule) => rule.method)
    .filter((method): method is string => typeof method === "string")
    .sort();
}

function binaries(policy: NetworkPolicy): string[] {
  return (policy.binaries ?? [])
    .map((binary) => binary.path)
    .filter((binary): binary is string => typeof binary === "string")
    .sort();
}

function expectInspectedWebSocket(endpoint: Endpoint): void {
  expect(endpoint).toMatchObject({
    protocol: "websocket",
    enforcement: "enforce",
    websocket_credential_rewrite: true,
  });
  expect(endpoint).not.toHaveProperty("access");
  expect(endpoint).not.toHaveProperty("tls");
  expect(rules(endpoint)).toEqual(
    expect.arrayContaining([
      { method: "GET", path: "/**" },
      { method: "WEBSOCKET_TEXT", path: "/**" },
    ]),
  );
}

describe("effective built-in policy contracts", () => {
  it.each(["openclaw", "hermes"] as const)(
    "composes every preset advertised for %s while retaining existing non-web policy",
    (agent) => {
      const presetNames = policies.listPresets({ agent }).map((preset) => preset.name);
      const effective = composePresets(presetNames, agent);

      const policyKeys = Object.keys(effective.network_policies ?? {});
      expect(policyKeys).toEqual(expect.arrayContaining(["existing", "personal_open_internet"]));
      expect(policyKeys).not.toContain("npm_yarn");
      expect(policyKeys).not.toContain("tavily");
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "keeps %s effective policy methods explicit and avoids deprecated REST TLS mode",
    (agent) => {
      const presetNames = policies.listPresets({ agent }).map((preset) => preset.name);
      const effective = composePresets(presetNames, agent);

      Object.entries(effective.network_policies ?? {}).forEach(([policyName, policy]) => {
        expect(policy.rules, `${policyName} must put rules on endpoints`).toBeUndefined();
        const endpoints = policy.endpoints ?? [];
        expect(endpoints.every((endpoint) => !methods(endpoint).includes("*"))).toBe(true);
        expect(
          endpoints
            .filter(({ protocol }) => protocol === "rest")
            .every((endpoint) => !Object.is(endpoint.tls, "terminate")),
        ).toBe(true);
      });
    },
  );

  it("keeps package and public-data access read-only after composition", () => {
    const effective = composePresets(["pypi", "weather", "public-reference"]);
    const pypi = requireNetworkPolicy(effective, "pypi");
    const weather = requireNetworkPolicy(effective, "weather");
    const publicReference = requireNetworkPolicy(effective, "public_reference");

    [pypi, weather, publicReference].forEach((policy) => {
      for (const endpoint of policy.endpoints ?? []) {
        expect(endpoint).toMatchObject({
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
        });
        expect(endpoint).not.toHaveProperty("access");
        expect(new Set(methods(endpoint))).toEqual(new Set(["GET", "HEAD"]));
      }
    });

    expect((pypi.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
      "files.pythonhosted.org",
      "pypi.org",
    ]);
    expect(binaries(pypi)).toEqual(
      expect.arrayContaining(["/usr/bin/curl", "/usr/local/bin/curl"]),
    );

    expect((weather.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
      "api.open-meteo.com",
      "api.weather.gov",
      "geocoding-api.open-meteo.com",
      "wttr.in",
    ]);
    expect(rules(requireEndpoint(weather, "wttr.in"))).toEqual([
      { method: "GET", path: "/**" },
      { method: "HEAD", path: "/**" },
    ]);
    [weather, publicReference].forEach((policy) => {
      expect(binaries(policy)).toEqual(
        expect.arrayContaining([
          "/usr/local/bin/node",
          "/opt/hermes/.venv/bin/python",
          "/usr/bin/curl",
        ]),
      );
    });

    expect(
      loadAgent("openclaw").expectedVersion,
      "Revalidate the bundled OpenClaw weather skill before changing its reviewed egress contract",
    ).toBe("2026.7.1");
  });

  it("uses raw L4 tunnels only for protocols that cannot be REST-inspected", () => {
    const effective = composePresets(["npm", "gmail", "whatsapp"]);
    const npm = requireNetworkPolicy(effective, "npm_yarn");
    const gmail = requireNetworkPolicy(effective, "gmail_mail");
    const whatsapp = requireNetworkPolicy(effective, "whatsapp");

    (npm.endpoints ?? []).forEach((endpoint) => {
      expect(endpoint).toMatchObject({
        port: 443,
        access: "full",
        tls: "skip",
      });
      expect(endpoint).not.toHaveProperty("protocol");
      expect(endpoint).not.toHaveProperty("rules");
    });
    expect(binaries(npm)).toEqual(
      expect.arrayContaining(["/usr/local/bin/npm*", "/usr/local/bin/node*", "/usr/bin/node*"]),
    );

    expect(gmail.endpoints).toEqual([
      { host: "imap.gmail.com", port: 993, access: "full", tls: "skip" },
      { host: "smtp.gmail.com", port: 465, access: "full", tls: "skip" },
    ]);
    expect(binaries(gmail)).toEqual(["/usr/bin/python3"]);

    ["web.whatsapp.com", "*.web.whatsapp.com"].forEach((host) => {
      const endpoint = requireEndpoint(whatsapp, host);
      expect(endpoint).toMatchObject({
        port: 443,
        access: "full",
        tls: "skip",
      });
      expect(endpoint).not.toHaveProperty("protocol");
      expect(endpoint).not.toHaveProperty("rules");
    });
    ["whatsapp.net", "*.whatsapp.net"].forEach((host) => {
      const endpoint = requireEndpoint(whatsapp, host);
      expect(endpoint).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
      });
      expect(methods(endpoint)).toEqual(["GET", "POST"]);
    });
    expect(rules(requireEndpoint(whatsapp, "raw.githubusercontent.com"))).toEqual([
      {
        method: "GET",
        path: "/WhiskeySockets/Baileys/master/src/Defaults/index.ts",
      },
    ]);
    expect(binaries(whatsapp)).toEqual(["/usr/bin/node", "/usr/local/bin/node"]);
  });

  it("keeps mutable web APIs on their reviewed hosts, methods, and paths", () => {
    const effective = composePresets(["tavily", "outlook", "openclaw-pricing", "teams"]);
    const tavily = requireNetworkPolicy(effective, "tavily");
    const outlook = requireNetworkPolicy(effective, "outlook_graph");
    const pricing = requireNetworkPolicy(effective, "openclaw-pricing");
    const teams = requireNetworkPolicy(effective, "teams");

    expect(tavily.endpoints).toEqual([
      {
        host: "api.tavily.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: true,
        rules: [
          { allow: { method: "POST", path: "/search" } },
          { allow: { method: "POST", path: "/extract" } },
        ],
      },
    ]);
    expect(binaries(tavily)).toEqual(
      [
        "/opt/venv/bin/python3*",
        "/opt/hermes/.venv/bin/python",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/local/bin/curl",
        "/usr/bin/curl",
      ].sort(),
    );
    expect(binaries(tavily)).not.toEqual(
      expect.arrayContaining([
        "/usr/bin/python3*",
        "/usr/local/bin/python3*",
        "/sandbox/**/bin/python3*",
      ]),
    );

    const graph = requireEndpoint(outlook, "graph.microsoft.com");
    expect((outlook.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
      "graph.microsoft.com",
      "login.microsoftonline.com",
      "outlook.office.com",
      "outlook.office365.com",
    ]);
    expect(methods(graph)).toEqual(["GET", "PATCH", "POST"]);
    ["graph.microsoft.com", "login.microsoftonline.com"].forEach((host) => {
      expect(requireEndpoint(outlook, host).request_body_credential_rewrite).toBe(true);
      expect(requireEndpoint(outlook, host).request_body_credential_rewrite).toBe(
        requireEndpoint(teams, host).request_body_credential_rewrite,
      );
    });
    const outlookLogin = requireEndpoint(outlook, "login.microsoftonline.com");
    const teamsLogin = requireEndpoint(teams, "login.microsoftonline.com");
    expect(outlookLogin.credential_binding).toEqual({
      provider: "effective-policy-teams-bridge",
    });
    expect(outlookLogin.credential_binding).toEqual(teamsLogin.credential_binding);
    ["login.microsoftonline.com", "outlook.office365.com", "outlook.office.com"].forEach((host) => {
      expect(methods(requireEndpoint(outlook, host))).toEqual(["GET", "POST"]);
    });

    expect((pricing.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
      "openrouter.ai",
      "raw.githubusercontent.com",
    ]);
    expect(rules(requireEndpoint(pricing, "raw.githubusercontent.com"))).toEqual([
      {
        method: "GET",
        path: "/BerriAI/litellm/main/model_prices_and_context_window.json",
      },
    ]);
    expect(rules(requireEndpoint(pricing, "openrouter.ai"))).toEqual([
      { method: "GET", path: "/api/v1/models" },
    ]);
    expect(binaries(pricing)).toEqual(["/usr/bin/node", "/usr/local/bin/node"]);
  });

  it("limits local OTLP egress to reviewed trace submissions without embedded credentials", () => {
    const effective = composePresets([
      "observability-otlp-local",
      "openclaw-diagnostics-otel-local",
    ]);
    const observability = requireNetworkPolicy(effective, "observability-otlp-local");
    const diagnostics = requireNetworkPolicy(effective, "openclaw-diagnostics-otel-local");
    const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

    const observabilityEndpoint = requireEndpoint(observability, "host.openshell.internal");
    expect(observabilityEndpoint).toMatchObject({
      port: 4318,
      protocol: "rest",
      enforcement: "enforce",
      allowed_ips: privateRanges,
    });
    expect(rules(observabilityEndpoint)).toEqual([{ method: "POST", path: "/v1/traces" }]);
    expect(binaries(observability)).toEqual(["/opt/venv/bin/python3*"]);

    const diagnosticsEndpoint = requireEndpoint(diagnostics, "host.openshell.internal");
    expect(diagnosticsEndpoint).toMatchObject({
      port: 4318,
      protocol: "rest",
      enforcement: "enforce",
      allowed_ips: privateRanges,
    });
    expect(rules(diagnosticsEndpoint)).toEqual([
      { method: "POST", path: "/v1/traces" },
      { method: "POST", path: "/v1/traces/**" },
    ]);
    expect(binaries(diagnostics)).toEqual([
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/usr/local/bin/openclaw",
    ]);

    expect(JSON.stringify(observability)).not.toMatch(
      /authorization|cookie|credential|headers?|langsmith|secret|token/i,
    );
  });

  it("allows only the approved local Hindsight endpoint (#8613)", () => {
    const effective = composePresets(["local-memory"], "hermes");
    const localMemory = requireNetworkPolicy(effective, "local_memory");
    const endpoint = requireEndpoint(localMemory, "host.openshell.internal");
    const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

    expect(endpoint).toMatchObject({
      port: 8888,
      protocol: "rest",
      enforcement: "enforce",
      allowed_ips: privateRanges,
    });
    expect(rules(endpoint)).toEqual([
      { method: "GET", path: "/**" },
      { method: "POST", path: "/**" },
    ]);
    expect(binaries(localMemory)).toEqual(["/opt/hermes/.venv/bin/python"]);
    expect((localMemory.endpoints ?? []).some((entry) => entry.host === "10.0.0.1")).toBe(false);
  });

  it("keeps host-local inference and managed tools on their broker boundaries", () => {
    const matrix = loadManagedToolGatewayMatrix();
    const managedPresetNames = Object.keys(matrix);
    const effective = composePresets(["local-inference", ...managedPresetNames]);
    const localInference = requireNetworkPolicy(effective, "local_inference");
    const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

    [8000, 11434, 11435].forEach((port) => {
      const endpoint = (localInference.endpoints ?? []).find(
        (candidate) => candidate.host === "host.openshell.internal" && candidate.port === port,
      );
      expect(endpoint, `expected local inference port ${port}`).toMatchObject({
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: privateRanges,
      });
      expect(methods(endpoint ?? {})).toEqual(["GET", "POST"]);
    });
    const llamaCpp = (localInference.endpoints ?? []).find(
      (candidate) => candidate.host === "host.openshell.internal" && candidate.port === 8081,
    );
    expect(llamaCpp?.rules).toEqual([{ allow: { method: "POST", path: "/v1/chat/completions" } }]);
    expect(binaries(localInference)).toEqual(
      expect.arrayContaining([
        "/usr/local/bin/openclaw",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/bin/curl",
        "/usr/bin/python3",
      ]),
    );
    expect(binaries(localInference)).not.toContain("/usr/local/bin/claude");

    const vendorHosts = [
      "firecrawl-gateway.nousresearch.com",
      "fal-queue-gateway.nousresearch.com",
      "openai-audio-gateway.nousresearch.com",
      "browser-use-gateway.nousresearch.com",
      "modal-gateway.nousresearch.com",
    ];
    Object.entries(matrix).forEach(([presetName, entry]) => {
      const policyName = presetName.replace("-", "_");
      const policy = requireNetworkPolicy(effective, policyName);
      const broker = (policy.endpoints ?? []).find(
        (endpoint) => endpoint.host === "host.openshell.internal" && endpoint.port === 11436,
      );
      expect(JSON.stringify(broker), presetName).toContain(new URL(entry.envValue).pathname);
      expect(
        vendorHosts.every((host) =>
          Object.is(
            (policy.endpoints ?? []).some((endpoint) => endpoint.host === host),
            false,
          ),
        ),
      ).toBe(true);
      const browserHosts = (policy.endpoints ?? []).filter((endpoint) =>
        endpoint.host?.endsWith(".browser-use.com"),
      );
      expect(browserHosts.length > 0).toBe(presetName === "nous-browser");
    });
  });

  it("keeps OpenClaw messaging credentials and WebSockets inside inspected endpoints", () => {
    const effective = composePresets(["discord", "slack", "teams", "telegram", "wechat"]);

    for (const policyName of ["discord", "slack", "teams", "telegram_bot", "wechat_bridge"]) {
      expect(binaries(requireNetworkPolicy(effective, policyName))).toEqual(
        expect.arrayContaining(["/usr/bin/node", "/usr/local/bin/node"]),
      );
    }

    const discord = requireNetworkPolicy(effective, "discord");
    const slack = requireNetworkPolicy(effective, "slack");
    for (const host of ["gateway.discord.gg", "*.discord.gg"]) {
      expectInspectedWebSocket(requireEndpoint(discord, host));
    }
    for (const host of ["wss-primary.slack.com", "wss-backup.slack.com"]) {
      expectInspectedWebSocket(requireEndpoint(slack, host));
    }
    for (const host of ["slack.com", "api.slack.com", "hooks.slack.com"]) {
      expect(requireEndpoint(slack, host)).toMatchObject({
        protocol: "rest",
        request_body_credential_rewrite: true,
      });
    }

    const telegram = requireEndpoint(
      requireNetworkPolicy(effective, "telegram_bot"),
      "api.telegram.org",
    );
    expect(telegram).toMatchObject({
      protocol: "rest",
      enforcement: "enforce",
    });
    expect(telegram).not.toHaveProperty("tls");

    const wechat = requireNetworkPolicy(effective, "wechat_bridge");
    for (const host of ["ilinkai.weixin.qq.com", "ilinkai.wechat.com"]) {
      const endpoint = requireEndpoint(wechat, host);
      expect(endpoint).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
      });
      expect(methods(endpoint)).toEqual(["GET", "POST"]);
    }
  });

  it("composes Hermes-specific messaging mutation and runtime identity rules", () => {
    const effective = composePresets(["discord", "slack", "wechat"], "hermes");
    const discord = requireNetworkPolicy(effective, "discord");
    const slack = requireNetworkPolicy(effective, "slack");
    const wechat = requireNetworkPolicy(effective, "wechat_bridge");

    for (const policy of [discord, slack, wechat]) {
      expect(binaries(policy)).toEqual(
        expect.arrayContaining(["/usr/bin/python3*", "/opt/hermes/.venv/bin/python"]),
      );
    }
    for (const host of ["gateway.discord.gg", "*.discord.gg"]) {
      expectInspectedWebSocket(requireEndpoint(discord, host));
    }
    for (const host of ["wss-primary.slack.com", "wss-backup.slack.com"]) {
      expectInspectedWebSocket(requireEndpoint(slack, host));
    }
    for (const host of ["slack.com", "api.slack.com", "hooks.slack.com"]) {
      expect(requireEndpoint(slack, host)).toMatchObject({
        protocol: "rest",
        request_body_credential_rewrite: true,
      });
    }

    const mutationRules = (discord.endpoints ?? [])
      .filter((endpoint) => endpoint.host !== "discord.com")
      .flatMap((endpoint) => rules(endpoint))
      .filter((rule) => ["PUT", "PATCH", "DELETE"].includes(rule.method ?? ""));
    expect(mutationRules).toEqual([]);
    const discordMutations = rules(requireEndpoint(discord, "discord.com")).filter((rule) =>
      ["PUT", "PATCH", "DELETE"].includes(rule.method ?? ""),
    );
    expect(
      discordMutations.sort((a, b) =>
        `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
      ),
    ).toEqual(
      [
        { method: "PUT", path: "/api/v*/applications/*/commands" },
        {
          method: "PUT",
          path: "/api/v*/channels/*/messages/*/reactions/*/@me",
        },
        { method: "PATCH", path: "/api/v*/applications/*" },
        { method: "PATCH", path: "/api/v*/applications/*/commands/*" },
        { method: "PATCH", path: "/api/v*/channels/*/messages/*" },
        { method: "PATCH", path: "/api/v*/webhooks/*/*/messages/*" },
        { method: "DELETE", path: "/api/v*/applications/*/commands/*" },
        { method: "DELETE", path: "/api/v*/channels/*/messages/*" },
        {
          method: "DELETE",
          path: "/api/v*/channels/*/messages/*/reactions/*/*",
        },
        { method: "DELETE", path: "/api/v*/webhooks/*/*/messages/*" },
      ].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
    );
    expect(discordMutations.some((rule) => rule.path === "/**")).toBe(false);
  });

  it("keeps tool installers and optional Claude egress on explicit binary and host scopes", () => {
    const effective = composePresets(["brew", "claude-code"]);
    const brew = requireNetworkPolicy(effective, "brew");
    const claude = requireNetworkPolicy(effective, "claude_code");

    expect(binaries(brew)).toEqual(
      [
        "/home/linuxbrew/.linuxbrew/Homebrew/bin/*",
        "/home/linuxbrew/.linuxbrew/bin/*",
        "/home/linuxbrew/.linuxbrew/bin/brew",
        "/usr/bin/curl",
        "/usr/local/bin/brew",
      ].sort(),
    );
    ["github.com", "raw.githubusercontent.com"].forEach((host) => {
      const endpoint = requireEndpoint(brew, host);
      expect(endpoint).toMatchObject({ port: 443, access: "full" });
      expect(endpoint).not.toHaveProperty("protocol");
      expect(endpoint).not.toHaveProperty("tls");
    });
    (brew.endpoints ?? [])
      .filter(
        (candidate) => !["github.com", "raw.githubusercontent.com"].includes(candidate.host ?? ""),
      )
      .forEach((endpoint) => {
        expect(endpoint).toMatchObject({ access: "full", tls: "skip" });
      });
    expect((claude.endpoints ?? []).map((endpoint) => endpoint.host).sort()).toEqual([
      "api.anthropic.com",
      "platform.claude.com",
      "sentry.io",
      "statsig.anthropic.com",
    ]);
    (claude.endpoints ?? []).forEach((endpoint) => {
      expect(endpoint).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
      });
      expect(endpoint).not.toHaveProperty("access");
      expect(methods(endpoint)).toEqual(["GET", "POST"]);
    });
    expect(binaries(claude)).not.toContain("/**");
    // OpenShell enforces on the resolved /proc/<pid>/exe, so the npm-installed
    // launcher (not just the bin/claude shim) must be allowlisted or egress is
    // denied for the documented `--prefix /tmp/npm-global` install (#7579).
    expect(binaries(claude)).toContain(
      "/tmp/npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    );
  });

  it("allows the Claude Code browser login to exchange its authorization code on the OAuth paths only (#7637)", () => {
    const effective = composePresets(["claude-code"]);
    const claude = requireNetworkPolicy(effective, "claude_code");
    const login = requireEndpoint(claude, "platform.claude.com");

    expect(login).toMatchObject({
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
    });
    expect(rules(login)).toEqual([
      { method: "GET", path: "/v1/oauth/**" },
      { method: "POST", path: "/v1/oauth/**" },
    ]);
  });
});
