// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  digestBaselineEntry,
  getBaselineEntry,
  listBaselineEntryKeys,
  mergeBaselineEntryIntoPolicy,
  removeBaselineEntryFromPolicy,
  renderBaselineEntryScope,
} from "./baseline-exclusion";

const BASE_POLICY = `version: 1
network_policies:
  nous_research:
    name: nous_research
    endpoints:
      - host: nousresearch.com
        port: 443
        protocol: rest
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
    binaries:
      - { path: /usr/local/bin/hermes }
  managed_inference:
    name: managed_inference
    endpoints:
      - host: inference.local
        port: 443
        protocol: rest
        rules:
          - allow: { method: POST, path: "/v1/**" }
`;

describe("baseline-exclusion digest (#7178)", () => {
  it("is stable across key ordering and whitespace", () => {
    const entry = getBaselineEntry(BASE_POLICY, "nous_research");
    expect(entry).not.toBeNull();
    const reordered = YAML.parse(
      YAML.stringify({
        binaries: entry!.binaries,
        endpoints: entry!.endpoints,
        name: entry!.name,
      }),
    );
    expect(digestBaselineEntry(reordered)).toBe(digestBaselineEntry(entry!));
  });

  it("changes when the entry content changes", () => {
    const entry = getBaselineEntry(BASE_POLICY, "nous_research");
    expect(entry).not.toBeNull();
    const widened = YAML.parse(YAML.stringify(entry!));
    (widened.endpoints as { host: string }[]).push({ host: "evil.example" });
    expect(digestBaselineEntry(widened)).not.toBe(digestBaselineEntry(entry!));
  });
});

describe("baseline-exclusion enumeration (#7178)", () => {
  it("lists every baseline key", () => {
    expect(listBaselineEntryKeys(BASE_POLICY)).toEqual(["nous_research", "managed_inference"]);
  });

  it("returns null for an absent key", () => {
    expect(getBaselineEntry(BASE_POLICY, "absent")).toBeNull();
  });

  it("does not treat inherited object properties as baseline keys", () => {
    expect(getBaselineEntry(BASE_POLICY, "__proto__")).toBeNull();
  });
});

describe("baseline-exclusion scope render (#7178)", () => {
  it("previews host, method/path rules, and binaries", () => {
    const entry = getBaselineEntry(BASE_POLICY, "nous_research");
    expect(entry).not.toBeNull();
    const lines = renderBaselineEntryScope("nous_research", entry!).join("\n");
    expect(lines).toContain("nous_research");
    expect(lines).toContain("nousresearch.com:443");
    expect(lines).toContain("GET /**");
    expect(lines).toContain("POST /**");
    expect(lines).toContain("/usr/local/bin/hermes");
  });
});

describe("baseline-exclusion policy edits (#7178)", () => {
  it("removes a baseline entry by exact key", () => {
    const { policy, removed } = removeBaselineEntryFromPolicy(BASE_POLICY, "nous_research");
    expect(removed).toBe(true);
    const keys = Object.keys(YAML.parse(policy).network_policies);
    expect(keys).toEqual(["managed_inference"]);
  });

  it("is a no-op for an absent key", () => {
    const { policy, removed } = removeBaselineEntryFromPolicy(BASE_POLICY, "absent");
    expect(removed).toBe(false);
    expect(policy).toBe(BASE_POLICY);
  });

  it("merges a baseline entry back under its key", () => {
    const entry = getBaselineEntry(BASE_POLICY, "nous_research");
    expect(entry).not.toBeNull();
    const { policy: removedPolicy } = removeBaselineEntryFromPolicy(BASE_POLICY, "nous_research");
    const restored = mergeBaselineEntryIntoPolicy(removedPolicy, "nous_research", entry!);
    expect(Object.keys(YAML.parse(restored).network_policies).sort()).toEqual([
      "managed_inference",
      "nous_research",
    ]);
  });
});
