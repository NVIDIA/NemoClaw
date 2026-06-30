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

vi.mock("./ssrf.js", () => ({
  validateEndpointUrl: vi.fn(async (url: string) => ({ url, pinnedUrl: url })),
}));

const { actionApply } = await import("./runner.js");

const BASE_POLICY = `version: 1
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
              tool: { any: [search_web, list_tools] }
        deny_rules:
          - tool: { any: [send_email, delete_resource] }
  existing_json_rpc:
    endpoints:
      - host: rpc.example.com
        port: 443
        path: /rpc
        protocol: json-rpc
        enforcement: enforce
        json_rpc: { max_body_bytes: 131072 }
        rules:
          - allow: { method: reports.search }
`;

const FULL_POLICY = `${BASE_POLICY}  _provider_nvidia-inference: {}
`;

function policyOutput(policy: string): string {
  return ["Version: 1", "Hash: sha256:test", "---", policy].join("\n");
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

  it("preserves MCP and JSON-RPC fields without round-tripping provider entries", async () => {
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

    const mergedPolicyKey = [...store.keys()].find((key) => key.endsWith("/merged-policy.yaml"));
    expect(mergedPolicyKey).toBeDefined();
    const mergedPolicy = YAML.parse(store.get(mergedPolicyKey ?? "")?.content ?? "");
    expect(mergedPolicy.network_policies).toEqual({
      ...YAML.parse(BASE_POLICY).network_policies,
      nim_service: expect.any(Object),
    });
    expect(mergedPolicy.network_policies).not.toHaveProperty("_provider_nvidia-inference");
  });
});
