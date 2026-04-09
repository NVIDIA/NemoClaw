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

  // Walk every endpoint in every network_policies entry and return the
  // entries whose host matches `hostMatcher`. Used by the regressions below.
  type Rule = { allow?: { method?: string; path?: string } };
  type Endpoint = { host?: string; rules?: Rule[] };
  function findEndpoints(hostMatcher: (h: string) => boolean): Endpoint[] {
    const out: Endpoint[] = [];
    const np = (policy as Record<string, unknown>).network_policies;
    if (!np || typeof np !== "object") return out;
    for (const value of Object.values(np as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const endpoints = (value as { endpoints?: unknown }).endpoints;
      if (!Array.isArray(endpoints)) continue;
      for (const ep of endpoints) {
        if (ep && typeof ep === "object" && typeof (ep as Endpoint).host === "string") {
          if (hostMatcher((ep as Endpoint).host as string)) {
            out.push(ep as Endpoint);
          }
        }
      }
    }
    return out;
  }

  it("regression #1437: sentry.io has no POST allow rule (multi-tenant exfiltration vector)", () => {
    const sentryEndpoints = findEndpoints((h) => h === "sentry.io");
    expect(sentryEndpoints.length).toBeGreaterThan(0); // should still appear
    for (const ep of sentryEndpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasPost = rules.some(
        (r) => r && r.allow && typeof r.allow.method === "string" && r.allow.method.toUpperCase() === "POST",
      );
      expect(hasPost).toBe(false);
    }
  });

  it("regression #1437: sentry.io retains GET (harmless, no body for exfil)", () => {
    const sentryEndpoints = findEndpoints((h) => h === "sentry.io");
    for (const ep of sentryEndpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasGet = rules.some(
        (r) => r && r.allow && typeof r.allow.method === "string" && r.allow.method.toUpperCase() === "GET",
      );
      expect(hasGet).toBe(true);
    }
  });

  it("regression #1583: base policy does not silently grant GitHub access", () => {
    // Until #1583, github.com / api.github.com plus the git/gh
    // binaries lived in network_policies and were therefore included
    // in every sandbox regardless of user opt-in. The fix moves the
    // entry into a discoverable preset (`presets/github.yaml`). This
    // assertion blocks the regression where someone re-adds a github
    // entry to the base policy and silently re-grants every sandbox
    // unscoped GitHub access.
    const np = policy.network_policies as Record<string, unknown> | undefined;
    expect(np && typeof np === "object" && "github" in np).toBe(false);

    // Belt and braces: also assert no endpoint in any base-policy
    // entry references github.com or api.github.com, so the
    // regression can't be smuggled in under a renamed key.
    const githubHosts = findEndpoints(
      (h) => h === "github.com" || h === "api.github.com",
    );
    expect(githubHosts).toEqual([]);
  });
});

describe("github preset", () => {
  // The fix for #1583 was *only* meaningful if the github preset
  // actually exists and is loadable — otherwise users have no way to
  // opt in. Verify the preset file is present and well-formed.
  const PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/github.yaml",
    import.meta.url,
  );

  it("regression #1583: github preset file exists and parses", () => {
    const raw = readFileSync(PRESET_PATH, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual(expect.objectContaining({}));
    const meta = parsed.preset as { name?: unknown } | undefined;
    expect(meta?.name).toBe("github");
    const np = parsed.network_policies as Record<string, unknown> | undefined;
    expect(np && "github" in np).toBe(true);
  });
});

describe("huggingface preset", () => {
  // The huggingface preset used to allow POST /** on huggingface.co,
  // which let an agent that found an HF token in the environment
  // publish models, datasets, and create repositories via
  // /api/repos/create and friends. Inference Provider traffic flows
  // through router.huggingface.co, not huggingface.co, so the POST
  // rule was never required for read-only `from_pretrained` flows.
  // The fix removes the POST rule from huggingface.co (download-only).
  // These tests block a regression where someone re-adds it.
  // See #1432.
  const HUGGINGFACE_PRESET_PATH = new URL(
    "../nemoclaw-blueprint/policies/presets/huggingface.yaml",
    import.meta.url,
  );
  const huggingfacePreset = YAML.parse(
    readFileSync(HUGGINGFACE_PRESET_PATH, "utf-8"),
  ) as Record<string, unknown>;

  type Rule = { allow?: { method?: string; path?: string } };
  type Endpoint = { host?: string; rules?: Rule[] };

  function presetEndpoints(): Endpoint[] {
    const np = huggingfacePreset.network_policies as Record<string, unknown> | undefined;
    if (!np) return [];
    const hf = np.huggingface as { endpoints?: unknown } | undefined;
    return Array.isArray(hf?.endpoints) ? (hf!.endpoints as Endpoint[]) : [];
  }

  it("regression #1432: huggingface.co has no POST allow rule", () => {
    const endpoints = presetEndpoints().filter((ep) => ep.host === "huggingface.co");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasPost = rules.some(
        (r) =>
          r && r.allow && typeof r.allow.method === "string" && r.allow.method.toUpperCase() === "POST",
      );
      expect(hasPost).toBe(false);
    }
  });

  it("regression #1432: huggingface.co retains GET so downloads still work", () => {
    const endpoints = presetEndpoints().filter((ep) => ep.host === "huggingface.co");
    for (const ep of endpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasGet = rules.some(
        (r) =>
          r && r.allow && typeof r.allow.method === "string" && r.allow.method.toUpperCase() === "GET",
      );
      expect(hasGet).toBe(true);
    }
  });
});
