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
const REQUIRED_PROFILE_FIELDS: ReadonlyArray<keyof BlueprintProfile> = [
  "provider_type",
  "endpoint",
];

type BlueprintProfile = {
  provider_type?: string;
  endpoint?: string;
  dynamic_endpoint?: boolean;
};

type Blueprint = {
  version?: string;
  digest?: string;
  profiles?: string[];
  components?: {
    sandbox?: { image?: string | null };
    inference?: { profiles?: Record<string, BlueprintProfile> };
  };
};

type Rule = { allow?: { method?: string; path?: string } };
type Endpoint = {
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  access?: string;
  rules?: Rule[];
  binaries?: Array<{ path: string }>;
};

type PolicyEntry = {
  name?: string;
  endpoints?: Endpoint[];
  binaries?: Array<{ path: string }>;
};

type SandboxPolicy = {
  version?: number;
  network_policies?: Record<string, PolicyEntry>;
};

type PolicyPreset = {
  preset?: { name?: string; description?: string };
  network_policies?: Record<string, PolicyEntry>;
};

function loadYaml<T>(path: URL): T {
  return YAML.parse(readFileSync(path, "utf-8"));
}

const bp = loadYaml<Blueprint>(BLUEPRINT_PATH);
const declared = Array.isArray(bp.profiles) ? bp.profiles : [];
const defined = bp.components?.inference?.profiles;

describe("blueprint.yaml", () => {
  it("parses as a YAML mapping", () => {
    expect(bp).toEqual(expect.objectContaining({}));
  });

  it("has a non-empty top-level profiles list", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("has a non-empty components.inference.profiles mapping", () => {
    expect(defined).toBeDefined();
    expect(Object.keys(defined ?? {}).length).toBeGreaterThan(0);
  });

  it("regression #1438: sandbox image is pinned by digest, not by mutable tag", () => {
    // The blueprint MUST NOT pull a sandbox image by a mutable tag like
    // ":latest" — a registry compromise or accidental force-push could
    // silently swap the image. Pin via @sha256:... so the image cannot
    // change without a corresponding blueprint update.
    const sandbox = bp.components?.sandbox;
    const image = typeof sandbox?.image === "string" ? sandbox.image : "";
    expect(image.length).toBeGreaterThan(0);
    expect(image).toContain("@sha256:");
    // Belt and braces: explicitly forbid the ":latest" tag form even if the
    // image string has been rearranged.
    expect(image).not.toMatch(/:latest$/);
    expect(image).not.toMatch(/:latest@/);
    // The digest itself must be a 64-hex sha256.
    const digestMatch = image.match(/@sha256:([0-9a-f]{64})$/);
    expect(digestMatch).not.toBeNull();
  });

  it("regression #1438: top-level digest field is populated and matches the image digest", () => {
    // The top-level `digest:` field at the top of blueprint.yaml is
    // documented as "Computed at release time" and was empty on main,
    // which left blueprint-level integrity unverifiable. Mirror the
    // sandbox image manifest digest into the top-level field so any
    // consumer can read a single field to know what's pinned, and so
    // a future contributor can't bump one without bumping the other.
    const topLevelDigest = typeof bp.digest === "string" ? bp.digest : "";
    expect(topLevelDigest.length).toBeGreaterThan(0);
    // Must be a sha256:<64-hex> string.
    expect(topLevelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const sandbox = bp.components?.sandbox;
    const image = typeof sandbox?.image === "string" ? sandbox.image : "";
    const imageDigestMatch = image.match(/@sha256:([0-9a-f]{64})$/);
    expect(imageDigestMatch).not.toBeNull();
    const imageDigest = `sha256:${imageDigestMatch?.[1] ?? ""}`;

    // The two digests must agree. If a future bump touches one but not
    // the other, this assertion catches it before merge.
    expect(topLevelDigest).toBe(imageDigest);
  });

  for (const name of declared) {
    describe(`profile '${name}'`, () => {
      it("has a definition", () => {
        expect(defined).toBeDefined();
        expect(name in (defined ?? {})).toBe(true);
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
  const policy = loadYaml<SandboxPolicy>(BASE_POLICY_PATH);

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
    const np = policy.network_policies ?? {};
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints;
      if (!endpoints) continue;
      for (const ep of endpoints) {
        const rules = ep.rules;
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
    const np = policy.network_policies ?? {};
    const violations: string[] = [];
    for (const [policyName, cfg] of Object.entries(np)) {
      const endpoints = cfg.endpoints;
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
    const np = policy.network_policies ?? {};
    const endpoints = np.nvidia?.endpoints;
    const missingHosts: string[] = [];
    for (const host of ["integrate.api.nvidia.com", "inference-api.nvidia.com"]) {
      const endpoint = endpoints?.find((entry) => entry.host === host);
      const hasEmbeddingsRule = endpoint?.rules?.some(
        (rule) => rule.allow?.method === "POST" && rule.allow?.path === "/v1/embeddings",
      );
      if (!hasEmbeddingsRule) {
        missingHosts.push(host);
      }
    }
    expect(missingHosts).toEqual([]);
  });

  // Walk every endpoint in every network_policies entry and return the
  // entries whose host matches `hostMatcher`. Used by the regressions below.
  function findEndpoints(hostMatcher: (h: string) => boolean): Endpoint[] {
    const out: Endpoint[] = [];
    const np = policy.network_policies;
    if (!np) return out;
    for (const value of Object.values(np)) {
      const endpoints = value.endpoints;
      if (!Array.isArray(endpoints)) continue;
      for (const ep of endpoints) {
        if (typeof ep.host === "string" && hostMatcher(ep.host)) {
          out.push(ep);
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
        (r) =>
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "POST",
      );
      expect(hasPost).toBe(false);
    }
  });

  it("regression #1437: sentry.io retains GET (harmless, no body for exfil)", () => {
    const sentryEndpoints = findEndpoints((h) => h === "sentry.io");
    for (const ep of sentryEndpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasGet = rules.some(
        (r) =>
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "GET",
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
    const np = policy.network_policies;
    expect(np && "github" in np).toBe(false);

    // Belt and braces: also assert no endpoint in any base-policy
    // entry references github.com or api.github.com, so the
    // regression can't be smuggled in under a renamed key.
    const githubHosts = findEndpoints((h) => h === "github.com" || h === "api.github.com");
    expect(githubHosts).toEqual([]);
  });

  it("regression #1458: baseline npm_registry must not include npm or node binaries", () => {
    const np = policy.network_policies ?? {};
    const npmRegistry = np.npm_registry;
    expect(npmRegistry).toBeDefined();
    const binaries = npmRegistry?.binaries;
    expect(Array.isArray(binaries)).toBe(true);
    const paths = (binaries ?? []).map((b) => b.path).sort();
    // Only openclaw CLI should reach the npm registry by default.
    // npm/node being in this list lets the agent bypass 'none' policy preset.
    // Exact allowlist — adding any binary here requires a deliberate review.
    expect(paths).toEqual(["/usr/local/bin/openclaw"]);
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
    const parsed = loadYaml<PolicyPreset>(PRESET_PATH);
    expect(parsed).toEqual(expect.objectContaining({}));
    const meta = parsed.preset;
    expect(meta?.name).toBe("github");
    const np = parsed.network_policies;
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
  const huggingfacePreset = loadYaml<PolicyPreset>(HUGGINGFACE_PRESET_PATH);

  function presetEndpoints(): Endpoint[] {
    const np = huggingfacePreset.network_policies;
    if (!np) return [];
    const hf = np.huggingface;
    return Array.isArray(hf?.endpoints) ? hf.endpoints : [];
  }

  it("regression #1432: huggingface.co has no POST allow rule", () => {
    const endpoints = presetEndpoints().filter((ep) => ep.host === "huggingface.co");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) {
      const rules = Array.isArray(ep.rules) ? ep.rules : [];
      const hasPost = rules.some(
        (r) =>
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "POST",
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
          r &&
          r.allow &&
          typeof r.allow.method === "string" &&
          r.allow.method.toUpperCase() === "GET",
      );
      expect(hasGet).toBe(true);
    }
  });
});
