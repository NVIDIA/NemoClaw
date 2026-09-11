// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
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
  it.skipIf(!hasSdkArtifact()).each(["brave"] as const)(
    "qualifies the checked-in %s profile through generated SDK responses (#10904)",
    async (profileId) => {
      const sdkPackage = "@nvidia/openshell-sdk/raw";
      const protobufPackage = "@bufbuild/protobuf";
      const [raw, { create, fromJson, toBinary, fromBinary }] = await Promise.all([
        import(sdkPackage),
        import(protobufPackage),
      ]);
      const checkedIn = YAML.parse(
        readFileSync(
          new URL(`../../nemoclaw-blueprint/provider-profiles/${profileId}.yaml`, import.meta.url),
          "utf8",
        ),
      );
      const profile = fromJson(raw.ProviderProfileSchema, {
        id: checkedIn.id,
        source: "user",
        scope: "workspace",
        resourceVersion: "4",
        credentials: checkedIn.credentials,
        endpoints: checkedIn.endpoints,
        binaries: checkedIn.binaries.map((path: string) => ({ path })),
        inference_capable: checkedIn.inference_capable,
      });
      const roundTrip = (schema: unknown, input: unknown) =>
        fromBinary(schema, toBinary(schema, create(schema, input)));
      const client: OpenShellReadClient = {
        raw: {
          getProvider: async () =>
            roundTrip(raw.OpenShell.method.getProvider.output, {
              provider: {
                metadata: {
                  id: "provider-id",
                  name: "alpha",
                  workspace: "default",
                  resourceVersion: 9n,
                },
                type: profileId,
                profileWorkspace: "default",
              },
            }),
          getProviderProfile: async () =>
            roundTrip(raw.OpenShell.method.getProviderProfile.output, { profile }),
          getSandbox: async () => {
            throw new Error("unexpected sandbox read");
          },
          getSandboxConfig: async () => {
            throw new Error("unexpected config read");
          },
        },
      };
      const result = await createProviders(async () => client).get({
        target: { kind: "named", gatewayName: "nemoclaw" },
        workspace: "default",
        name: "alpha",
        configKeys: [],
        profileContract: profileId,
        signal: new AbortController().signal,
      });
      expect(result?.managedProfile).toEqual({
        id: profileId,
        source: "user",
        scope: "workspace",
        resourceVersion: "4",
      });
      expect(result?.profileWorkspace).toBe("default");
    },
  );

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

  it("rejects an oversized encoded policy before YAML serialization", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const policy = create(SandboxPolicySchema, {
      version: 1,
      filesystem: { readOnly: ["/" + "界".repeat(350000)] },
    });
    const stringify = vi.spyOn(YAML, "stringify");
    try {
      await expect(serializeSdkPolicy(policy)).rejects.toMatchObject({ kind: "schema" });
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("rejects an aborted policy read before loading the SDK", async () => {
    await expect(serializeSdkPolicy(undefined, AbortSignal.abort())).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("stops conversion when the read aborts during SDK loading", async () => {
    const controller = new AbortController();
    const stringify = vi.spyOn(YAML, "stringify");
    try {
      const result = serializeSdkPolicy(undefined, controller.signal);
      controller.abort();
      await expect(result).rejects.toMatchObject({ kind: "timeout" });
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("rejects deep MCP paths within a bounded heap", () => {
    const source = `
      (async () => {
        const [{ create }, { SandboxPolicySchema }] = await Promise.all([
          import("@bufbuild/protobuf"), import("@nvidia/openshell-sdk/raw"),
        ]);
        const { serializeSdkPolicy } = require("./src/lib/adapters/openshell/sandbox-config.ts");
        const params = { ["a.".repeat(16000) + "leaf"]: { glob: "safe" } };
        const policy = create(SandboxPolicySchema, {
          version: 1,
          networkPolicies: { api: {
            name: "api", endpoints: [{ host: "api.example", port: 443, protocol: "mcp", rules: [{ allow: { params } }] }],
          } },
        });
        await serializeSdkPolicy(policy).then(
          () => process.exit(2),
          (error) => { process.stdout.write(error.kind); process.exit(error.kind === "schema" ? 0 : 2); },
        );
      })();
    `;
    const result = spawnSync(
      "bash",
      [
        "-c",
        'ulimit -c 0; exec "$@"',
        "bounded-policy",
        process.execPath,
        "--max-old-space-size=256",
        "--import",
        "tsx",
        "--eval",
        source,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("schema");
  });

  it("rejects YAML expansion beyond the policy read limit", async () => {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { create, toBinary }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    const policy = create(SandboxPolicySchema, {
      version: 1,
      filesystem: { readOnly: ["/" + "\x01".repeat(300000)] },
    });
    expect(toBinary(SandboxPolicySchema, policy).byteLength).toBeLessThan(1024 * 1024);
    const outcome = await serializeSdkPolicy(policy).then(
      () => "accepted",
      (error) => error.kind,
    );
    expect(outcome).toBe("schema");
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
    const error = await serializeSdkPolicy(policy).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      kind: "schema",
      message: "OpenShell read failed (schema).",
    });
    expect(inspect(error, { depth: null })).not.toContain("credential-canary");
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
      const reader = createSandboxConfig(async () => ({
        raw: {
          getProvider: async () => undefined,
          getProviderProfile: async () => undefined,
          getSandbox: async () => undefined,
          getSandboxConfig: async () => ({
            policy,
            workspace: "default",
            version: 3,
            policyHash: "a".repeat(64),
            policySource: 1,
            configRevision: 3n,
            providerEnvRevision: 1n,
            globalPolicyVersion: 0,
          }),
        },
      }));
      const config = await reader.get({
        sandboxId: "verified-id",
        target: { kind: "named", gatewayName: "nemoclaw" },
        workspace: "default",
        signal: new AbortController().signal,
      });
      expect(YAML.parse(config.policy.document)).toEqual({
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
