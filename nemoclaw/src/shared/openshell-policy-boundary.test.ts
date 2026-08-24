// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  assertExternalPolicyRequirementContainment,
  assertMatchingPolicyAuthority,
  assertPolicyRequirementContainment,
  parseOpenShellPolicy,
  parseSandboxPolicyAuthorityMetadata,
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

describe("sandbox policy authority boundary", () => {
  const policy = { version: 1, network_policies: { required: { allow: true } } };

  it.each([
    ["sandbox", "nemoclaw-managed"],
    ["global", "externally-managed"],
  ] as const)("classifies the %s policy source as %s", (policySource, authority) => {
    expect(
      parseSandboxPolicyAuthorityMetadata(
        JSON.stringify({
          scope: "sandbox",
          sandbox: "alpha",
          status: "effective",
          policy_source: policySource,
          policy,
        }),
        "alpha",
      ),
    ).toEqual({ authority, effectivePolicy: policy });
  });

  it.each([
    ["empty", " \n\t", /empty sandbox policy authority metadata/u],
    ["malformed", "{", /malformed sandbox policy authority metadata/u],
    ["non-object", "[]", /malformed sandbox policy authority metadata/u],
    [
      "mismatched",
      JSON.stringify({
        scope: "sandbox",
        sandbox: "beta",
        status: "effective",
        policy_source: "sandbox",
        policy,
      }),
      /invalid sandbox policy authority metadata/u,
    ],
  ])("rejects %s sandbox authority metadata", (_caseName, raw, expected) => {
    expect(() => parseSandboxPolicyAuthorityMetadata(raw, "alpha")).toThrow(expected);
  });

  it("accepts matching authority and rejects invalid or changed authority", () => {
    expect(() =>
      assertMatchingPolicyAuthority("externally-managed", "externally-managed"),
    ).not.toThrow();
    expect(() => assertMatchingPolicyAuthority(undefined, "externally-managed")).toThrow(
      /recorded policy authority is unavailable/u,
    );
    expect(() => assertMatchingPolicyAuthority("externally-managed", "unknown")).toThrow(
      /observed OpenShell policy authority is unavailable/u,
    );
    expect(() => assertMatchingPolicyAuthority("nemoclaw-managed", "externally-managed")).toThrow(
      /changed from nemoclaw-managed to externally-managed/u,
    );
  });

  it("requires external entries and sections while allowing unrelated content", () => {
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: {
        version: 9,
        filesystem_policy: { read_only: true },
        extra_section: { keep: true },
        network_policies: { required: { allow: true }, extra: { allow: true } },
      },
    };
    expect(() =>
      assertExternalPolicyRequirementContainment(inspection, {
        version: 1,
        filesystem_policy: { read_only: true },
        network_policies: { required: { allow: true } },
      }),
    ).not.toThrow();
    expect(() =>
      assertExternalPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: false },
        process: { user: 1000 },
        network_policies: { required: { allow: false }, missing: {} },
      }),
    ).toThrow(
      /missing entries "missing"; drifted entries "required"; missing sections "process"; drifted sections "filesystem_policy"/u,
    );
    expect(() =>
      assertExternalPolicyRequirementContainment(
        { authority: "unknown" as never, effectivePolicy: {} },
        {},
      ),
    ).toThrow(/observed OpenShell policy authority is invalid/u);
    expect(() =>
      assertExternalPolicyRequirementContainment(inspection, {
        network_policies: [] as never,
      }),
    ).toThrow(/required network policy input is invalid/u);
  });

  it("requires recorded entries in a NemoClaw-managed policy", () => {
    const inspection = {
      authority: "nemoclaw-managed" as const,
      effectivePolicy: { network_policies: { required: { allow: true } } },
    };
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        network_policies: { required: { allow: true } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        network_policies: { missing: { allow: true } },
      }),
    ).toThrow(/missing entries "missing"/u);
  });
});

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

  it.each(["", "Version: 1\n---", "error: gateway unavailable"])(
    "rejects output without a policy: %j",
    (raw) => {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/does not contain a policy/);
    },
  );

  it("rejects malformed and scalar policy output", () => {
    expect(() => parseOpenShellPolicy("version: [unterminated")).toThrow(/not valid YAML/);
    expect(() => parseOpenShellPolicy("---\nscalar")).toThrow(/must be a YAML mapping/);
  });

  it.each([
    "version: 1\nnetwork_policies: invalid",
    "version: 1\nnetwork_policies: []",
    "version: 1\nnetwork_policies: null",
  ])("rejects a non-mapping network_policies value: %j", (raw) => {
    expect(() => parseOpenShellPolicy(raw)).toThrow(/network_policies must be a YAML mapping/);
  });

  it.each(['version: "1"\nnetwork_policies: {}', "version: 1.5\nnetwork_policies: {}"])(
    "rejects a non-integer policy version: %j",
    (raw) => {
      expect(() => parseOpenShellPolicy(raw)).toThrow(/version must be a positive integer/);
    },
  );

  it("rejects unmarked future output", () => {
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

  it.each(["version: 1", "version: 1\nnetwork_policies:\n  safe: {}"])(
    "leaves the non-composed mapping %j unchanged",
    (policy) => {
      expect(stripProviderComposedPolicies(policy)).toBe(policy);
    },
  );

  it("rejects malformed YAML while stripping composed policies", () => {
    expect(() => stripProviderComposedPolicies("version: [unterminated")).toThrow(/invalid YAML/);
  });
});
