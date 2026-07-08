// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

type FsEntry = { type: "file" | "dir"; content?: string };

const store = new Map<string, FsEntry>();
const mockExeca = vi.fn();

vi.mock("node:crypto", () => ({
  randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));

vi.mock("node:os", () => ({
  homedir: () => "/fakehome",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    mkdirSync: vi.fn((path: string) => {
      store.set(path, { type: "dir" });
    }),
    writeFileSync: vi.fn((path: string, data: string) => {
      store.set(path, { type: "file", content: String(data) });
    }),
  };
});

vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => ({
      url,
      pinnedUrl: url,
      protocol: url.startsWith("http:") ? "http:" : "https:",
      hostname: new URL(url).hostname,
      dnsResolved: false,
    })),
  };
});

const { actionApply } = await import("./runner.js");

const BASE_POLICY = `version: 1
future_policy:
  opaque_setting:
    keep: true
filesystem_policy:
  default: deny
  roots: [/sandbox]
metadata:
  future_schema: opaque
  preserve: true
network_policies:
  existing_mcp:
    endpoints:
      - host: mcp.example.com
        port: 443
        path: /mcp
        protocol: mcp
        enforcement: enforce
        mcp:
          allow_all_known_mcp_methods: true
          max_body_bytes: 131072
          strict_tool_names: true
        rules:
          - allow:
              method: tools/call
              tool:
                any: [search_web, list_tools]
          - allow:
              method: resources/read
        deny_rules:
          - method: tools/call
            tool:
              any: [send_email, delete_resource]
  existing_json_rpc:
    endpoints:
      - host: rpc.example.com
        port: 443
        path: /rpc
        protocol: json-rpc
        enforcement: enforce
        json_rpc: { max_body_bytes: 131072 }
        rules:
          - allow:
              method: { any: [reports.search, reports.get] }
`;

const FULL_POLICY = `${BASE_POLICY}  _provider_nvidia-inference: {}
`;

function policyOutput(policy: string): string {
  return ["Version: 1", "Hash: sha256:test", "---", policy].join("\n");
}

function policySetCalls(): unknown[][] {
  return mockExeca.mock.calls.filter(
    (call) => Array.isArray(call[1]) && call[1][0] === "policy" && call[1][1] === "set",
  );
}

function mergedPolicy(): Record<string, unknown> {
  const key = [...store.keys()].find((candidate) => candidate.endsWith("/merged-policy.yaml"));
  expect(key).toBeDefined();
  return YAML.parse(store.get(key ?? "")?.content ?? "");
}

function blueprint(): Parameters<typeof actionApply>[1] {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: {
        additions: {
          nim_service: {
            name: "nim_service",
            endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
          },
        },
      },
    },
  };
}

describe("OpenShell 0.0.72 blueprint policy round-trip", () => {
  beforeEach(() => {
    store.clear();
    mockExeca.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const policyByCommand = new Map([
      ["policy get --base test-sandbox", policyOutput(BASE_POLICY)],
      ["policy get --full test-sandbox", policyOutput(FULL_POLICY)],
    ]);
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout: policyByCommand.get(args.slice(0, 4).join(" ")) ?? "",
      stderr: "",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves MCP, JSON-RPC, and unknown mapping sections without provider entries", async () => {
    await actionApply("default", blueprint());

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "--base", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["policy", "get", "--full", "test-sandbox"],
      expect.anything(),
    );

    const merged = mergedPolicy() as {
      future_policy: { opaque_setting: { keep: boolean } };
      filesystem_policy: { default: string; roots: string[] };
      metadata: { future_schema: string; preserve: boolean };
      network_policies: Record<string, unknown>;
    };
    expect(merged.future_policy).toEqual({ opaque_setting: { keep: true } });
    expect(merged.filesystem_policy).toEqual({ default: "deny", roots: ["/sandbox"] });
    expect(merged.metadata).toEqual({ future_schema: "opaque", preserve: true });
    expect(merged.network_policies).toEqual({
      ...YAML.parse(BASE_POLICY).network_policies,
      nim_service: expect.any(Object),
    });
    expect(merged.network_policies).not.toHaveProperty("_provider_nvidia-inference");
  });

  it.each([
    ["scalar", "future_mode", "future_mode: strict\n"],
    ["sequence", "future_features", "future_features: [audit, attribution]\n"],
  ])("fails closed for an unknown top-level %s", async (_shape, key, fragment) => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout:
        args.slice(0, 4).join(" ") === "policy get --base test-sandbox"
          ? policyOutput(`${fragment}${BASE_POLICY}`)
          : "",
      stderr: "",
    }));

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      `Current policy top-level field "${key}" must be a YAML mapping`,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("fails closed when policy get --base fails", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) =>
      args.slice(0, 4).join(" ") === "policy get --base test-sandbox"
        ? { exitCode: 1, stdout: "", stderr: "gateway unavailable" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /Failed to read current policy.*gateway unavailable/,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("fails closed when policy get --base returns metadata without a policy document", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout:
        args.slice(0, 4).join(" ") === "policy get --base test-sandbox"
          ? "Version: 1\nHash: sha256:test\n"
          : "",
      stderr: "",
    }));

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /does not contain a policy YAML document/,
    );
    expect(policySetCalls()).toEqual([]);
  });

  it("filters a malformed provider-composed entry returned by --base", async () => {
    const malformedBase = YAML.parse(BASE_POLICY);
    malformedBase.network_policies["_provider_unexpected"] = {
      endpoints: [{ host: "provider.invalid", port: 443, access: "full" }],
    };
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout:
        args.slice(0, 4).join(" ") === "policy get --base test-sandbox"
          ? policyOutput(YAML.stringify(malformedBase))
          : "",
      stderr: "",
    }));

    await actionApply("default", blueprint());
    const merged = mergedPolicy() as { network_policies: Record<string, unknown> };
    expect(merged.network_policies).not.toHaveProperty("_provider_unexpected");
    expect(merged.network_policies).toHaveProperty("existing_mcp");
    expect(merged.network_policies).toHaveProperty("existing_json_rpc");
  });

  it("filters reserved provider entries from the final blueprint mutation payload", async () => {
    const blueprintWithReservedAddition = blueprint();
    blueprintWithReservedAddition.components!.policy!.additions!._provider_injected = {
      name: "must-not-submit",
      endpoints: [{ host: "provider.invalid", port: 443, access: "full" }],
    };

    await actionApply("default", blueprintWithReservedAddition);

    const merged = mergedPolicy() as { network_policies: Record<string, unknown> };
    expect(merged.network_policies).not.toHaveProperty("_provider_injected");
    expect(merged.network_policies).toHaveProperty("nim_service");
  });

  it("fails closed for a legacy network_policies array instead of dropping it", async () => {
    mockExeca.mockImplementation(async (_cmd: string, args: string[]) => ({
      exitCode: 0,
      stdout:
        args.slice(0, 4).join(" ") === "policy get --base test-sandbox"
          ? policyOutput("version: 1\nnetwork_policies:\n  - name: legacy\n")
          : "",
      stderr: "",
    }));

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /network_policies must be a YAML mapping/,
    );
    expect(policySetCalls()).toEqual([]);
  });
});
