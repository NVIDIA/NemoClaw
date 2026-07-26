// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "./openshell-policy-boundary.cjs";

type PolicyDecision = "accepted" | "rejected";

function parseDecision(raw: string): PolicyDecision {
  try {
    parseOpenShellPolicy(raw);
    return "accepted";
  } catch {
    return "rejected";
  }
}

const POLICY_CASES = [
  {
    name: "valid marked policy",
    raw: "Version: 1\n---\nversion: 1\nnetwork_policies:\n  safe: {}",
    decision: "accepted",
  },
  {
    name: "unmarked mapping without a policy root",
    raw: "future_policy:\n  keep: true",
    decision: "rejected",
  },
  {
    name: "versionless network policy",
    raw: "network_policies:\n  safe: {}",
    decision: "accepted",
  },
  { name: "missing document", raw: "", decision: "rejected" },
  {
    name: "diagnostic output",
    raw: "error: gateway unavailable",
    decision: "rejected",
  },
  {
    name: "diagnostic message mapping",
    raw: "message: gateway unavailable\ndetails: connection refused",
    decision: "rejected",
  },
  {
    name: "arbitrary lowercase diagnostic mapping",
    raw: "reason: gateway unavailable\nretryable: true",
    decision: "rejected",
  },
  {
    name: "malformed YAML",
    raw: "version: [unterminated",
    decision: "rejected",
  },
  { name: "scalar document", raw: "---\nscalar", decision: "rejected" },
  {
    name: "sequence document",
    raw: "---\n- item",
    decision: "rejected",
  },
  {
    name: "null network policies",
    raw: "version: 1\nnetwork_policies: null",
    decision: "rejected",
  },
  {
    name: "string version",
    raw: 'version: "1"\nnetwork_policies: {}',
    decision: "rejected",
  },
  {
    name: "fractional version",
    raw: "version: 1.5\nnetwork_policies: {}",
    decision: "rejected",
  },
] as const;

describe("canonical OpenShell policy boundary", () => {
  it("parses marked output and versionless network policies", () => {
    const body = "version: 1\nnetwork_policies:\n  safe: {}";
    expect(parseOpenShellPolicy(`Version: 1\n---\n${body}`)).toEqual({
      yamlBody: body,
      policy: YAML.parse(body),
    });

    const versionless = "network_policies:\n  safe: {}";
    expect(parseOpenShellPolicy(versionless).yamlBody).toBe(versionless);

    const inlineSeparator = 'version: 1\nmetadata:\n  marker: "a---b"\nnetwork_policies: {}';
    expect(parseOpenShellPolicy(inlineSeparator).yamlBody).toBe(inlineSeparator);

    const markedFuturePolicy = "Version: 1\n---\nfuture_policy:\n  keep: true";
    expect(parseOpenShellPolicy(markedFuturePolicy).policy).toEqual({
      future_policy: { keep: true },
    });
  });

  it("rejects missing, diagnostic, malformed, scalar, and unmarked policy output", () => {
    for (const raw of ["", "Version: 1\n---", "error: gateway unavailable"]) {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/does not contain a policy/);
    }
    expect(() => parseOpenShellPolicy("version: [unterminated")).toThrow(/not valid YAML/);
    expect(() => parseOpenShellPolicy("---\nscalar")).toThrow(/must be a YAML mapping/);
    for (const raw of [
      "version: 1\nnetwork_policies: invalid",
      "version: 1\nnetwork_policies: []",
      "version: 1\nnetwork_policies: null",
    ]) {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/network_policies must be a YAML mapping/);
    }
    for (const raw of [
      'version: "1"\nnetwork_policies: {}',
      "version: 1.5\nnetwork_policies: {}",
    ]) {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/version must be a positive integer/);
    }
    expect(() => parseOpenShellPolicy("FutureKey: value")).toThrow(/does not contain a policy/);
  });

  it.each(POLICY_CASES)("returns $decision for $name", ({ raw, decision }) => {
    expect(parseDecision(raw)).toBe(decision);
  });

  it("removes provider-composed policies without mutating other policy fields", () => {
    expect(
      withoutProviderComposedPolicies({ safe: { allow: true }, _provider_generated: {} }),
    ).toEqual({ safe: { allow: true } });

    const policy = YAML.stringify({
      version: 1,
      future_policy: { keep: true },
      network_policies: { safe: {}, _provider_generated: {} },
    });
    expect(YAML.parse(stripProviderComposedPolicies(policy))).toEqual({
      version: 1,
      future_policy: { keep: true },
      network_policies: { safe: {} },
    });
  });

  it("leaves non-composed mappings unchanged and rejects malformed YAML", () => {
    for (const policy of ["version: 1", "version: 1\nnetwork_policies:\n  safe: {}"]) {
      expect(stripProviderComposedPolicies(policy)).toBe(policy);
    }
    expect(() => stripProviderComposedPolicies("version: [unterminated")).toThrow(/invalid YAML/);
  });
});
