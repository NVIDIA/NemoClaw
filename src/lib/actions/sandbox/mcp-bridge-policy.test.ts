// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policies from "../../policy";
import { replayTrustedPrivateEndpoint } from "../../security/trusted-private-endpoint";
import type { McpBridgeEntry } from "../../state/registry";
import {
  applyGeneratedPolicy,
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  getRegisteredGeneratedPolicy,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
  removeGeneratedPolicy,
} from "./mcp-bridge-policy";
import { buildMcpBridgeProviderName } from "./mcp-bridge-validation";

const entry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.com/api",
  env: [],
  allowedIps: ["8.8.8.8"],
  providerName: "mcp-github",
  policyName: buildMcpBridgePolicyName("github"),
  addedAt: "2026-08-27T00:00:00.000Z",
};
const runtimeSelection = {
  gatewayName: "nemoclaw-9090",
  workspace: "default",
};

beforeEach(() => vi.restoreAllMocks());

describe("generated MCP policy", () => {
  it("derives canonical policy content from MCP domain state", () => {
    expect(getRegisteredGeneratedPolicy("alpha", entry)).toEqual(
      expect.objectContaining({
        name: entry.policyName,
        content: expect.stringContaining("allowed_ips"),
      }),
    );
  });

  it("applies directly to live OpenShell policy without a custom-policy registry row", () => {
    const livePolicy: { network_policies: Record<string, unknown> } = { network_policies: {} };
    const applySpy = vi.spyOn(policies, "applyPresetContent").mockImplementation(
      (_sandboxName, _presetName, content) => {
        Object.assign(
          livePolicy.network_policies,
          (YAML.parse(content) as typeof livePolicy).network_policies,
        );
        return true;
      },
    );
    const stateSpy = vi.spyOn(policies, "getPresetContentGatewayState").mockImplementation(
      (_sandboxName, content) => {
        const expected = (YAML.parse(content) as typeof livePolicy).network_policies;
        return Object.keys(expected).every((key) => key in livePolicy.network_policies)
          ? "match"
          : "absent";
      },
    );

    applyGeneratedPolicy(
      "alpha",
      entry,
      { addresses: ["8.8.8.8"] },
      { runtimeSelection },
    );

    expect(livePolicy.network_policies.mcp_bridge_github).toMatchObject({
      endpoints: [
        expect.objectContaining({
          allowed_ips: ["8.8.8.8"],
          credential_binding: { provider: "mcp-github" },
        }),
      ],
    });
    expect(applySpy).toHaveBeenCalledWith(
      "alpha",
      entry.policyName,
      expect.any(String),
      expect.objectContaining({ runtimeSelection }),
    );
    expect(stateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.any(String),
      undefined,
      runtimeSelection,
    );
  });

  it("removes generated content from the live policy", () => {
    const livePolicy: { network_policies: Record<string, unknown> } = {
      network_policies: {
        mcp_bridge_github: YAML.parse(
          buildMcpBridgePolicyYaml(
            "github",
            entry.url,
            "mcporter",
            { addresses: ["8.8.8.8"] },
            "mcp-github",
          ),
        ).network_policies.mcp_bridge_github,
      },
    };
    const removeSpy = vi.spyOn(policies, "removePreset").mockImplementation(
      (_sandboxName, _presetName, options) => {
        const removal = (YAML.parse(options?.presetContent ?? "") as typeof livePolicy)
          .network_policies;
        expect(removal).toHaveProperty("mcp_bridge_github");
        delete livePolicy.network_policies.mcp_bridge_github;
        return true;
      },
    );

    removeGeneratedPolicy("alpha", entry, { runtimeSelection });

    expect(livePolicy.network_policies).not.toHaveProperty("mcp_bridge_github");
    expect(removeSpy).toHaveBeenCalledWith(
      "alpha",
      entry.policyName,
      expect.objectContaining({ runtimeSelection }),
    );
  });

  it("refuses generated policy without exact public address pins", () => {
    expect(() =>
      applyGeneratedPolicy(
        "alpha",
        { ...entry, allowedIps: [] },
        { addresses: [] },
        { runtimeSelection },
      ),
    ).toThrow(/without exact public address pins/);
  });

  it("refuses to render a credential binding without an exact provider name", () => {
    expect(() =>
      buildMcpBridgePolicyYaml(
        "github",
        "https://api.githubcopilot.com/mcp",
        "mcporter",
        { addresses: ["8.8.8.8"] },
        "",
      ),
    ).toThrow(/requires an exact provider name/);
    expect(() =>
      buildMcpBridgePolicyYaml(
        "github",
        "https://api.githubcopilot.com/mcp",
        "mcporter",
        { addresses: ["8.8.8.8"] },
        " provider ",
      ),
    ).toThrow(/requires an exact provider name/);
  });

  it("pins DNS answers and the current MCP method profile for mcporter", () => {
    const parsed = YAML.parse(
      buildMcpBridgePolicyYaml(
        "GitHub_Server",
        "https://api.githubcopilot.com/mcp",
        "mcporter",
        { addresses: ["2606:4700:4700::1111", "8.8.8.8"] },
        "alpha-mcp-bound-provider",
      ),
    ) as {
      preset: { name: string };
      network_policies: Record<
        string,
        {
          endpoints: Array<{
            allowed_ips: string[];
            credential_binding: { provider: string };
            mcp: Record<string, unknown>;
            rules: Array<{ allow: { method: string } }>;
          }>;
          binaries: Array<{ path: string }>;
        }
      >;
    };
    const policy = parsed.network_policies.mcp_bridge_github_server;

    expect(parsed.preset.name).toBe("mcp-bridge-github-server");
    expect(policy.endpoints[0]).toMatchObject({
      allowed_ips: ["2606:4700:4700::1111", "8.8.8.8"],
      credential_binding: { provider: "alpha-mcp-bound-provider" },
      mcp: {
        max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
        strict_tool_names: true,
        allow_all_known_mcp_methods: false,
      },
    });
    expect(policy.endpoints[0].rules).toEqual(
      MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({ allow: { method } })),
    );
    expect(policy.binaries.map(({ path }) => path)).toEqual([
      "/usr/local/bin/mcporter",
      "/usr/bin/mcporter",
      "/usr/local/bin/openclaw",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]);
  });

  it.each(["mcporter", "hermes-config", "deepagents-config"] as const)(
    "renders an authorized private target for %s with a process-local capability",
    (adapter) => {
      const replay = replayTrustedPrivateEndpoint("10.20.30.40", ["10.20.30.40"]);
      const parsed = YAML.parse(
        buildMcpBridgePolicyYaml(
          "local",
          "https://10.20.30.40/mcp",
          adapter,
          {
            addresses: [...replay.addresses],
            trustedPrivateCapability: replay.trustedPrivateCapability,
            trustedPrivateHost: replay.host,
          },
          "alpha-mcp-private-provider",
        ),
      ) as {
        network_policies: Record<
          string,
          { endpoints: Array<{ allowed_ips: string[]; host: string }> }
        >;
      };
      expect(parsed.network_policies.mcp_bridge_local.endpoints[0]).toMatchObject({
        host: "10.20.30.40",
        allowed_ips: ["10.20.30.40"],
      });
    },
  );

  it("rejects a missing, forged, or host-mismatched private capability", () => {
    const replay = replayTrustedPrivateEndpoint("mcp.corp.internal", ["10.20.30.40"]);
    const target = {
      addresses: [...replay.addresses],
      trustedPrivateCapability: replay.trustedPrivateCapability,
      trustedPrivateHost: replay.host,
    };
    expect(() =>
      buildMcpBridgePolicyYaml(
        "local",
        "https://other.corp.internal/mcp",
        "mcporter",
        target,
        "alpha-mcp-private-provider",
      ),
    ).toThrow(/does not match URL host/);
    expect(() =>
      buildMcpBridgePolicyYaml(
        "local",
        "https://mcp.corp.internal/mcp",
        "mcporter",
        { addresses: ["10.20.30.40"], trustedPrivateHost: "mcp.corp.internal" },
        "alpha-mcp-private-provider",
      ),
    ).toThrow(/no provenance-checked endpoint capability/);
    expect(() =>
      buildMcpBridgePolicyYaml(
        "local",
        "https://mcp.corp.internal/mcp",
        "mcporter",
        {
          addresses: ["10.20.30.40"],
          trustedPrivateHost: "mcp.corp.internal",
          trustedPrivateCapability: {
            host: "mcp.corp.internal",
            addresses: ["10.20.30.40"],
          },
        } as never,
        "alpha-mcp-private-provider",
      ),
    ).toThrow(/does not match its host-bound endpoint capability/);
  });

  it.each([
    "host.openshell.internal",
    "host.openshell.internal.",
    "host.docker.internal",
    "host.containers.internal",
  ])("refuses an unpinnable host alias [case %#]", (host) => {
    expect(() =>
      buildMcpBridgePolicyYaml(
        "local",
        `https://${host}:31337/mcp`,
        "mcporter",
        { addresses: ["8.8.8.8"] },
        "alpha-mcp-provider",
      ),
    ).toThrow(/does not expose an attested driver gateway address/);
  });

  it("emits only current OpenShell fields and scopes binaries by adapter", () => {
    const render = (adapter: "mcporter" | "hermes-config" | "deepagents-config") =>
      YAML.parse(
        buildMcpBridgePolicyYaml(
          "srv",
          "https://mcp.example.test/mcp",
          adapter,
          { addresses: ["8.8.8.8"] },
          "alpha-mcp-provider",
        ),
      ) as {
        network_policies: Record<
          string,
          { binaries: Array<{ path: string }>; endpoints: Array<Record<string, unknown>> }
        >;
      };
    const mcporter = render("mcporter").network_policies.mcp_bridge_srv;
    expect(mcporter.endpoints[0]).not.toHaveProperty("credential_keys");
    expect(mcporter.endpoints[0]).not.toHaveProperty("tls");
    expect(
      render("hermes-config").network_policies.mcp_bridge_srv.binaries.map((b) => b.path),
    ).toEqual(["/usr/local/bin/hermes", "/usr/bin/python3*", "/opt/hermes/.venv/bin/python*"]);
    expect(
      render("deepagents-config").network_policies.mcp_bridge_srv.binaries.map((b) => b.path),
    ).toEqual(["/usr/local/bin/dcode", "/opt/venv/bin/python3*"]);
  });

  it("uses stable collision-resistant provider names with a length guard", () => {
    expect(buildMcpBridgeProviderName("alpha", "github-server")).toBe("alpha-mcp-github-server");
    const caseNormalized = buildMcpBridgeProviderName("alpha", "GitHub-Server");
    const underscoreNormalized = buildMcpBridgeProviderName("alpha", "github_server");
    expect(caseNormalized).toMatch(/^alpha-mcp-github-server-[a-f0-9]{16}$/u);
    expect(underscoreNormalized).toMatch(/^alpha-mcp-github-server-[a-f0-9]{16}$/u);
    expect(new Set([caseNormalized, underscoreNormalized, "alpha-mcp-github-server"]).size).toBe(3);
    expect(
      buildMcpBridgeProviderName(
        "sandbox-name-prefix",
        "ServerNameThatWouldOtherwiseExceedTheProviderNameLimit",
      ).length,
    ).toBeLessThanOrEqual(63);
  });
});
