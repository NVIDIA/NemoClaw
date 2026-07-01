// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const requireForTest = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

type PolicyRule = { allow?: { method?: string; path?: string } };
type PolicyEndpoint = { host?: string; rules?: PolicyRule[] };
type PolicyDocument = {
  network_policies?: Record<string, { endpoints?: PolicyEndpoint[] }>;
};

function rulesFor(policy: PolicyDocument, policyName: string, host: string) {
  return (policy.network_policies?.[policyName]?.endpoints ?? [])
    .filter((endpoint) => endpoint.host === host)
    .flatMap((endpoint) => endpoint.rules ?? [])
    .map((rule) => rule.allow)
    .filter((rule): rule is { method: string; path: string } =>
      Boolean(rule?.method && rule?.path),
    );
}

function sortRules(rules: Array<{ method: string; path: string }>) {
  return [...rules].sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

describe("Hermes Discord policy", () => {
  it("scopes REST mutations to discord.com when merged for Hermes", () => {
    const result = policies.mergePresetNamesIntoPolicy("", ["discord"], { agent: "hermes" });
    expect(result.appliedPresets).toEqual(["discord"]);
    expect(result.missingPresets).toEqual([]);
    const policy = YAML.parse(result.policy) as PolicyDocument;

    expect(
      rulesFor(policy, "nous_research", "nousresearch.com").filter((rule) =>
        ["PUT", "PATCH", "DELETE"].includes(rule.method),
      ),
    ).toEqual([]);

    const discordMutationRules = sortRules(
      rulesFor(policy, "discord", "discord.com").filter((rule) =>
        ["PUT", "PATCH", "DELETE"].includes(rule.method),
      ),
    );
    expect(discordMutationRules).toEqual(
      sortRules([
        { method: "PUT", path: "/api/v*/applications/*/commands" },
        { method: "PUT", path: "/api/v*/channels/*/messages/*/reactions/*/@me" },
        { method: "PATCH", path: "/api/v*/applications/*" },
        { method: "PATCH", path: "/api/v*/applications/*/commands/*" },
        { method: "PATCH", path: "/api/v*/channels/*/messages/*" },
        { method: "PATCH", path: "/api/v*/webhooks/*/*/messages/*" },
        { method: "DELETE", path: "/api/v*/applications/*/commands/*" },
        { method: "DELETE", path: "/api/v*/channels/*/messages/*" },
        { method: "DELETE", path: "/api/v*/channels/*/messages/*/reactions/*/*" },
        { method: "DELETE", path: "/api/v*/webhooks/*/*/messages/*" },
      ]),
    );
    expect(discordMutationRules.some((rule) => rule.path === "/**")).toBe(false);
  });
});
