// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the dangerous-host semantic check added to scripts/validate-configs.ts.
//
// JSON Schema already handles structural validation for the policy YAML files.
// This suite covers the additional semantic check that rejects catch-all hosts
// ("*", "0.0.0.0/0", "::/0", etc.) which Schema can't express natively.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/1445

import { describe, expect, it } from "vitest";

import {
  DANGEROUS_HOSTS,
  findDangerousHosts,
  isDangerousHost,
} from "../scripts/validate-configs";

describe("isDangerousHost", () => {
  it.each([
    "*",
    "0.0.0.0",
    "0.0.0.0/0",
    "::",
    "::/0",
  ])("flags %s as dangerous", (host) => {
    expect(isDangerousHost(host)).toBe(true);
  });

  it("flags bare wildcard with port as dangerous", () => {
    expect(isDangerousHost("*:443")).toBe(true);
  });

  it.each([
    "example.com",
    "*.example.com",
    "api.example.com",
    "internal-service.svc.cluster.local",
    "127.0.0.1",
    "10.0.0.5",
  ])("allows specific host %s", (host) => {
    expect(isDangerousHost(host)).toBe(false);
  });

  it.each([undefined, null, 42, {}, []])("returns false for non-string %s", (v) => {
    expect(isDangerousHost(v as any)).toBe(false);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(isDangerousHost("  *  ")).toBe(true);
    expect(isDangerousHost("\t0.0.0.0/0\n")).toBe(true);
  });

  it("covers the full DANGEROUS_HOSTS set", () => {
    for (const host of DANGEROUS_HOSTS) {
      expect(isDangerousHost(host)).toBe(true);
    }
  });
});

describe("findDangerousHosts", () => {
  it("returns [] for documents with no network_policies", () => {
    expect(findDangerousHosts({ version: 1 })).toEqual([]);
    expect(findDangerousHosts(null)).toEqual([]);
    expect(findDangerousHosts("not an object")).toEqual([]);
  });

  it("returns [] when all endpoints use specific hosts", () => {
    const doc = {
      version: 1,
      network_policies: {
        api: {
          endpoints: [
            { host: "api.example.com", port: 443 },
            { host: "*.internal.example.com", port: 443 },
          ],
        },
      },
    };
    expect(findDangerousHosts(doc)).toEqual([]);
  });

  it("flags a single catch-all host with its full path", () => {
    const doc = {
      version: 1,
      network_policies: {
        egress: {
          endpoints: [
            { host: "api.example.com", port: 443 },
            { host: "0.0.0.0/0", port: 443 },
          ],
        },
      },
    };
    const findings = findDangerousHosts(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].host).toBe("0.0.0.0/0");
    expect(findings[0].path).toBe("/network_policies/egress/endpoints/1/host");
  });

  it("flags every catch-all across multiple policies", () => {
    const doc = {
      version: 1,
      network_policies: {
        a: { endpoints: [{ host: "*", port: 80 }] },
        b: { endpoints: [{ host: "example.com", port: 443 }, { host: "::", port: 53 }] },
      },
    };
    const findings = findDangerousHosts(doc);
    expect(findings.map((f) => f.host).sort()).toEqual(["*", "::"]);
    expect(findings.find((f) => f.host === "*")?.path).toBe(
      "/network_policies/a/endpoints/0/host",
    );
    expect(findings.find((f) => f.host === "::")?.path).toBe(
      "/network_policies/b/endpoints/1/host",
    );
  });

  it("tolerates malformed shapes without throwing", () => {
    expect(findDangerousHosts({ network_policies: [] })).toEqual([]); // wrong type
    expect(findDangerousHosts({ network_policies: { p: null } })).toEqual([]);
    expect(findDangerousHosts({ network_policies: { p: { endpoints: "not a list" } } })).toEqual(
      [],
    );
    expect(
      findDangerousHosts({ network_policies: { p: { endpoints: [null, { host: 123 }] } } }),
    ).toEqual([]);
  });

  it("walks network_policies in preset-shape docs (preset metadata + top-level policies)", () => {
    // Per schemas/policy-preset.schema.json, preset files carry both a top-level
    // `preset:` metadata block AND a top-level `network_policies:` map. Endpoints
    // live under network_policies (not inside preset), so the existing walk
    // covers them. Lock that in so a future schema change doesn't silently
    // regress dangerous-host coverage for presets.
    const presetDoc = {
      preset: { name: "slack-like", description: "example preset" },
      network_policies: {
        slack: {
          name: "slack",
          endpoints: [
            { host: "slack.com", port: 443 },
            { host: "*", port: 443 }, // dangerous
          ],
        },
      },
    };
    const findings = findDangerousHosts(presetDoc);
    expect(findings).toHaveLength(1);
    expect(findings[0].host).toBe("*");
    expect(findings[0].path).toBe("/network_policies/slack/endpoints/1/host");
  });
});
