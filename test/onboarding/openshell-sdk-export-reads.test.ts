// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { createProviders } from "../../src/lib/adapters/openshell/providers";
import { createSandboxes } from "../../src/lib/adapters/openshell/sandboxes";
import {
  createSandboxConfig,
  serializeSdkPolicy,
} from "../../src/lib/adapters/openshell/sandbox-config";
import type { OpenShellReadClient } from "../../src/lib/adapters/openshell/sdk-read";

// CI stages the reviewed optional SDK artifact. Source-only checkouts can run
// the deterministic adapter tests without that artifact.
function hasSdkArtifact(): boolean {
  try {
    import.meta.resolve("@nvidia/openshell-sdk/raw");
    return true;
  } catch {
    return false;
  }
}

describe("released OpenShell SDK export reads", () => {
  it.skipIf(!hasSdkArtifact()).each(["openai", "nvidia"] as const)(
    "accepts generated %s responses without losing identity or uint64 revisions",
    async (providerType) => {
      const sdkPackage = "@nvidia/openshell-sdk/raw";
      const protobufPackage = "@bufbuild/protobuf";
      const [raw, { create, toBinary, fromBinary }] = await Promise.all([
        import(sdkPackage),
        import(protobufPackage),
      ]);
      const metadata = {
        id: "resource-id",
        name: "alpha",
        workspace: "default",
        resourceVersion: 18446744073709551615n,
      };
      // Binary round trips exercise the released wire schemas and their defaults.
      const roundTrip = (schema: unknown, input: unknown) =>
        fromBinary(schema, toBinary(schema, create(schema, input)));
      const client: OpenShellReadClient = {
        raw: {
          getProviderProfile: async () =>
            roundTrip(raw.OpenShell.method.getProviderProfile.output, {
              profile: {
                id: "nvidia",
                source: "builtin",
                inferenceCapable: true,
                endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }],
              },
            }),
          getProvider: async () =>
            roundTrip(raw.OpenShell.method.getProvider.output, {
              provider: {
                metadata,
                type: providerType,
                credentials: { API_KEY: "REDACTED" },
                config:
                  providerType === "nvidia" ? {} : { OPENAI_BASE_URL: "https://api.example/v1" },
              },
            }),
          getSandbox: async () =>
            roundTrip(raw.OpenShell.method.getSandbox.output, {
              sandbox: {
                metadata,
                spec: { template: { image: "image@sha256:" + "a".repeat(64) } },
                status: { currentPolicyVersion: 3 },
              },
            }),
          getSandboxConfig: async () =>
            roundTrip(raw.GetSandboxConfigResponseSchema, {
              policy: {
                version: 1,
                filesystem: { readOnly: ["/usr"] },
                networkPolicies: {
                  api: {
                    name: "api",
                    endpoints: [{ host: "api.example", ports: [443] }],
                    binaries: [{ path: "/usr/bin/curl" }],
                  },
                },
              },
              workspace: "default",
              version: 3,
              policyHash: "a".repeat(64),
              policySource: 1,
              configRevision: 9007199254740993n,
              providerEnvRevision: 18446744073709551615n,
            }),
        },
      };
      const connect = async () => client;
      const request = {
        target: { kind: "named", gatewayName: "nemoclaw" } as const,
        workspace: "default",
        name: "alpha",
        signal: new AbortController().signal,
      };
      expect(
        await createProviders(connect).get({ ...request, configKeys: ["OPENAI_BASE_URL"] }),
      ).toMatchObject({
        workspace: "default",
        resourceVersion: "18446744073709551615",
        ...(providerType === "nvidia"
          ? { config: {}, builtinInferenceEndpoint: "https://integrate.api.nvidia.com/v1" }
          : { config: { OPENAI_BASE_URL: "https://api.example/v1" } }),
      });
      expect(await createSandboxes(connect).get(request)).toMatchObject({
        id: "resource-id",
        policyVersion: 3,
        providers: [],
      });
      const config = await createSandboxConfig(connect).get({
        ...request,
        sandboxId: "resource-id",
      });
      expect(config).toMatchObject({
        policySource: "sandbox",
        globalPolicyVersion: 0,
        configRevision: "9007199254740993",
        providerEnvRevision: "18446744073709551615",
        policy: { appliedRevision: 3 },
      });
      expect(YAML.parse(config.policy.document)).toEqual({
        version: 1,
        filesystem_policy: { include_workdir: false, read_only: ["/usr"] },
        network_policies: {
          api: {
            name: "api",
            endpoints: [{ host: "api.example", port: 443 }],
            binaries: [{ path: "/usr/bin/curl" }],
          },
        },
      });
    },
  );
});

describe.skipIf(!hasSdkArtifact())("released OpenShell policy wire safety", () => {
  it("rejects unknown policy wire fields instead of exporting a partial policy", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create, toBinary, fromBinary }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const bytes = toBinary(SandboxPolicySchema, create(SandboxPolicySchema, { version: 1 }));
    const policy = fromBinary(SandboxPolicySchema, Uint8Array.from([...bytes, 0xf8, 0x07, 0x01]));
    await expect(serializeSdkPolicy(policy)).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it("serializes equal policy maps identically regardless of wire order", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const rule = {
      name: "api",
      endpoints: [{ host: "api.example", port: 443 }],
      binaries: [{ path: "/usr/bin/curl" }],
    };
    const first = create(SandboxPolicySchema, {
      version: 1,
      networkPolicies: { z: rule, a: rule },
    });
    const second = create(SandboxPolicySchema, {
      version: 1,
      networkPolicies: { a: rule, z: rule },
    });
    expect(await serializeSdkPolicy(first)).toBe(await serializeSdkPolicy(second));
  });

  it("rejects unknown nested policy wire fields", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create, toBinary, fromBinary }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const input = create(SandboxPolicySchema, {
      version: 1,
      networkPolicies: {
        api: {
          name: "api",
          endpoints: [{ host: "api.example", port: 443 }],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    });
    input.networkPolicies.api.endpoints[0].$unknown = [
      { no: 127, wireType: 0, data: Uint8Array.of(1) },
    ];
    const policy = fromBinary(SandboxPolicySchema, toBinary(SandboxPolicySchema, input));
    await expect(serializeSdkPolicy(policy)).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it.each([undefined, {}])("rejects missing or untyped policy messages: %j", async (policy) => {
    await expect(serializeSdkPolicy(policy)).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });

  it("rejects credential-bearing policy matchers without exposing their values", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const policy = create(SandboxPolicySchema, {
      version: 1,
      networkPolicies: {
        api: {
          name: "api",
          endpoints: [
            {
              host: "api.example",
              port: 443,
              rules: [{ allow: { query: { api_key: { glob: "credential-canary" } } } }],
            },
          ],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    });
    await expect(serializeSdkPolicy(policy)).rejects.toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
  });
});

describe.skipIf(!hasSdkArtifact())("released OpenShell policy document conversion", () => {
  it.each([
    ["single port", { port: 443 }, { port: 443 }],
    ["single port list", { ports: [443] }, { port: 443 }],
    ["multiple ports", { port: 80, ports: [443, 8443] }, { ports: [443, 8443] }],
    [
      "REST allow and deny query matchers",
      {
        port: 443,
        protocol: "rest",
        rules: [
          {
            allow: {
              method: "GET",
              path: "/v1/*",
              query: { repo: { glob: "NVIDIA/*" }, scope: { any: ["read", "list"] } },
            },
          },
        ],
        denyRules: [{ method: "DELETE", path: "/v1/*", query: { scope: { glob: "admin" } } }],
      },
      {
        port: 443,
        protocol: "rest",
        rules: [
          {
            allow: {
              method: "GET",
              path: "/v1/*",
              query: { repo: "NVIDIA/*", scope: { any: ["read", "list"] } },
            },
          },
        ],
        deny_rules: [{ method: "DELETE", path: "/v1/*", query: { scope: "admin" } }],
      },
    ],
    [
      "JSON-RPC body limit and flat parameters",
      {
        port: 443,
        protocol: "json-rpc",
        jsonRpcMaxBodyBytes: 4096,
        rules: [
          {
            allow: {
              method: "read",
              params: {
                name: { glob: "x" },
                "a.b": { glob: "y" },
              },
            },
          },
        ],
      },
      {
        port: 443,
        protocol: "json-rpc",
        json_rpc: { max_body_bytes: 4096 },
        rules: [{ allow: { method: "read", params: { name: "x", "a.b": "y" } } }],
      },
    ],
    [
      "MCP false options, tool selection, and nested parameters",
      {
        port: 443,
        protocol: "mcp",
        jsonRpcMaxBodyBytes: 4096,
        mcp: { strictToolNames: false, allowAllKnownMcpMethods: false },
        rules: [
          {
            allow: {
              method: "tools/call",
              params: {
                name: { glob: "search" },
                "arguments.repo": { glob: "NVIDIA/*" },
                "arguments.limit": { any: ["1", "2"] },
              },
            },
          },
        ],
      },
      {
        port: 443,
        protocol: "mcp",
        mcp: { max_body_bytes: 4096, strict_tool_names: false, allow_all_known_mcp_methods: false },
        rules: [
          {
            allow: {
              method: "tools/call",
              tool: "search",
              params: { arguments: { repo: "NVIDIA/*", limit: { any: ["1", "2"] } } },
            },
          },
        ],
      },
    ],
    [
      "MCP method profile and denied tools",
      {
        port: 443,
        protocol: "mcp",
        mcp: { strictToolNames: true, allowAllKnownMcpMethods: true },
        rules: [
          { allow: { method: "tools/call", params: { name: { glob: "search" } } } },
          { allow: { method: "*" } },
        ],
        denyRules: [{ method: "tools/call", params: { name: { any: ["delete", "write"] } } }],
      },
      {
        port: 443,
        protocol: "mcp",
        mcp: { strict_tool_names: true, allow_all_known_mcp_methods: true },
        rules: [{ allow: { tool: "search" } }, { allow: {} }],
        deny_rules: [{ tool: { any: ["delete", "write"] } }],
      },
    ],
    [
      "colliding MCP parameter paths",
      {
        port: 443,
        protocol: "mcp",
        rules: [{ allow: { params: { a: { glob: "x" }, "a.b": { glob: "y" } } } }],
      },
      {
        port: 443,
        protocol: "mcp",
        rules: [{ allow: { params: { a: "x", "a.b": "y" } } }],
      },
    ],
  ])(
    "preserves %s through SDK binary and JSON serialization",
    async (_case, endpoint, expected) => {
      const sdkPackage = "@nvidia/openshell-sdk/raw";
      const protobufPackage = "@bufbuild/protobuf";
      const [{ SandboxPolicySchema }, { create, toBinary, fromBinary }] = await Promise.all([
        import(sdkPackage),
        import(protobufPackage),
      ]);
      const input = create(SandboxPolicySchema, {
        version: 1,
        networkPolicies: {
          api: {
            name: "api",
            endpoints: [{ host: "api.example", ...endpoint }],
            binaries: [{ path: "/usr/bin/curl", harness: true }],
          },
        },
      });
      const policy = fromBinary(SandboxPolicySchema, toBinary(SandboxPolicySchema, input));
      expect(YAML.parse(await serializeSdkPolicy(policy))).toEqual({
        version: 1,
        network_policies: {
          api: {
            name: "api",
            endpoints: [{ host: "api.example", ...expected }],
            binaries: [{ path: "/usr/bin/curl" }],
          },
        },
      });
    },
  );
});
