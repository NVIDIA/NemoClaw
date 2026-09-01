// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppliedPresets: vi.fn(),
  getGatewayPresets: vi.fn(),
  listCustomPresets: vi.fn(),
  listPresets: vi.fn(),
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  getAppliedPresets: mocks.getAppliedPresets,
  getGatewayPresets: mocks.getGatewayPresets,
  listCustomPresets: mocks.listCustomPresets,
  listPresets: mocks.listPresets,
}));

import { listSandboxPolicies } from "./policy-channel";

function output(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .join("\n");
}

describe("policy list live state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.listPresets.mockReturnValue([
      { file: "npm.yaml", name: "npm", description: "npm registry" },
      { file: "pypi.yaml", name: "pypi", description: "Python packages" },
    ]);
    mocks.listCustomPresets.mockReturnValue([]);
    mocks.getAppliedPresets.mockReturnValue(["npm"]);
    mocks.getGatewayPresets.mockReturnValue(["npm"]);
  });

  it("marks presets from the current OpenShell policy as active", () => {
    listSandboxPolicies("alpha");
    expect(output()).toContain("● npm [user-added]");
    expect(output()).toContain("○ pypi");
  });

  it("lists namespaced custom presets derived from live policy", () => {
    mocks.listCustomPresets.mockReturnValue([
      { file: "corp.yaml", name: "corp", description: "custom OpenShell policy" },
    ]);
    mocks.getAppliedPresets.mockReturnValue(["corp"]);
    mocks.getGatewayPresets.mockReturnValue(["corp"]);
    listSandboxPolicies("alpha");
    expect(output()).toContain("● corp [user-added]");
  });

  it("does not report a durable baseline exclusion or repair ledger", () => {
    listSandboxPolicies("alpha");
    expect(output()).not.toContain("repair required");
    expect(output()).not.toContain("Baseline exclusions");
  });
});
