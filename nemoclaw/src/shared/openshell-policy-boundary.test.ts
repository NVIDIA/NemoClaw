// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata,
  parseOpenShellPolicy,
  parseSandboxPolicyMetadata,
  stripProviderComposedPolicies,
  withoutProviderComposedPolicies,
} from "./openshell-policy-boundary.cjs";

describe("OpenShell policy boundary", () => {
  it("parses sandbox policy metadata without assigning an owner", () => {
    expect(
      parseSandboxPolicyMetadata(
        JSON.stringify({
          scope: "sandbox",
          sandbox: "alpha",
          status: "effective",
          policy_source: "sandbox",
          hash: "sha256:one",
          active_version: 3,
          policy: { version: 1, network_policies: { npm: { endpoints: [] } } },
        }),
        "alpha",
      ),
    ).toEqual({
      policySource: "sandbox",
      effectivePolicy: { version: 1, network_policies: { npm: { endpoints: [] } } },
      policyIdentity: { hash: "sha256:one", activeVersion: 3 },
    });
  });

  it("parses active global policy as OpenShell state", () => {
    expect(
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          status: "loaded",
          policy_source: "global",
          hash: "sha256:global",
          active_version: 2,
          policy: { version: 1, network_policies: {} },
        }),
      ),
    ).toEqual({
      state: "active",
      inspection: {
        policySource: "global",
        effectivePolicy: { version: 1, network_policies: {} },
        policyIdentity: { hash: "sha256:global", activeVersion: 2 },
      },
    });
  });

  it("rejects invalid sandbox identity metadata", () => {
    expect(() =>
      parseSandboxPolicyMetadata(
        JSON.stringify({
          scope: "sandbox",
          sandbox: "alpha",
          status: "effective",
          policy_source: "sandbox",
          hash: "invalid hash",
          active_version: 0,
          policy: {},
        }),
        "alpha",
      ),
    ).toThrow(/invalid sandbox policy identity metadata/);
  });

  it.each([
    ["empty global metadata", "", /empty global policy metadata/],
    [
      "invalid global fields",
      JSON.stringify({ scope: "sandbox", status: "loaded", policy_source: "global" }),
      /invalid global policy metadata/,
    ],
    [
      "non-mapping global policy",
      JSON.stringify({
        scope: "global",
        status: "loaded",
        policy_source: "global",
        policy: [],
      }),
      /invalid global policy metadata/,
    ],
  ])("rejects %s", (_name, raw, expected) => {
    expect(() => parseActiveGlobalPolicyMetadata(raw)).toThrow(expected);
  });

  it("allows unrelated live entries but rejects missing or drifted requirements", () => {
    const inspection = {
      policySource: "sandbox" as const,
      policyIdentity: { hash: "sha256:one", activeVersion: 1 },
      effectivePolicy: {
        version: 1,
        network_policies: { npm: { endpoints: ["registry.npmjs.org"] }, host: { endpoints: [] } },
      },
    };
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        network_policies: { npm: { endpoints: ["registry.npmjs.org"] } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        network_policies: { npm: { endpoints: ["different.example"] } },
      }),
    ).toThrow(/drifted entries/);
  });

  it("parses base YAML and removes only provider-composed entries", () => {
    expect(parseOpenShellPolicy("---\nversion: 1\nnetwork_policies: {}\n").policy).toEqual({
      version: 1,
      network_policies: {},
    });
    expect(withoutProviderComposedPolicies({ npm: 1, _provider_token: 2 })).toEqual({ npm: 1 });
  });

  it("filters provider-composed entries from serialized policy only when present", () => {
    const unchanged = "version: 1\nfilesystem_policy:\n  read_only: true\n";
    expect(stripProviderComposedPolicies(unchanged)).toBe(unchanged);

    const withoutProviderEntry = "version: 1\nnetwork_policies:\n  npm: {}\n";
    expect(stripProviderComposedPolicies(withoutProviderEntry)).toBe(withoutProviderEntry);

    expect(
      YAML.parse(
        stripProviderComposedPolicies(
          "version: 1\nnetwork_policies:\n  npm: {}\n  _provider_token: {}\n",
        ),
      ),
    ).toEqual({ version: 1, network_policies: { npm: {} } });
    expect(() => stripProviderComposedPolicies("version: [unterminated")).toThrow(/invalid YAML/);
  });

  it("classifies the OpenShell global history absence contract", () => {
    expect(classifyOpenShellGlobalPolicyHistory("", "No global policy history found\n")).toBe(
      "absent",
    );
  });

  it.each([
    ["marked policy", "Version: 1\n---\nversion: 1\nnetwork_policies:\n  safe: {}", true],
    ["versionless network policy", "network_policies:\n  safe: {}", true],
    ["missing document", "", false],
    ["diagnostic mapping", "error: gateway unavailable", false],
    ["arbitrary mapping", "future_policy:\n  keep: true", false],
    ["malformed YAML", "version: [unterminated", false],
    ["scalar document", "---\nscalar", false],
    ["sequence document", "---\n- item", false],
    ["null network policies", "version: 1\nnetwork_policies: null", false],
    ["string version", 'version: "1"\nnetwork_policies: {}', false],
    ["fractional version", "version: 1.5\nnetwork_policies: {}", false],
  ] as const)("validates $0", (_name, raw, accepted) => {
    let actual = true;
    try {
      parseOpenShellPolicy(raw);
    } catch {
      actual = false;
    }
    expect(actual).toBe(accepted);
  });

  it.each([
    ["active revision", "VERSION STATUS\n1 loaded\n", "", "present"],
    ["fresh history", "", "No global policy history found\n", "absent"],
    ["empty output", "", "", "invalid"],
    ["unexpected diagnostic", "", "gateway warning", "invalid"],
  ] as const)("classifies $0", (_name, stdout, stderr, expected) => {
    expect(classifyOpenShellGlobalPolicyHistory(stdout, stderr)).toBe(expected);
  });

  it("treats a superseded global revision as absent without an identity", () => {
    expect(
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          status: "superseded",
          policy_source: "global",
        }),
      ),
    ).toEqual({ state: "absent" });
  });

  it("requires requested sections while allowing unrelated live policy", () => {
    const inspection = {
      policySource: "global" as const,
      policyIdentity: { activeVersion: 7, hash: "sha256:effective" },
      effectivePolicy: {
        version: 9,
        filesystem_policy: { read_only: true },
        extra_section: { keep: true },
        network_policies: { required: { allow: true }, extra: { allow: true } },
      },
    };
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: true },
        network_policies: { required: { allow: true } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: false },
      }),
    ).toThrow(/drifted sections/);
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        process_policy: { run_as_user: true },
      }),
    ).toThrow(/missing sections/);
  });

  it("accepts OpenShell-enriched policy values while retaining requirements", () => {
    const inspection = {
      policySource: "sandbox" as const,
      policyIdentity: { activeVersion: 8, hash: "sha256:gpu-enriched" },
      effectivePolicy: {
        filesystem_policy: {
          read_only: ["/etc/ssl", "/proc/driver/nvidia"],
          devices: { allow: ["/dev/nvidia0"] },
        },
        network_policies: {
          required: {
            endpoints: [{ host: "example.test", tls: "passthrough" }],
            openshell_metadata: { source: "gpu" },
          },
        },
      },
    };

    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: ["/etc/ssl"] },
        network_policies: { required: { endpoints: [{ host: "example.test" }] } },
      }),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequirementContainment(inspection, {
        filesystem_policy: { read_only: ["/missing"] },
      }),
    ).toThrow(/drifted sections/);
  });

  it.each(["", "{", "[]"])("rejects malformed sandbox metadata [case %#]", (raw) => {
    expect(() => parseSandboxPolicyMetadata(raw, "alpha")).toThrow();
  });
});
