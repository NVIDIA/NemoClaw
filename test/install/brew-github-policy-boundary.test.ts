// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const policies = requireForTest(
  path.join(import.meta.dirname, "../..", "src", "lib", "policy", "index.ts"),
) as typeof import("../../src/lib/policy");

interface NetworkPolicyEntry {
  endpoints?: Array<{ host?: string; port?: number }>;
  binaries?: Array<{ path?: string }>;
}

function allowsGitToReachGitHub(policyYaml: string): boolean {
  const parsed = YAML.parse(policyYaml) as {
    network_policies?: Record<string, NetworkPolicyEntry>;
  };

  return Object.values(parsed.network_policies ?? {}).some(
    (entry) =>
      entry.endpoints?.some(
        (endpoint) => endpoint.host === "github.com" && endpoint.port === 443,
      ) && entry.binaries?.some((binary) => binary.path === "/usr/bin/git"),
  );
}

function resolveEffectivePolicy(presetNames: string[]): string {
  let effectivePolicy = "version: 1\nnetwork_policies: {}\n";

  for (const presetName of presetNames) {
    const presetContent = policies.loadPreset(presetName);
    expect(presetContent, `Missing preset: ${presetName}`).not.toBeNull();

    const presetEntries = policies.extractPresetEntries(presetContent!.replaceAll("\r\n", "\n"));
    expect(presetEntries, `Missing policy entries: ${presetName}`).not.toBeNull();

    effectivePolicy = policies.mergePresetIntoPolicy(effectivePolicy, presetEntries!);
  }

  return effectivePolicy;
}

describe("policy preset capability boundaries", () => {
  it("removes the broader grant when replacing brew with brew-balanced (#10380)", () => {
    const broad = resolveEffectivePolicy(["brew", "brew-balanced"]);
    expect(YAML.parse(broad).network_policies.brew.endpoints).toContainEqual({
      host: "raw.githubusercontent.com",
      port: 443,
      access: "full",
    });
    const entries = policies.extractPresetEntries(policies.loadPreset("brew")!);
    const removed = policies.removePresetFromPolicy(broad, entries);
    const narrowed = policies.mergePresetNamesIntoPolicy(removed, ["brew-balanced"]);
    const document = YAML.parse(narrowed.policy);
    expect(document.network_policies.brew).toBeUndefined();
    expect(
      document.network_policies["brew-balanced"].endpoints.find(
        (endpoint: { host: string }) => endpoint.host === "raw.githubusercontent.com",
      ),
    ).toEqual({
      host: "raw.githubusercontent.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/**" } },
        { allow: { method: "HEAD", path: "/**" } },
      ],
    });
  });

  it.each(["brew", "brew-balanced"])(
    "requires the github preset for git egress alongside %s (#6502)",
    (preset) => {
      expect(allowsGitToReachGitHub(resolveEffectivePolicy([preset]))).toBe(false);
      expect(allowsGitToReachGitHub(resolveEffectivePolicy([preset, "github"]))).toBe(true);
    },
  );
});
