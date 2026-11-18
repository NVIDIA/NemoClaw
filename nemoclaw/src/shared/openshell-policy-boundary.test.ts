// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  assertOpenShellPolicyEndpointPins,
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  openShellHostMatches,
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
          hash: "sha256:global",
          version: 2,
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
    expect(
      classifyOpenShellGlobalPolicyHistory(
        JSON.stringify({ revisions: [], next_page_token: "" }),
        "",
      ),
    ).toBe("absent");
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
    ["loaded", "loaded"],
    ["deleted", "superseded"],
  ])("classifies a %s global revision as present history", (_label, status) => {
    expect(
      classifyOpenShellGlobalPolicyHistory(
        JSON.stringify({
          revisions: [{ scope: "global", version: 2, hash: "sha256:global", status }],
          next_page_token: "older-revision",
        }),
        "",
      ),
    ).toBe("present");
  });

  it.each([
    ["fresh history", { revisions: [], next_page_token: "" }, "", "absent"],
    ["empty page with continuation", { revisions: [], next_page_token: "more" }, "", "invalid"],
    ["missing continuation", { revisions: [] }, "", "invalid"],
    ["wrong collection", { revisions: {}, next_page_token: "" }, "", "invalid"],
    [
      "sandbox history",
      {
        revisions: [{ scope: "sandbox", version: 1, hash: "one", status: "loaded" }],
        next_page_token: "",
      },
      "",
      "invalid",
    ],
    [
      "invalid revision",
      {
        revisions: [{ scope: "global", version: 0, hash: "one", status: "loaded" }],
        next_page_token: "",
      },
      "",
      "invalid",
    ],
    [
      "unknown status",
      {
        revisions: [{ scope: "global", version: 1, hash: "one", status: "future" }],
        next_page_token: "",
      },
      "",
      "invalid",
    ],
    [
      "diagnostic with empty page",
      { revisions: [], next_page_token: "" },
      "gateway warning",
      "invalid",
    ],
  ] as const)("classifies %s", (_name, page, stderr, expected) => {
    expect(classifyOpenShellGlobalPolicyHistory(JSON.stringify(page), stderr)).toBe(expected);
  });

  it.each(["", "not json", "null", "[]", "VERSION STATUS\n1 loaded", "{}"])(
    "rejects malformed global history %s",
    (raw) => {
      expect(classifyOpenShellGlobalPolicyHistory(raw, "")).toBe("invalid");
    },
  );

  it("treats a superseded global revision as absent", () => {
    expect(
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          status: "superseded",
          version: 2,
          hash: "sha256:global",
          policy: null,
        }),
      ),
    ).toEqual({ state: "absent" });
  });

  it.each([
    { status: "pending", version: 2 },
    { status: "failed", version: 2 },
    { status: "superseded", version: 0 },
    { status: "loaded", active_version: 2 },
    { status: "loaded", version: 2, sandbox: "alpha" },
    { status: "loaded", version: 2, hash: "invalid hash" },
  ])("refuses invalid global revision metadata %j", (fields) => {
    expect(() =>
      parseActiveGlobalPolicyMetadata(
        JSON.stringify({
          scope: "global",
          hash: "sha256:global",
          policy: { version: 1 },
          ...fields,
        }),
      ),
    ).toThrow(/invalid global policy metadata/);
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

describe("OpenShell endpoint pin admission", () => {
  const document = YAML.stringify({
    version: 1,
    network_policies: {
      existing_policy: { endpoints: [{ host: "*.example.com", ports: [443] }] },
    },
  });

  it.each(["_provider_nvidia_prod", "_provider_previous_custom"])(
    "ignores replaceable %s entries returned in base-policy output",
    (name) => {
      const base = YAML.stringify({
        version: 1,
        network_policies: {
          [name]: { endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }] },
        },
      });
      expect(() =>
        assertOpenShellPolicyEndpointPins(base, "https://integrate.api.nvidia.com/v1", ["8.8.8.8"]),
      ).not.toThrow();
    },
  );

  it("refuses a retained base-rule conflict beside a replaceable provider rule", () => {
    const base = YAML.stringify({
      version: 1,
      network_policies: {
        _provider_nvidia_prod: { endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }] },
        existing_policy: { endpoints: [{ host: "*.api.nvidia.com", port: 443 }] },
      },
    });
    expect(() =>
      assertOpenShellPolicyEndpointPins(base, "https://integrate.api.nvidia.com/v1", ["8.8.8.8"]),
    ).toThrow(/existing_policy.*IP pins.*No provider was changed/);
  });

  it("refuses an unpinned wildcard overlap at the canonical policy boundary", () => {
    expect(() =>
      assertOpenShellPolicyEndpointPins(document, "https://api.example.com/v1", ["8.8.8.8"]),
    ).toThrow(/existing_policy.*IP pins.*No provider was changed/);
  });

  it.each([
    ["DNS", "api.example.com", "https://api.example.com/v1"],
    ["IPv6", "[2001:db8::1]", "https://[2001:db8::1]/v1"],
    ["all hosts", "", "https://api.example.com/v1"],
  ])("admits equal address sets for %s endpoints", (_label, host, endpointUrl) => {
    const base = YAML.stringify({
      version: 1,
      network_policies: {
        existing: {
          endpoints: [{ host, port: 443, allowed_ips: ["2001:DB8::1", " 8.8.8.8 ", "8.8.8.8"] }],
        },
      },
    });
    expect(() =>
      assertOpenShellPolicyEndpointPins(base, endpointUrl, ["8.8.8.8", "2001:db8::1"]),
    ).not.toThrow();
    expect(() => assertOpenShellPolicyEndpointPins(base, endpointUrl, ["8.8.4.4"])).toThrow(
      /conflicting IP pins.*No provider was changed/,
    );
  });

  it.each([
    ["policy", { existing: false }],
    ["endpoint list", { existing: { endpoints: {} } }],
    ["endpoint", { existing: { endpoints: ["api.example.com"] } }],
  ])("refuses malformed %s before provider mutation", (_label, policies) => {
    expect(() =>
      assertOpenShellPolicyEndpointPins(
        YAML.stringify({ version: 1, network_policies: policies }),
        "https://api.example.com/v1",
        ["8.8.8.8"],
      ),
    ).toThrow(/malformed sandbox.*No provider was changed/);
  });

  it("admits a host outside the canonical wildcard label boundary", () => {
    expect(() =>
      assertOpenShellPolicyEndpointPins(document, "https://deep.api.example.com/v1", ["8.8.8.8"]),
    ).not.toThrow();
  });
});

describe("OpenShell host patterns", () => {
  it.each([
    ["api?.example", "api1.example", true],
    ["api?.example", "api12.example", false],
    ["api[0-9].example", "api1.example", true],
    ["api[0-9].example", "apia.example", false],
    ["api[!a-z].example", "api1.example", true],
    ["api[!a-z].example", "apia.example", false],
    ["8.8.8.8", "8.8.8.8", true],
    ["[2001:db8::1]", "[2001:db8::1]", true],
    ["*.example", "api..example", false],
    ["*.example", "deep.api.example", false],
    ["*.example", "example", false],
    ["*.example", "api.example", true],
    ["**.example", "deep.api.example", true],
    ["**.example", "example", false],
    ["api.**.example", "api.x.y.example", true],
    ["api.**.example", "api.example", false],
    ["API.*.example", "api.internal.example", true],
    ["api[^a].example", "api1.example", false],
    ["api[!a].example", "api1.example", true],
    ["api[-a].example", "api-.example", true],
    ["api[a-].example", "api-.example", true],
    ["api[]].example", "api].example", true],
    ["api[!]].example", "api1.example", true],
  ] as const)("matches OpenShell pattern %s against %s: %s", (pattern, host, expected) => {
    expect(openShellHostMatches(pattern, host)).toBe(expected);
  });

  it.each(["api[.example", "api**.example", "*.{prod,stage}.example", "api..example"])(
    "rejects invalid host pattern %s",
    (pattern) => expect(() => openShellHostMatches(pattern, "api.example")).toThrow("host pattern"),
  );
});
