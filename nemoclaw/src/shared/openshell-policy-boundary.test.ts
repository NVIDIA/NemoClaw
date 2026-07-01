// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  parseOpenShellPolicy,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "./openshell-policy-boundary.cjs";

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
    expect(() =>
      parseOpenShellPolicy("FutureKey: value", { allowUnmarkedPolicyBody: true }),
    ).toThrow(/does not contain a policy/);
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
