// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate blueprint.yaml profile declarations and base sandbox policy.
 *
 * Catches configuration regressions (missing profiles, empty fields,
 * missing policy sections) before merge.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import YAML from "yaml";

const BLUEPRINT_PATH = new URL("../nemoclaw-blueprint/blueprint.yaml", import.meta.url);
const BASE_POLICY_PATH = new URL(
  "../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  import.meta.url,
);
const REQUIRED_PROFILE_FIELDS = ["provider_type", "endpoint"] as const;

const bp = YAML.parse(readFileSync(BLUEPRINT_PATH, "utf-8")) as Record<string, unknown>;
const declared = Array.isArray(bp?.profiles) ? (bp.profiles as string[]) : [];
const defined =
  (bp?.components as Record<string, unknown> | undefined)?.inference != null
    ? ((bp.components as Record<string, unknown>).inference as Record<string, unknown>).profiles as
        Record<string, Record<string, unknown>> | undefined
    : undefined;

describe("blueprint.yaml", () => {
  it("parses as a YAML mapping", () => {
    expect(bp).toEqual(expect.objectContaining({}));
  });

  it("has a non-empty top-level profiles list", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("has a non-empty components.inference.profiles mapping", () => {
    expect(defined).toBeDefined();
    expect(Object.keys(defined!).length).toBeGreaterThan(0);
  });

  for (const name of declared) {
    describe(`profile '${name}'`, () => {
      it("has a definition", () => {
        expect(defined).toBeDefined();
        expect(name in defined!).toBe(true);
      });

      for (const field of REQUIRED_PROFILE_FIELDS) {
        it(`has non-empty '${field}'`, () => {
          const cfg = defined?.[name];
          if (!cfg) return; // covered by "has a definition"
          if (field === "endpoint" && cfg.dynamic_endpoint === true) {
            expect(field in cfg).toBe(true);
          } else {
            expect(cfg[field]).toBeTruthy();
          }
        });
      }
    });
  }

  for (const name of Object.keys(defined ?? {})) {
    it(`defined profile '${name}' is declared in top-level list`, () => {
      expect(declared).toContain(name);
    });
  }
});

describe("base sandbox policy", () => {
  const policy = YAML.parse(readFileSync(BASE_POLICY_PATH, "utf-8")) as Record<string, unknown>;

  it("parses as a YAML mapping", () => {
    expect(policy).toEqual(expect.objectContaining({}));
  });

  it("has 'version'", () => {
    expect("version" in policy).toBe(true);
  });

  it("has 'network_policies'", () => {
    expect("network_policies" in policy).toBe(true);
  });

  it("no endpoint rule uses wildcard method", () => {
    const np = policy.network_policies as Record<string, Record<string, unknown>>;
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints as Array<Record<string, unknown>> | undefined;
      if (!endpoints) continue;
      for (const ep of endpoints) {
        const rules = ep.rules as Array<Record<string, Record<string, string>>> | undefined;
        if (!rules) continue;
        for (const rule of rules) {
          const method = rule.allow?.method;
          if (method === "*") {
            violations.push(`${policyName} → ${ep.host}: method "*"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every endpoint with rules has protocol: rest and enforcement: enforce", () => {
    const np = policy.network_policies as Record<string, Record<string, unknown>>;
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints as Array<Record<string, unknown>> | undefined;
      if (!endpoints) continue;
      for (const ep of endpoints) {
        if (!ep.rules) continue;
        if (ep.protocol !== "rest") {
          violations.push(`${policyName} → ${ep.host}: missing protocol: rest`);
        }
        if (ep.enforcement !== "enforce") {
          violations.push(`${policyName} → ${ep.host}: missing enforcement: enforce`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("allows NVIDIA embeddings on both NVIDIA inference hosts", () => {
    const np = policy.network_policies as Record<string, Record<string, unknown>>;
    const endpoints =
      np.nvidia?.endpoints as
        | Array<{ host?: string; rules?: Array<{ allow?: { method?: string; path?: string } }> }>
        | undefined;
    const missingHosts: string[] = [];
    for (const host of ["integrate.api.nvidia.com", "inference-api.nvidia.com"]) {
      const endpoint = endpoints?.find((entry) => entry.host === host);
      const hasEmbeddingsRule = endpoint?.rules?.some(
        (rule) =>
          rule.allow?.method === "POST" && rule.allow?.path === "/v1/embeddings",
      );
      if (!hasEmbeddingsRule) {
        missingHosts.push(host);
      }
    }
    expect(missingHosts).toEqual([]);
  });
});
