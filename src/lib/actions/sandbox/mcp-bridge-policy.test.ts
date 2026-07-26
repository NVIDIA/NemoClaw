// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policies from "../../policy";
import type { McpBridgeEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  buildMcpBridgePolicyName,
  buildMcpBridgePolicyYaml,
  buildMcpBridgeProviderName,
  MCP_BRIDGE_ALLOWED_METHODS,
  MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
  MCP_BRIDGE_POLICY_SOURCE,
} from "./mcp-bridge";
import { applyGeneratedPolicy, assertGeneratedPolicyExactReadOnly } from "./mcp-bridge-policy";

function githubBridgeEntry(overrides: Partial<McpBridgeEntry> = {}): McpBridgeEntry {
  return {
    server: "github",
    agent: "openclaw",
    adapter: "mcporter",
    url: "https://api.githubcopilot.com/mcp",
    env: ["GITHUB_MCP_TOKEN"],
    providerName: "alpha-mcp-github-0123456789abcdef",
    policyName: "mcp-bridge-github",
    addedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("MCP OpenShell policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to apply a generated policy without exact public address pins", () => {
    expect(() =>
      applyGeneratedPolicy(
        "alpha",
        {
          server: "github",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://api.githubcopilot.com/mcp",
          env: ["GITHUB_MCP_TOKEN"],
          providerName: "alpha-mcp-github-0123456789abcdef",
          policyName: "mcp-bridge-github",
          addedAt: "2026-06-01T00:00:00.000Z",
        },
        [],
      ),
    ).toThrow(/without exact public address pins/);
  });

  it("pins DNS answers while constraining the generic mcporter Node grant", () => {
    const policyName = buildMcpBridgePolicyName("GitHub_Server");
    const policy = YAML.parse(
      buildMcpBridgePolicyYaml("GitHub_Server", "https://api.githubcopilot.com/mcp", "mcporter", [
        "8.8.8.8",
        "2606:4700:4700::1111",
      ]),
    ) as {
      preset: { name: string };
      network_policies: Record<
        string,
        {
          endpoints: Array<{
            host: string;
            port: number;
            path: string;
            protocol: string;
            mcp: {
              max_body_bytes: number;
              strict_tool_names?: boolean;
              allow_all_known_mcp_methods?: boolean;
            };
            allowed_ips?: string[];
            rules?: Array<{ allow: { method: string } }>;
          }>;
          binaries: Array<{ path: string }>;
        }
      >;
    };
    const entry = policy.network_policies.mcp_bridge_github_server;

    expect(policyName).toBe("mcp-bridge-github-server");
    expect(policy.preset.name).toBe(policyName);
    expect(entry.endpoints[0]).toMatchObject({
      host: "api.githubcopilot.com",
      port: 443,
      path: "/mcp",
      protocol: "mcp",
      enforcement: "enforce",
      mcp: {
        max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
        strict_tool_names: true,
        allow_all_known_mcp_methods: false,
      },
    });
    expect(entry.endpoints[0].rules).toEqual(
      MCP_BRIDGE_ALLOWED_METHODS.map((method) => ({
        allow: { method },
      })),
    );
    expect(entry.endpoints[0].allowed_ips).toEqual(["8.8.8.8", "2606:4700:4700::1111"]);
    expect(entry.binaries.map((binary) => binary.path)).toEqual([
      "/usr/local/bin/mcporter",
      "/usr/bin/mcporter",
      "/usr/local/bin/openclaw",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ]);
    expect(entry.endpoints[0].mcp).toEqual({
      max_body_bytes: MCP_BRIDGE_POLICY_MAX_BODY_BYTES,
      strict_tool_names: true,
      allow_all_known_mcp_methods: false,
    });
  });

  it("applies internally generated DNS pins outside the user-supplied preset path", () => {
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue([]);
    vi.spyOn(registry, "addCustomPolicy").mockReturnValue(true);
    vi.spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValueOnce("absent")
      .mockReturnValueOnce("match");
    const applyPresetContent = vi.spyOn(policies, "applyPresetContent").mockReturnValue(true);

    applyGeneratedPolicy(
      "alpha",
      {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://api.githubcopilot.com/mcp",
        env: ["GITHUB_MCP_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      },
      ["8.8.8.8"],
    );

    const [, , generatedContent, options] = applyPresetContent.mock.calls[0];
    expect(generatedContent).toContain("allowed_ips:");
    expect(options).toEqual({
      expectedExistingNetworkPolicyContent: null,
      nonFatal: true,
      skipRegistryUpdate: true,
    });
  });

  it("accepts only the canonical generated policy for the exact bridge and DNS pins", () => {
    const entry = githubBridgeEntry();
    const pins = ["8.8.8.8", "2606:4700:4700::1111"];
    const content = buildMcpBridgePolicyYaml(entry.server, entry.url, "mcporter", pins);
    const registration = {
      name: entry.policyName,
      content,
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue([registration]);
    const gatewayState = vi
      .spyOn(policies, "getPresetContentGatewayState")
      .mockReturnValue("match");

    expect(assertGeneratedPolicyExactReadOnly("alpha", entry, "mcporter", pins)).toEqual(
      registration,
    );
    expect(gatewayState).toHaveBeenCalledWith("alpha", content);
  });

  it.each([
    "owned-first",
    "unowned-first",
  ])("rejects duplicate same-name ownership records regardless of order (%s)", (order) => {
    const entry = githubBridgeEntry();
    const pins = ["8.8.8.8"];
    const content = buildMcpBridgePolicyYaml(entry.server, entry.url, "mcporter", pins);
    const owned = {
      name: entry.policyName,
      content,
      sourcePath: MCP_BRIDGE_POLICY_SOURCE,
    };
    const unowned = {
      name: entry.policyName,
      content: `${content}\n# conflicting duplicate`,
      sourcePath: "/tmp/operator-policy.yaml",
    };
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue(
      order === "owned-first" ? [owned, unowned] : [unowned, owned],
    );
    const gatewayState = vi.spyOn(policies, "getPresetContentGatewayState");

    expect(() => assertGeneratedPolicyExactReadOnly("alpha", entry, "mcporter", pins)).toThrow(
      /ownership is missing or ambiguous/,
    );
    expect(gatewayState).not.toHaveBeenCalled();
  });

  it("rejects individually valid policy records that disagree with their bridge definition", () => {
    const entry = githubBridgeEntry();
    const pins = ["8.8.8.8"];
    const canonical = buildMcpBridgePolicyYaml(entry.server, entry.url, "mcporter", pins);
    const wrongKeyDocument = YAML.parse(canonical) as {
      network_policies: Record<string, { name: string }>;
    };
    wrongKeyDocument.network_policies.mcp_bridge_other = {
      ...wrongKeyDocument.network_policies.mcp_bridge_github,
      name: "mcp_bridge_other",
    };
    delete wrongKeyDocument.network_policies.mcp_bridge_github;

    const mismatches: Array<{
      label: string;
      candidateEntry?: McpBridgeEntry;
      candidateName?: string;
      content: string;
    }> = [
      {
        label: "host",
        content: buildMcpBridgePolicyYaml(
          entry.server,
          "https://mcp.example.test/mcp",
          "mcporter",
          pins,
        ),
      },
      {
        label: "path",
        content: buildMcpBridgePolicyYaml(
          entry.server,
          "https://api.githubcopilot.com/other",
          "mcporter",
          pins,
        ),
      },
      {
        label: "adapter",
        content: buildMcpBridgePolicyYaml(entry.server, entry.url, "hermes-config", pins),
      },
      { label: "network policy key", content: YAML.stringify(wrongKeyDocument) },
      {
        label: "resolved address pins",
        content: buildMcpBridgePolicyYaml(entry.server, entry.url, "mcporter", ["1.1.1.1"]),
      },
      {
        label: "policy name",
        candidateEntry: githubBridgeEntry({ policyName: "mcp-bridge-other" }),
        candidateName: "mcp-bridge-other",
        content: canonical,
      },
    ];

    for (const mismatch of mismatches) {
      vi.restoreAllMocks();
      const candidateEntry = mismatch.candidateEntry ?? entry;
      vi.spyOn(registry, "getCustomPolicies").mockReturnValue([
        {
          name: mismatch.candidateName ?? candidateEntry.policyName,
          content: mismatch.content,
          sourcePath: MCP_BRIDGE_POLICY_SOURCE,
        },
      ]);
      const gatewayState = vi.spyOn(policies, "getPresetContentGatewayState");

      expect(
        () => assertGeneratedPolicyExactReadOnly("alpha", candidateEntry, "mcporter", pins),
        mismatch.label,
      ).toThrow(/not canonical for its recorded bridge definition/);
      expect(gatewayState, mismatch.label).not.toHaveBeenCalled();
    }
  });

  it("does not expose malformed persisted URLs in canonical ownership errors", () => {
    const secret = `nvapi-${"a".repeat(32)}`;
    const entry = githubBridgeEntry({ url: `not-a-url-${secret}` });
    vi.spyOn(registry, "getCustomPolicies").mockReturnValue([]);

    let message = "";
    try {
      assertGeneratedPolicyExactReadOnly("alpha", entry, "mcporter", ["8.8.8.8"]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("not canonical for its recorded bridge definition");
    expect(message).not.toContain(secret);
  });

  it("pins the current OpenShell main client-to-server MCP method profile", () => {
    expect(MCP_BRIDGE_ALLOWED_METHODS).toEqual([
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "resources/subscribe",
      "resources/unsubscribe",
      "prompts/list",
      "prompts/get",
      "tasks/list",
      "tasks/get",
      "tasks/update",
      "tasks/result",
      "tasks/cancel",
      "completion/complete",
      "logging/setLevel",
      "server/discover",
      "messages/listen",
      "notifications/cancelled",
      "notifications/progress",
      "notifications/roots/list_changed",
      "notifications/elicitation/complete",
    ]);
  });

  it("emits only fields supported by OpenShell current main", () => {
    const policy = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "mcporter"),
    ) as { network_policies: Record<string, { endpoints: Array<Record<string, unknown>> }> };
    const endpoint = policy.network_policies.mcp_bridge_srv.endpoints[0];
    expect(endpoint).not.toHaveProperty("credential_keys");
    expect(endpoint).not.toHaveProperty("tls");
  });

  it("refuses to generate authenticated policies for unpinnable OpenShell host aliases", () => {
    for (const host of [
      "host.openshell.internal",
      "host.openshell.internal.",
      "host.docker.internal",
      "host.containers.internal",
    ]) {
      expect(() =>
        buildMcpBridgePolicyYaml("local", `https://${host}:31337/mcp`, "mcporter"),
      ).toThrow(/does not expose an attested driver gateway address/);
    }
  });

  it("scopes binaries to the selected agent adapter", () => {
    const hermes = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "hermes-config"),
    ) as {
      network_policies: Record<string, { binaries: Array<{ path: string }> }>;
    };
    const deepAgents = YAML.parse(
      buildMcpBridgePolicyYaml("srv", "https://mcp.example.test/mcp", "deepagents-config"),
    ) as {
      network_policies: Record<string, { binaries: Array<{ path: string }> }>;
    };

    expect(hermes.network_policies.mcp_bridge_srv.binaries.map((b) => b.path)).toEqual([
      "/usr/local/bin/hermes",
      "/usr/bin/python3*",
      "/opt/hermes/.venv/bin/python*",
    ]);
    expect(deepAgents.network_policies.mcp_bridge_srv.binaries.map((b) => b.path)).toEqual([
      "/usr/local/bin/dcode",
      "/opt/venv/bin/python3*",
    ]);
  });

  it("uses stable collision-resistant provider names with a length guard", () => {
    expect(buildMcpBridgeProviderName("alpha", "github-server")).toBe("alpha-mcp-github-server");
    const caseNormalized = buildMcpBridgeProviderName("alpha", "GitHub-Server");
    const underscoreNormalized = buildMcpBridgeProviderName("alpha", "github_server");
    expect(caseNormalized).toMatch(/^alpha-mcp-github-server-[a-f0-9]{16}$/);
    expect(underscoreNormalized).toMatch(/^alpha-mcp-github-server-[a-f0-9]{16}$/);
    expect(new Set([caseNormalized, underscoreNormalized, "alpha-mcp-github-server"]).size).toBe(3);
    const long = buildMcpBridgeProviderName(
      "sandbox-name-with-a-long-prefix",
      "ServerNameThatWouldOtherwiseExceedTheProviderNameLimit",
    );
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^sandbox-name-with-a-long-prefix-mcp-servername-[a-f0-9]{16}$/);
    expect(buildMcpBridgeProviderName("alpha", "github-server", "0123456789abcdef")).toBe(
      "alpha-mcp-github-server-0123456789abcdef",
    );
  });
});
