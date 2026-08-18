// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const CA_BUNDLE = "/run/nemoclaw/managed-startup-ca-bundle.pem";
const POLICY_PATHS = [
  "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
  "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
  "agents/openclaw/policy-permissive.yaml",
  "agents/hermes/policy-additions.yaml",
  "agents/hermes/policy-permissive.yaml",
  "agents/langchain-deepagents-code/policy-additions.yaml",
  "agents/pi/policy-additions.yaml",
] as const;

type Policy = {
  filesystem_policy?: {
    read_only?: string[];
    read_write?: string[];
  };
};

describe("managed startup CA policy", () => {
  it.each(POLICY_PATHS)("grants only exact read access in %s", (policyPath) => {
    const policy = YAML.parse(readFileSync(policyPath, "utf8")) as Policy;

    expect(policy.filesystem_policy?.read_only).toContain(CA_BUNDLE);
    expect(policy.filesystem_policy?.read_write ?? []).not.toContain(CA_BUNDLE);
    expect(policy.filesystem_policy?.read_write ?? []).not.toContain("/run/nemoclaw");
  });
});
