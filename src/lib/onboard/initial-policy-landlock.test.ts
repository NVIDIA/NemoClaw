// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import YAML from "yaml";

const runtime = vi.hoisted(() => ({ version: "0.0.116" }));
vi.mock("./openshell-version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-version")>()),
  get SUPPORTED_OPENSHELL_FALLBACK_VERSION() {
    return runtime.version;
  },
}));

import { prepareInitialSandboxCreatePolicy } from "./initial-policy";

it.each([
  { agent: "langchain-deepagents-code", version: "0.0.116", mode: "strict" },
  { agent: "langchain-deepagents-code", version: "0.1.3", mode: "hard_requirement" },
  { agent: "pi", version: "0.0.116", mode: "strict" },
  { agent: "pi", version: "0.1.3", mode: "hard_requirement" },
])("preserves required Landlock enforcement for $agent on $version", ({ agent, version, mode }) => {
  runtime.version = version;
  const source = path.resolve(
    import.meta.dirname,
    "../../../agents",
    agent,
    "policy-additions.yaml",
  );
  const original = fs.readFileSync(source, "utf8");
  const policy = prepareInitialSandboxCreatePolicy(source, [], { agentName: agent });
  try {
    const effective = YAML.parse(fs.readFileSync(policy.policyPath, "utf8"));
    const baseline = YAML.parse(original);
    expect(effective.landlock).toEqual({ ...baseline.landlock, compatibility: mode });
    expect(effective.filesystem_policy).toEqual(baseline.filesystem_policy);
    expect(fs.readFileSync(source, "utf8")).toBe(original);
  } finally {
    policy.cleanup?.();
  }
  expect(fs.existsSync(policy.policyPath)).toBe(policy.policyPath === source);
});
