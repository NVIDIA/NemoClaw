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

it.each(
  ["0.0.116", "0.1.5"].flatMap((version) =>
    [false, true].map((directGpu) => ({ version, directGpu })),
  ),
)(
  "allows Hermes DRM discovery without sysfs writes on $version with directGpu=$directGpu",
  ({ version, directGpu }) => {
    runtime.version = version;
    const source = path.resolve(
      import.meta.dirname,
      "../../../agents/hermes/policy-additions.yaml",
    );
    const policy = prepareInitialSandboxCreatePolicy(source, [], {
      agentName: "hermes",
      directGpu,
      stationGb300SysfsReadOnlyPaths: [],
    });
    try {
      const effective = YAML.parse(fs.readFileSync(policy.policyPath, "utf8"));
      const readOnly: string[] = effective.filesystem_policy.read_only;
      const readWrite: string[] = effective.filesystem_policy.read_write;
      expect(
        readOnly.filter((entry) => entry === "/" || entry === "/sys" || entry.startsWith("/sys/")),
      ).toEqual(["/sys/class/drm"]);
      expect(
        readWrite.filter((entry) => entry === "/" || entry === "/sys" || entry.startsWith("/sys/")),
      ).toEqual([]);
      expect(effective.landlock.compatibility).toBe("best_effort");
    } finally {
      policy.cleanup?.();
    }
    expect(fs.existsSync(policy.policyPath)).toBe(policy.policyPath === source);
  },
);

it.each([
  { agent: "langchain-deepagents-code", version: "0.0.116", mode: "unchanged" },
  { agent: "langchain-deepagents-code", version: "0.1.3", mode: "hard_requirement" },
  { agent: "langchain-deepagents-code", version: "0.1.5", mode: "hard_requirement" },
  { agent: "pi", version: "0.0.116", mode: "unchanged" },
  { agent: "pi", version: "0.1.3", mode: "hard_requirement" },
  { agent: "pi", version: "0.1.5", mode: "hard_requirement" },
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
    expect(effective.landlock).toEqual({
      ...baseline.landlock,
      compatibility: mode === "unchanged" ? baseline.landlock.compatibility : mode,
    });
    expect(effective.filesystem_policy).toEqual(baseline.filesystem_policy);
    expect(fs.readFileSync(source, "utf8")).toBe(original);
  } finally {
    policy.cleanup?.();
  }
  expect(fs.existsSync(policy.policyPath)).toBe(policy.policyPath === source);
});
