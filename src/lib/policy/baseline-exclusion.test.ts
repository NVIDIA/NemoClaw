// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  applyBaselineExclusions,
  BaselineExclusionDriftError,
  BaselineExclusionSourceError,
  digestBaselineEntry,
  evaluateBaselineExclusionRuntimeStatus,
  getBaselineEntry,
  listBaselineEntryKeys,
  mergeBaselineEntryIntoPolicy,
  ProtectedBaselineExclusionError,
  removeBaselineEntryFromPolicy,
  renderBaselineEntryScope,
  resolveBaselineExclusion,
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

function digestOf(key: string, policy = BASE_POLICY): string {
  const entry = getBaselineEntry(policy, key);
  expect(entry).not.toBeNull();
  return digestBaselineEntry(entry!);
}

function exclusion(key: string, digest: string) {
  return { version: 1 as const, agent: "hermes", key, digest };
}

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

describe("baseline-exclusion drift resolution (#7178)", () => {
  it("reports no drift when the digest matches", () => {
    const resolution = resolveBaselineExclusion(BASE_POLICY, {
      version: 1,
      agent: "hermes",
      key: "nous_research",
      digest: digestOf("nous_research"),
    });
    expect(resolution.drift).toBeNull();
    expect(resolution.entry).not.toBeNull();
  });

  it("reports 'changed' when the entry content no longer matches", () => {
    const resolution = resolveBaselineExclusion(BASE_POLICY, {
      version: 1,
      agent: "hermes",
      key: "nous_research",
      digest: "stale-digest",
    });
    expect(resolution.drift).toBe("changed");
  });

  it("reports 'missing' when the release dropped the entry", () => {
    const resolution = resolveBaselineExclusion(BASE_POLICY, {
      version: 1,
      agent: "hermes",
      key: "absent",
      digest: "any",
    });
    expect(resolution.drift).toBe("missing");
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

describe("applyBaselineExclusions fail-closed (#7178)", () => {
  it("drops matching entries and reports the excluded keys", () => {
    const { content, excludedKeys } = applyBaselineExclusions(
      BASE_POLICY,
      [exclusion("nous_research", digestOf("nous_research"))],
      "hermes",
    );
    expect(excludedKeys).toEqual(["nous_research"]);
    expect(Object.keys(YAML.parse(content).network_policies)).toEqual(["managed_inference"]);
  });

  it("throws on changed content instead of replaying a stale approval", () => {
    expect(() =>
      applyBaselineExclusions(BASE_POLICY, [exclusion("nous_research", "stale")], "hermes"),
    ).toThrowError(BaselineExclusionDriftError);
  });

  it("throws when the release removed the entry", () => {
    let error: unknown;
    try {
      applyBaselineExclusions(BASE_POLICY, [exclusion("absent", "any")], "hermes");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BaselineExclusionDriftError);
    expect((error as BaselineExclusionDriftError).reason).toBe("missing");
    expect((error as Error).message).toContain("Clear it with 'policy restore'.");
    expect((error as Error).message).not.toContain("re-exclude");
  });

  it("rejects protected entries even when imported state has a matching digest", () => {
    expect(() =>
      applyBaselineExclusions(
        BASE_POLICY,
        [exclusion("managed_inference", digestOf("managed_inference"))],
        "hermes",
      ),
    ).toThrowError(ProtectedBaselineExclusionError);
  });

  it("rejects an approval recorded for a different agent baseline (#7194)", () => {
    expect(() =>
      applyBaselineExclusions(
        BASE_POLICY,
        [exclusion("nous_research", digestOf("nous_research"))],
        "openclaw",
      ),
    ).toThrowError(BaselineExclusionSourceError);
  });
});

describe("baseline exclusion runtime verification (#7194)", () => {
  const recorded = exclusion("nous_research", "digest");

  it("reports excluded only when the matching baseline key is absent live", () => {
    expect(evaluateBaselineExclusionRuntimeStatus(recorded, "hermes", "digest", null)).toBe(
      "excluded",
    );
  });

  it("reports a live mismatch when any value remains under the excluded key", () => {
    expect(evaluateBaselineExclusionRuntimeStatus(recorded, "hermes", "digest", "other")).toBe(
      "live-policy-mismatch",
    );
  });

  it("checks the approved agent before baseline and live digests", () => {
    expect(evaluateBaselineExclusionRuntimeStatus(recorded, "openclaw", undefined, undefined)).toBe(
      "agent-changed",
    );
  });
});
