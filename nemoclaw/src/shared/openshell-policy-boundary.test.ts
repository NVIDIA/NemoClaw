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

function parseDecision(raw: string, allowUnmarkedPolicyBody: boolean): PolicyDecision {
  try {
    parseOpenShellPolicy(raw, { allowUnmarkedPolicyBody });
    return "accepted";
  } catch {
    return "rejected";
  }
}

const CROSS_MODE_CASES = [
  {
    name: "valid marked policy",
    raw: "Version: 1\n---\nversion: 1\nnetwork_policies:\n  safe: {}",
    strict: "accepted",
    legacy: "accepted",
  },
  {
    name: "documented versionless mapping exception",
    raw: "future_policy:\n  keep: true",
    strict: "rejected",
    legacy: "accepted",
  },
  { name: "missing document", raw: "", strict: "rejected", legacy: "rejected" },
  {
    name: "diagnostic output",
    raw: "error: gateway unavailable",
    strict: "rejected",
    legacy: "rejected",
  },
  {
    name: "malformed YAML",
    raw: "version: [unterminated",
    strict: "rejected",
    legacy: "rejected",
  },
  { name: "scalar document", raw: "---\nscalar", strict: "rejected", legacy: "rejected" },
  {
    name: "sequence document",
    raw: "---\n- item",
    strict: "rejected",
    legacy: "rejected",
  },
  {
    name: "null network policies",
    raw: "version: 1\nnetwork_policies: null",
    strict: "rejected",
    legacy: "rejected",
  },
  {
    name: "string version",
    raw: 'version: "1"\nnetwork_policies: {}',
    strict: "rejected",
    legacy: "rejected",
  },
  {
    name: "fractional version",
    raw: "version: 1.5\nnetwork_policies: {}",
    strict: "rejected",
    legacy: "rejected",
  },
] as const;

describe("canonical OpenShell policy boundary", () => {
  it("parses metadata output and supports the CLI's versionless compatibility mode", () => {
    const body = "version: 1\nnetwork_policies:\n  safe: {}";
    expect(parseOpenShellPolicy(`Version: 1\n---\n${body}`)).toEqual({
      yamlBody: body,
      policy: YAML.parse(body),
    });

    const versionless = "future_policy:\n  keep: true";
    expect(() => parseOpenShellPolicy(versionless)).toThrow(/does not contain a policy/);
    expect(parseOpenShellPolicy(versionless, { allowUnmarkedPolicyBody: true }).yamlBody).toBe(
      versionless,
    );

    const inlineSeparator = 'version: 1\nmetadata:\n  marker: "a---b"\nnetwork_policies: {}';
    expect(parseOpenShellPolicy(inlineSeparator, { allowUnmarkedPolicyBody: true }).yamlBody).toBe(
      inlineSeparator,
    );
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
    expect(() =>
      parseOpenShellPolicy("FutureKey: value", { allowUnmarkedPolicyBody: true }),
    ).toThrow(/does not contain a policy/);
  });

  it.each(CROSS_MODE_CASES)("keeps cross-mode parity for $name", ({ raw, strict, legacy }) => {
    expect(parseDecision(raw, false)).toBe(strict);
    expect(parseDecision(raw, true)).toBe(legacy);
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
