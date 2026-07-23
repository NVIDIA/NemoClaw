// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  compareSemver,
  correlateAdvisories,
  parseAdvisory,
  parseInventoryFromAuditConfig,
  parseInventoryFromPackageLock,
  satisfiesVulnerableRange,
} from "../scripts/lib/advisory-early-warning.mts";

// Upstream repository security advisory (GET /repos/{owner}/{repo}/security-advisories)
// modeled on GHSA-4c8g-83qw-93j6: published upstream on June 29, weeks before its
// global reviewed ecosystem record appeared on July 21 and npm audit began
// reporting it (#7338). This is the "earlier upstream signal" fixture.
const upstreamFastUriAdvisory = {
  ghsa_id: "GHSA-4c8g-83qw-93j6",
  cve_id: "CVE-2026-13676",
  url: "https://api.github.com/repos/fastify/fast-uri/security-advisories/GHSA-4c8g-83qw-93j6",
  html_url: "https://github.com/fastify/fast-uri/security/advisories/GHSA-4c8g-83qw-93j6",
  summary: "fast-uri URI parsing divergence enables authority spoofing",
  severity: "high",
  state: "published",
  published_at: "2026-06-29T15:02:11Z",
  updated_at: "2026-06-29T15:02:11Z",
  identifiers: [
    { type: "GHSA", value: "GHSA-4c8g-83qw-93j6" },
    { type: "CVE", value: "CVE-2026-13676" },
  ],
  vulnerabilities: [
    {
      package: { ecosystem: "npm", name: "fast-uri" },
      vulnerable_version_range: ">= 3.0.0, < 3.1.3",
      patched_versions: "3.1.3",
      vulnerable_functions: [],
    },
  ],
} as const;

// NVD/CPE-derived record whose product name collides with an npm package but whose
// ecosystem mapping is not a verified npm mapping (GHSA-45rx-2jwx-cxfr shape).
const cpeDerivedAdvisory = {
  ghsa_id: "GHSA-45rx-2jwx-cxfr",
  cve_id: "CVE-2026-59892",
  summary: "Jaeger propagator baggage injection",
  severity: "high",
  published_at: "2026-07-03T09:00:00Z",
  identifiers: [{ type: "CVE", value: "CVE-2026-59892" }],
  vulnerabilities: [
    {
      package: { ecosystem: "other", name: "fast-uri" },
      vulnerable_version_range: "cpe:2.3:a:fastify:fast-uri:*:*",
    },
  ],
} as const;

const inventory = [
  {
    name: "fast-uri",
    version: "3.1.2",
    origin: "agents/openclaw/mcporter-runtime/package-lock.json",
  },
  { name: "tar", version: "7.5.20", origin: "agents/openclaw/mcporter-runtime/package-lock.json" },
  { name: "openclaw", version: "2026.6.10", origin: "ci/reviewed-npm-audit.json" },
] as const;

describe("advisory early warning correlation", () => {
  it("correlates an upstream advisory with an affected inventory entry", () => {
    const signals = correlateAdvisories([upstreamFastUriAdvisory], inventory);
    expect(signals).toEqual([
      {
        advisoryId: "GHSA-4c8g-83qw-93j6",
        package: "fast-uri",
        vulnerableRange: ">= 3.0.0, < 3.1.3",
        matchedVersions: ["3.1.2"],
        source: "upstream-ghsa",
        confidence: "exact",
        action: "investigate",
      },
    ]);
  });

  it("keeps ambiguous CPE-to-npm matches informational instead of blocking", () => {
    const signals = correlateAdvisories([cpeDerivedAdvisory], inventory);
    expect(signals).toEqual([
      {
        advisoryId: "GHSA-45rx-2jwx-cxfr",
        package: "fast-uri",
        vulnerableRange: "cpe:2.3:a:fastify:fast-uri:*:*",
        matchedVersions: ["3.1.2"],
        source: "upstream-ghsa",
        confidence: "ambiguous",
        action: "informational",
      },
    ]);
  });

  it("treats an unparseable npm range as ambiguous rather than blocking", () => {
    const advisory = {
      ghsa_id: "GHSA-23hp-3jrh-7fpw",
      vulnerabilities: [
        {
          package: { ecosystem: "npm", name: "tar" },
          vulnerable_version_range: "all versions before the July rewrite",
        },
      ],
    };
    const signals = correlateAdvisories([advisory], inventory);
    expect(signals).toEqual([
      {
        advisoryId: "GHSA-23hp-3jrh-7fpw",
        package: "tar",
        vulnerableRange: "all versions before the July rewrite",
        matchedVersions: ["7.5.20"],
        source: "upstream-ghsa",
        confidence: "ambiguous",
        action: "informational",
      },
    ]);
  });

  it("emits nothing when the advisory package is absent from the inventory", () => {
    const advisory = {
      ghsa_id: "GHSA-8988-4f7v-96qf",
      vulnerabilities: [
        {
          package: { ecosystem: "npm", name: "@opentelemetry/core" },
          vulnerable_version_range: "< 1.30.0",
        },
      ],
    };
    expect(correlateAdvisories([advisory], inventory)).toEqual([]);
  });

  it("emits nothing when the inventory version is outside the vulnerable range", () => {
    const advisory = {
      ghsa_id: "GHSA-23hp-3jrh-7fpw",
      vulnerabilities: [
        {
          package: { ecosystem: "npm", name: "tar" },
          vulnerable_version_range: "< 7.5.16",
        },
      ],
    };
    expect(correlateAdvisories([advisory], inventory)).toEqual([]);
  });

  it("merges duplicate matches for one advisory and package into a single signal", () => {
    const duplicatedInventory = [
      ...inventory,
      { name: "fast-uri", version: "3.0.1", origin: "ci/reviewed-npm-audit.json" },
      { name: "fast-uri", version: "3.1.2", origin: "another-lock.json" },
    ];
    const signals = correlateAdvisories([upstreamFastUriAdvisory], duplicatedInventory);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.matchedVersions).toEqual(["3.0.1", "3.1.2"]);
  });

  const garbageRangeVulnerability = {
    package: { ecosystem: "npm", name: "tar" },
    vulnerable_version_range: "all versions before the July rewrite",
  };
  const exactRangeVulnerability = {
    package: { ecosystem: "npm", name: "tar" },
    vulnerable_version_range: "< 9.0.0",
  };

  it.each([
    ["garbage range first", [garbageRangeVulnerability, exactRangeVulnerability]],
    ["exact range first", [exactRangeVulnerability, garbageRangeVulnerability]],
  ])("keeps an exact signal free of ambiguous evidence for the same package (%s)", (_label, vulnerabilities) => {
    const advisory = { ghsa_id: "GHSA-23hp-3jrh-7fpw", vulnerabilities };
    expect(correlateAdvisories([advisory], inventory)).toEqual([
      {
        advisoryId: "GHSA-23hp-3jrh-7fpw",
        package: "tar",
        vulnerableRange: "< 9.0.0",
        matchedVersions: ["7.5.20"],
        source: "upstream-ghsa",
        confidence: "exact",
        action: "investigate",
      },
    ]);
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["an empty object", {}],
    ["a missing ghsa id", { vulnerabilities: [] }],
    ["a non-array vulnerabilities field", { ghsa_id: "GHSA-4c8g-83qw-93j6", vulnerabilities: 7 }],
    [
      "a vulnerability entry without a package",
      { ghsa_id: "GHSA-4c8g-83qw-93j6", vulnerabilities: [{ vulnerable_version_range: "< 1" }] },
    ],
  ])("does not throw on malformed advisory input: %s", (_label, advisory) => {
    expect(() => correlateAdvisories([advisory], inventory)).not.toThrow();
    expect(correlateAdvisories([advisory], inventory)).toEqual([]);
  });

  it("parses a well-formed advisory into its correlation-relevant fields", () => {
    expect(parseAdvisory(upstreamFastUriAdvisory)).toEqual({
      advisoryId: "GHSA-4c8g-83qw-93j6",
      vulnerabilities: [
        {
          ecosystem: "npm",
          packageName: "fast-uri",
          vulnerableRange: ">= 3.0.0, < 3.1.3",
        },
      ],
    });
  });

  it("rejects advisories whose GHSA id does not look like a GHSA id", () => {
    expect(parseAdvisory({ ghsa_id: "not-an-id", vulnerabilities: [] })).toBeNull();
  });
});

describe("advisory early warning inventory parsing", () => {
  it("parses package specs from the reviewed npm audit config", () => {
    const config = {
      archivePackages: [
        { packageSpec: "openclaw@2026.6.10" },
        { packageSpec: "@openclaw/slack@2026.6.10" },
      ],
      lockedGraphs: [{ packageSpec: "mcporter@0.7.3" }],
    };
    expect(parseInventoryFromAuditConfig(config, "ci/reviewed-npm-audit.json")).toEqual([
      { name: "openclaw", version: "2026.6.10", origin: "ci/reviewed-npm-audit.json" },
      { name: "@openclaw/slack", version: "2026.6.10", origin: "ci/reviewed-npm-audit.json" },
      { name: "mcporter", version: "0.7.3", origin: "ci/reviewed-npm-audit.json" },
    ]);
  });

  it("skips malformed audit config entries without throwing", () => {
    const config = {
      archivePackages: [{ packageSpec: "no-version" }, { packageSpec: 12 }, null],
      lockedGraphs: "nope",
    };
    expect(parseInventoryFromAuditConfig(config, "ci/reviewed-npm-audit.json")).toEqual([]);
    expect(parseInventoryFromAuditConfig(null, "ci/reviewed-npm-audit.json")).toEqual([]);
  });

  it("parses installed packages from a package-lock subset", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "root" },
        "node_modules/fast-uri": { version: "3.1.2" },
        "node_modules/@scope/pkg": { version: "1.0.0" },
        "node_modules/outer/node_modules/tar": { version: "7.5.20" },
        "node_modules/linked": { link: true },
      },
    };
    expect(parseInventoryFromPackageLock(lock, "fixture-lock.json")).toEqual([
      { name: "fast-uri", version: "3.1.2", origin: "fixture-lock.json" },
      { name: "@scope/pkg", version: "1.0.0", origin: "fixture-lock.json" },
      { name: "tar", version: "7.5.20", origin: "fixture-lock.json" },
    ]);
  });

  it("inventories aliased lock entries under their real package name", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "node_modules/my-alias": { name: "fast-uri", version: "3.1.2" },
      },
    };
    expect(parseInventoryFromPackageLock(lock, "fixture-lock.json")).toEqual([
      { name: "fast-uri", version: "3.1.2", origin: "fixture-lock.json" },
    ]);
  });

  it("returns an empty inventory for malformed package-lock input", () => {
    expect(parseInventoryFromPackageLock(null, "fixture-lock.json")).toEqual([]);
    expect(parseInventoryFromPackageLock({ packages: [] }, "fixture-lock.json")).toEqual([]);
  });
});

describe("advisory early warning semver subset", () => {
  it.each([
    ["3.1.2", ">= 3.0.0, < 3.1.3", true],
    ["3.1.3", ">= 3.0.0, < 3.1.3", false],
    ["2.9.9", ">= 3.0.0, < 3.1.3", false],
    ["7.5.11", "<= 7.5.15", true],
    ["7.5.15", "<= 7.5.15", true],
    ["3.0.0", ">= 3.0.0", true],
    ["2.9.9", ">= 3.0.0", false],
    ["3.0.1", "> 3.0.0", true],
    ["3.0.0", "> 3.0.0", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "= 1.2.4", false],
    ["3.1.3-rc.1", "< 3.1.3", true],
    // A provably-false parseable comparator decides the AND even when another
    // comparator is unparseable.
    ["2.0.0", ">= 3.0.0, < 3.1.x", false],
  ])("satisfiesVulnerableRange(%s, %s) -> %s", (version, range, expected) => {
    expect(satisfiesVulnerableRange(version, range)).toBe(expected);
  });

  it.each([
    ["not-a-version", "< 1.0.0"],
    ["1.0.0", "cpe:2.3:a:fastify:fast-uri:*:*"],
    ["1.0.0", ""],
    ["1.0.0", "^1.0.0 || >= 2"],
    ["3.0.5", ">= 3.0.0, < 3.1.x"],
  ])("reports unparseable input as null for (%s, %s)", (version, range) => {
    expect(satisfiesVulnerableRange(version, range)).toBeNull();
  });

  it.each([
    ["1.2.3", "1.2.3", 0],
    ["1.2.3", "1.2.4", -1],
    ["1.10.0", "1.9.0", 1],
    ["1.0.0-alpha", "1.0.0", -1],
    ["1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
    ["v1.2.3", "1.2.3", 0],
    ["1.2.3+build.5", "1.2.3", 0],
  ])("compareSemver(%s, %s) -> %i", (left, right, expected) => {
    expect(Math.sign(compareSemver(left, right) ?? Number.NaN)).toBe(expected);
  });

  it.each([
    ["1.2", "1.2.3"],
    ["1.2.3", "1.2"],
  ])("compareSemver(%s, %s) is null for non-semver input", (left, right) => {
    expect(compareSemver(left, right)).toBeNull();
  });
});
