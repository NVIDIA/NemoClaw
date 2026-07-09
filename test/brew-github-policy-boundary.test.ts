// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");
const policies = requireForTest(
  path.join(import.meta.dirname, "..", "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

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
  it("allows GitHub git egress only when the github preset is active (#6502)", () => {
    expect(allowsGitToReachGitHub(resolveEffectivePolicy(["brew"]))).toBe(false);
    expect(allowsGitToReachGitHub(resolveEffectivePolicy(["brew", "github"]))).toBe(true);
  });
});
