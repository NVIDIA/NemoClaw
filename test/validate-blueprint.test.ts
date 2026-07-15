// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Protect the blueprint image trust anchor and the effective sandbox policies
 * that NemoClaw submits after its production create/merge path consumes the
 * checked-in policy sources. Structural validation belongs to
 * scripts/validate-configs.mts.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { prepareInitialSandboxCreatePolicy } from "../src/lib/onboard/initial-policy";
import * as policies from "../src/lib/policy";

const BLUEPRINT_PATH = new URL("../nemoclaw-blueprint/blueprint.yaml", import.meta.url);
const BASE_POLICY_PATH = new URL(
  "../nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  import.meta.url,
);
const PERMISSIVE_POLICY_PATH = new URL(
  "../nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
  import.meta.url,
);
const HERMES_POLICY_PATH = new URL("../agents/hermes/policy-additions.yaml", import.meta.url);

type Blueprint = {
  digest?: string;
  components?: {
    sandbox?: { image?: string | null };
  };
};

type Rule = { allow?: { method?: string; path?: string } };
type Endpoint = {
  host?: string;
  port?: number;
  protocol?: string;
  enforcement?: string;
  access?: string;
  tls?: string;
  allow_encoded_slash?: boolean;
  rules?: Rule[];
};
type PolicyEntry = {
  endpoints?: Endpoint[];
  binaries?: Array<{ path?: string }>;
};
type SandboxPolicy = {
  network_policies?: Record<string, PolicyEntry>;
};

function loadYaml<T>(path: URL): T {
  return YAML.parse(readFileSync(path, "utf-8"));
}

function parseEffectivePolicy(policy: string): SandboxPolicy {
  return YAML.parse(policy) as SandboxPolicy;
}

function endpoint(policy: SandboxPolicy, policyName: string, host: string): Endpoint {
  const candidate = policy.network_policies?.[policyName]?.endpoints?.find(
    (entry) => entry.host === host,
  );
  expect(candidate, `${policyName} must allow ${host}`).toBeDefined();
  return candidate ?? {};
}

function methods(candidate: Endpoint): string[] {
  return (candidate.rules ?? [])
    .map((rule) => rule.allow?.method)
    .filter((method): method is string => typeof method === "string")
    .sort();
}

function binaries(policy: SandboxPolicy, policyName: string): string[] {
  return (policy.network_policies?.[policyName]?.binaries ?? [])
    .map((binary) => binary.path)
    .filter((binary): binary is string => typeof binary === "string")
    .sort();
}

function allEndpoints(policy: SandboxPolicy): Endpoint[] {
  return Object.values(policy.network_policies ?? {}).flatMap((entry) => entry.endpoints ?? []);
}

const bp = loadYaml<Blueprint>(BLUEPRINT_PATH);

describe("blueprint image trust anchor", () => {
  // source-shape-contract: security -- The immutable sandbox image digest is the executable supply-chain trust anchor
  it("pins the sandbox image by digest instead of a mutable tag (#1438)", () => {
    const sandbox = bp.components?.sandbox;
    const image = typeof sandbox?.image === "string" ? sandbox.image : "";

    expect(image.length).toBeGreaterThan(0);
    expect(image).toContain("@sha256:");
    expect(image).not.toMatch(/:latest$/);
    expect(image).not.toMatch(/:latest@/);
    expect(image.match(/@sha256:([0-9a-f]{64})$/)).not.toBeNull();
  });

  // source-shape-contract: security -- Cross-field digest equality prevents the shipped sandbox trust anchor from drifting
  it("populates the top-level digest field with the image digest (#1438)", () => {
    const topLevelDigest = typeof bp.digest === "string" ? bp.digest : "";
    const image =
      typeof bp.components?.sandbox?.image === "string" ? bp.components.sandbox.image : "";
    const imageDigestMatch = image.match(/@sha256:([0-9a-f]{64})$/);

    expect(topLevelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(imageDigestMatch).not.toBeNull();
    expect(topLevelDigest).toBe(`sha256:${imageDigestMatch?.[1] ?? ""}`);
  });
});

describe("effective sandbox policy behavior", () => {
  it("keeps default OpenClaw egress least-privilege after create-policy preparation", () => {
    const prepared = prepareInitialSandboxCreatePolicy(BASE_POLICY_PATH.pathname, [], {
      agentName: "openclaw",
    });
    try {
      const consumed = policies.mergePresetNamesIntoPolicy(
        readFileSync(prepared.policyPath, "utf-8"),
        [],
        { agent: "openclaw" },
      );
      const policy = parseEffectivePolicy(consumed.policy);
      const networkPolicies = policy.network_policies ?? {};

      expect(consumed.missingPresets).toEqual([]);

      for (const [policyName, entry] of Object.entries(networkPolicies)) {
        for (const candidate of entry.endpoints ?? []) {
          expect(methods(candidate), `${policyName}:${candidate.host}`).not.toContain("*");
          if ((candidate.rules ?? []).length > 0) {
            expect(candidate, `${policyName}:${candidate.host}`).toMatchObject({
              protocol: "rest",
              enforcement: "enforce",
            });
          }
        }
      }

      const nvidia = endpoint(policy, "nvidia", "integrate.api.nvidia.com");
      expect(nvidia.rules).toContainEqual({ allow: { method: "POST", path: "/v1/embeddings" } });

      const managedInference = endpoint(policy, "managed_inference", "inference.local");
      expect(managedInference).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
      });
      expect(methods(managedInference)).toEqual(["GET", "POST"]);
      expect(binaries(policy, "managed_inference")).toEqual(
        [
          "/usr/bin/curl",
          "/usr/bin/node",
          "/usr/bin/python3",
          "/usr/local/bin/node",
          "/usr/local/bin/openclaw",
        ].sort(),
      );

      const clawhub = endpoint(policy, "clawhub", "clawhub.ai");
      expect(clawhub).toMatchObject({ allow_encoded_slash: true });
      expect(
        allEndpoints(policy)
          .filter((candidate) => candidate.allow_encoded_slash === true)
          .map((candidate) => candidate.host),
      ).toEqual(["clawhub.ai"]);

      expect(binaries(policy, "npm_registry")).toEqual(["/usr/local/bin/openclaw"]);
      expect(JSON.stringify(networkPolicies)).not.toContain("/usr/local/bin/claude");

      const defaultHosts = new Set(allEndpoints(policy).map((candidate) => candidate.host));
      for (const optInHost of [
        "github.com",
        "api.github.com",
        "sentry.io",
        "api.telegram.org",
        "discord.com",
        "gateway.discord.gg",
        "slack.com",
      ]) {
        expect(defaultHosts, optInHost).not.toContain(optInHost);
      }
    } finally {
      prepared.cleanup?.();
    }
  });

  it("keeps permissive OpenClaw compatibility routes after create-policy preparation", () => {
    const prepared = prepareInitialSandboxCreatePolicy(PERMISSIVE_POLICY_PATH.pathname, [], {
      agentName: "openclaw",
    });
    try {
      const consumed = policies.mergePresetNamesIntoPolicy(
        readFileSync(prepared.policyPath, "utf-8"),
        [],
        { agent: "openclaw" },
      );
      const policy = parseEffectivePolicy(consumed.policy);
      const managedInference = endpoint(policy, "managed_inference", "inference.local");

      expect(managedInference).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        access: "full",
      });
      expect(binaries(policy, "managed_inference")).toEqual(["/**"]);

      const clawhub = endpoint(policy, "clawhub", "clawhub.ai");
      expect(clawhub).toMatchObject({
        protocol: "rest",
        enforcement: "enforce",
        access: "full",
        allow_encoded_slash: true,
      });
    } finally {
      prepared.cleanup?.();
    }
  });

  it("keeps Hermes inference and package access narrow after create-policy preparation", () => {
    const prepared = prepareInitialSandboxCreatePolicy(HERMES_POLICY_PATH.pathname, [], {
      agentName: "hermes",
    });
    try {
      const consumed = policies.mergePresetNamesIntoPolicy(
        readFileSync(prepared.policyPath, "utf-8"),
        [],
        { agent: "hermes" },
      );
      const policy = parseEffectivePolicy(consumed.policy);
      const managedInference = endpoint(policy, "managed_inference", "inference.local");

      expect(managedInference).toMatchObject({
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
      });
      expect(managedInference).not.toHaveProperty("access");
      expect(managedInference.rules).toEqual([
        { allow: { method: "POST", path: "/v1/chat/completions" } },
        { allow: { method: "POST", path: "/v1/messages" } },
        { allow: { method: "POST", path: "/v1/responses" } },
        { allow: { method: "POST", path: "/v1/completions" } },
        { allow: { method: "POST", path: "/v1/embeddings" } },
        { allow: { method: "GET", path: "/v1/models" } },
        { allow: { method: "GET", path: "/v1/models/**" } },
      ]);
      expect(binaries(policy, "managed_inference")).toEqual(
        ["/opt/hermes/.venv/bin/python", "/usr/bin/python3.11", "/usr/local/bin/hermes"].sort(),
      );

      const hosts = new Set(allEndpoints(policy).map((candidate) => candidate.host));
      expect(hosts).not.toContain("github.com");
      expect(hosts).not.toContain("api.github.com");

      const pypi = policy.network_policies?.pypi;
      for (const candidate of pypi?.endpoints ?? []) {
        expect(methods(candidate)).toEqual(["GET"]);
      }
      expect(binaries(policy, "pypi")).toEqual(
        expect.arrayContaining([
          "/opt/hermes/.venv/bin/python",
          "/usr/bin/curl",
          "/usr/bin/python3*",
          "/usr/local/bin/curl",
          "/usr/local/bin/pip3",
        ]),
      );
    } finally {
      prepared.cleanup?.();
    }
  });

  it("applies optional source-control and package presets through the production merge path", () => {
    const prepared = prepareInitialSandboxCreatePolicy(BASE_POLICY_PATH.pathname, [], {
      agentName: "openclaw",
      additionalPresets: ["github", "huggingface", "jira"],
    });
    try {
      const consumed = policies.mergePresetNamesIntoPolicy(
        readFileSync(prepared.policyPath, "utf-8"),
        [],
        { agent: "openclaw" },
      );
      const policy = parseEffectivePolicy(consumed.policy);

      expect(prepared.appliedPresets).toEqual(["github", "huggingface", "jira"]);
      expect(consumed.missingPresets).toEqual([]);
      expect(binaries(policy, "github")).toEqual(["/usr/bin/git"]);

      const huggingface = endpoint(policy, "huggingface", "huggingface.co");
      expect(methods(huggingface)).toContain("GET");
      expect(methods(huggingface)).not.toContain("POST");

      expect(binaries(policy, "atlassian")).toEqual(["/usr/bin/node", "/usr/local/bin/node"]);
      expect(binaries(policy, "atlassian")).not.toContain("/usr/bin/curl");
      expect(binaries(policy, "atlassian")).not.toContain("/usr/local/bin/curl");
    } finally {
      prepared.cleanup?.();
    }
  });
});
