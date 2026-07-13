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
  findDangerousRouterApiBases,
  isDangerousHost,
  ROUTER_API_BASE_HOST_ALLOWLIST,
  runConfigSemanticChecks,
} from "../scripts/validate-configs";
import {
  DANGEROUS_HOST_CHECK,
  runSemanticChecks,
  splitSemanticFindings,
} from "../src/lib/policy/semantic-validation";

describe("isDangerousHost", () => {
  it.each([
    "*",
    "0.0.0.0",
    "0.0.0.0/0",
    "::",
    "::/0",
    "*:443",
    "0.0.0.0:8080",
    "0.0.0.0/0:443",
    "::/0:443",
    "[::]",
    "[::]:443",
    "[::/0]:443",
  ])("flags %s as dangerous", (host) => {
    expect(isDangerousHost(host)).toBe(true);
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

describe("findDangerousRouterApiBases", () => {
  it("allows the public NVIDIA Build endpoint", () => {
    expect(
      findDangerousRouterApiBases({
        models: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
      }),
    ).toEqual([]);
    expect(ROUTER_API_BASE_HOST_ALLOWLIST.has("integrate.api.nvidia.com")).toBe(true);
  });

  it.each([
    "http://integrate.api.nvidia.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.5/v1",
    "https://metadata.google.internal/v1",
  ])("flags unsafe router api_base %s", (apiBase) => {
    const findings = findDangerousRouterApiBases({ models: [{ api_base: apiBase }] });
    expect(findings).toEqual([{ path: "/models/0/api_base", host: apiBase }]);
  });

  it("tolerates malformed shapes", () => {
    expect(findDangerousRouterApiBases(null)).toEqual([]);
    expect(findDangerousRouterApiBases({ models: "not an array" })).toEqual([]);
    expect(findDangerousRouterApiBases({ models: [{ api_base: "not a url" }] })).toEqual([]);
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
    expect(findings[0].severity).toBe("error");
  });

  it("flags every catch-all across multiple policies", () => {
    const doc = {
      version: 1,
      network_policies: {
        a: { endpoints: [{ host: "*", port: 80 }] },
        b: {
          endpoints: [
            { host: "example.com", port: 443 },
            { host: "::", port: 53 },
          ],
        },
      },
    };
    const findings = findDangerousHosts(doc);
    expect(findings.map((f) => f.host).sort()).toEqual(["*", "::"]);
    expect(findings.find((f) => f.host === "*")?.path).toBe("/network_policies/a/endpoints/0/host");
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

describe("runConfigSemanticChecks", () => {
  it("runs the shared policy semantic checks from the config validator", () => {
    expect(
      runConfigSemanticChecks({
        network_policies: { egress: { endpoints: [{ host: "*:443", port: 443 }] } },
      }),
    ).toMatchObject([
      {
        path: "/network_policies/egress/endpoints/0/host",
        host: "*:443",
        severity: "error",
      },
    ]);
  });
});

describe("runSemanticChecks", () => {
  it("composes named checks and preserves error and warning findings", () => {
    const findings = runSemanticChecks({ policy: "value" }, [
      {
        name: "first",
        description: "Reports the first finding.",
        run: () => [{ path: "/first", message: "first finding", severity: "error" }],
      },
      {
        name: "second",
        description: "Reports the second finding.",
        run: () => [{ path: "/second", message: "second finding", severity: "warning" }],
      },
    ]);
    expect(findings).toEqual([
      { path: "/first", message: "first finding", severity: "error" },
      { path: "/second", message: "second finding", severity: "warning" },
    ]);
    expect(splitSemanticFindings(findings)).toEqual({
      errors: [{ path: "/first", message: "first finding", severity: "error" }],
      warnings: [{ path: "/second", message: "second finding", severity: "warning" }],
    });
  });

  it("describes the registered dangerous-host check", () => {
    expect(DANGEROUS_HOST_CHECK).toMatchObject({
      name: "dangerous-host",
      description: expect.any(String),
      run: findDangerousHosts,
    });
  });
});
