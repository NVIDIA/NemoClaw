// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../policy", () => ({
  mergePresetNamesIntoPolicy: (policy: string, presetNames: string[]) => ({
    policy: `${policy.trimEnd()}\n  slack: {}\n`,
    appliedPresets: presetNames,
    missingPresets: [],
  }),
}));

import { getNetworkPolicyNames, prepareInitialSandboxCreatePolicy } from "./initial-policy";

const tmpRoots: string[] = [];

function tmpPolicy(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-initial-policy-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "base.yaml");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("initial sandbox policy helpers", () => {
  it("returns network policy names from a policy document", () => {
    expect(getNetworkPolicyNames("version: 1\nnetwork_policies:\n  slack: {}\n  npm: {}\n")).toEqual(
      new Set(["slack", "npm"]),
    );
  });

  it("returns null when policy YAML cannot be parsed", () => {
    expect(getNetworkPolicyNames("network_policies: [unterminated")).toBeNull();
  });

  it("keeps the base policy when no channel needs a create-time preset", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    expect(prepareInitialSandboxCreatePolicy(basePolicyPath, ["telegram"])).toEqual({
      policyPath: basePolicyPath,
      appliedPresets: [],
    });
  });

  it("records an existing create-time preset without writing a temp policy", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  slack: {}\n");

    expect(prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"])).toEqual({
      policyPath: basePolicyPath,
      appliedPresets: ["slack"],
    });
  });

  it("merges missing create-time presets into a temporary policy", () => {
    const basePolicyPath = tmpPolicy("version: 1\nnetwork_policies:\n  base: {}\n");

    const prepared = prepareInitialSandboxCreatePolicy(basePolicyPath, ["slack"]);

    expect(prepared.policyPath).not.toBe(basePolicyPath);
    expect(prepared.appliedPresets).toEqual(["slack"]);
    expect(fs.readFileSync(prepared.policyPath, "utf-8")).toContain("slack");
    expect(prepared.cleanup?.()).toBe(true);
    expect(fs.existsSync(prepared.policyPath)).toBe(false);
  });
});
