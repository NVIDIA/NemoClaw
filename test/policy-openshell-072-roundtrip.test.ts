// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const policies = requireForTest(
  path.join(import.meta.dirname, "..", "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

const EXISTING_POLICY = {
  version: 1,
  future_policy: {
    opaque_setting: { keep: true },
  },
  filesystem_policy: {
    default: "deny",
    roots: ["/sandbox"],
  },
  metadata: {
    future_schema: "opaque",
    preserve: true,
  },
  network_policies: {
    mcp_server: {
      endpoints: [
        {
          host: "mcp.example.com",
          port: 443,
          path: "/mcp",
          protocol: "mcp",
          enforcement: "enforce",
          mcp: {
            allow_all_known_mcp_methods: true,
            max_body_bytes: 131072,
            strict_tool_names: true,
          },
          rules: [{ allow: { tool: { any: ["search_web", "list_tools"] } } }],
          deny_rules: [{ tool: { any: ["send_email", "delete_resource"] } }],
        },
      ],
    },
    json_rpc_server: {
      endpoints: [
        {
          host: "rpc.example.com",
          port: 443,
          path: "/rpc",
          protocol: "json-rpc",
          enforcement: "enforce",
          json_rpc: { max_body_bytes: 131072 },
          rules: [{ allow: { method: "reports.search" } }],
        },
      ],
    },
  },
};

const PRESET_ENTRIES = YAML.stringify({
  pypi_access: {
    name: "pypi_access",
    endpoints: [{ host: "pypi.org", port: 443, access: "full" }],
  },
}).replace(/^/gm, "  ");

const CUSTOM_PRESET_ENTRIES = YAML.stringify({
  custom_registry: {
    name: "custom_registry",
    endpoints: [{ host: "registry.example.com", port: 443, access: "read-only" }],
  },
}).replace(/^/gm, "  ");

describe("OpenShell 0.0.72 policy round-trip compatibility", () => {
  it("preserves MCP and JSON-RPC fields while merging a preset", () => {
    const merged = YAML.parse(
      policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), PRESET_ENTRIES),
    );

    expect(merged.network_policies).toEqual({
      ...EXISTING_POLICY.network_policies,
      pypi_access: expect.any(Object),
    });
    expect(merged.future_policy).toEqual(EXISTING_POLICY.future_policy);
    expect(merged.filesystem_policy).toEqual(EXISTING_POLICY.filesystem_policy);
    expect(merged.metadata).toEqual(EXISTING_POLICY.metadata);
  });

  it("preserves protocol fields across multiple built-in and custom-shaped merges", () => {
    const first = policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), PRESET_ENTRIES);
    const merged = YAML.parse(policies.mergePresetIntoPolicy(first, CUSTOM_PRESET_ENTRIES));

    expect(merged.network_policies).toEqual({
      ...EXISTING_POLICY.network_policies,
      pypi_access: expect.any(Object),
      custom_registry: expect.any(Object),
    });
  });

  it.each([
    ["unterminated YAML", "  malformed: [unterminated"],
    ["an array", "  - host: example.com"],
    ["a scalar policy value", "  key: scalar"],
    ["an empty mapping", "  {}"],
    ["non-mapping content", "  not yaml at all"],
  ])("rejects preset entries containing %s", (_shape, presetEntries) => {
    expect(() =>
      policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), presetEntries),
    ).toThrow(/preset network_policies entries must be a valid YAML mapping/);
  });

  it("preserves MCP and JSON-RPC fields when removing a merged preset", () => {
    const merged = policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), PRESET_ENTRIES);
    const removed = YAML.parse(policies.removePresetFromPolicy(merged, PRESET_ENTRIES));

    expect(removed.network_policies).toEqual(EXISTING_POLICY.network_policies);
    expect(removed.future_policy).toEqual(EXISTING_POLICY.future_policy);
    expect(removed.filesystem_policy).toEqual(EXISTING_POLICY.filesystem_policy);
    expect(removed.metadata).toEqual(EXISTING_POLICY.metadata);
  });

  it("drops provider-composed entries from merge and removal mutation payloads", () => {
    const taintedPolicy = {
      ...EXISTING_POLICY,
      network_policies: {
        ...EXISTING_POLICY.network_policies,
        _provider_unexpected: { name: "must-not-round-trip" },
      },
    };
    const merged = policies.mergePresetIntoPolicy(YAML.stringify(taintedPolicy), PRESET_ENTRIES);
    const removed = YAML.parse(policies.removePresetFromPolicy(merged, PRESET_ENTRIES));

    expect(YAML.parse(merged).network_policies).not.toHaveProperty("_provider_unexpected");
    expect(removed.network_policies).toEqual(EXISTING_POLICY.network_policies);
  });

  it("does not let custom preset input author reserved provider-composed entries", () => {
    const reservedEntries = YAML.stringify({
      _provider_injected: { name: "must-not-submit" },
    }).replace(/^/gm, "  ");
    const merged = YAML.parse(
      policies.mergePresetIntoPolicy(YAML.stringify(EXISTING_POLICY), reservedEntries),
    );

    expect(merged.network_policies).toEqual(EXISTING_POLICY.network_policies);
  });

  it("rejects custom preset files that author reserved provider-composed entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-preset-"));
    const presetPath = path.join(tempDir, "reserved.yaml");
    try {
      fs.writeFileSync(
        presetPath,
        YAML.stringify({
          preset: { name: "reserved-entry" },
          network_policies: { _provider_injected: { name: "must-not-load" } },
        }),
      );

      expect(policies.loadPresetFromFile(presetPath)).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects custom preset names reserved for provider-composed entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-preset-name-"));
    const presetPath = path.join(tempDir, "reserved-name.yaml");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      fs.writeFileSync(
        presetPath,
        YAML.stringify({
          preset: { name: "_provider_injected" },
          network_policies: { safe_entry: { name: "safe-entry" } },
        }),
      );

      expect(policies.loadPresetFromFile(presetPath)).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Preset name cannot start with '_provider_'"),
      );
    } finally {
      consoleError.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a legacy network_policies array instead of replacing its entries", () => {
    const legacy = YAML.stringify({
      version: 1,
      network_policies: [{ host: "legacy.example.com", access: "full" }],
    });

    expect(() => policies.mergePresetIntoPolicy(legacy, PRESET_ENTRIES)).toThrow(
      /current policy is not a valid YAML mapping/i,
    );
  });
});
