// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  assertMcpAdapterConfigMutationsAllowed: vi.fn(),
  classifyDestroySandboxPresence: vi.fn(() => "present"),
  getSandbox: vi.fn(),
  runOpenshell: vi.fn(() => ({ status: 0, stdout: "[]", stderr: "" })),
}));

vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterConfigMutationsAllowed: mocks.assertMcpAdapterConfigMutationsAllowed,
}));

vi.mock("./destroy-gateway", () => ({
  selectGatewayForSandboxDestroy: vi.fn(),
}));

vi.mock("./destroy-presence", () => ({
  classifyDestroySandboxPresence: mocks.classifyDestroySandboxPresence,
}));

vi.mock("./gateway-target", () => ({
  getSandboxTargetGatewayName: vi.fn(() => "nemoclaw"),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
}));

import { prepareSandboxDestroy } from "./destroy-preflight";

const ENTRY = { server: "github", adapter: "mcporter" } as McpBridgeEntry;
const SANDBOX = { name: "alpha", mcp: { bridges: { github: ENTRY } } } as unknown as SandboxEntry;

// #10469: this early refusal exists so a destroy that cannot mutate the live
// adapter config fails before any local service is stopped. `--force` accepts
// leaving the retained-volume entry behind, so it must not be blocked here —
// otherwise the escape hatch never reaches the preparation phase that reports
// what it kept.
describe("prepareSandboxDestroy MCP config preflight", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.assertMcpAdapterConfigMutationsAllowed.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(SANDBOX);
    mocks.classifyDestroySandboxPresence.mockReset().mockReturnValue("present");
  });

  it("asserts the live config is mutable for a plain destroy", () => {
    prepareSandboxDestroy("alpha");
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).toHaveBeenCalledTimes(1);
  });

  it("propagates the refusal for a plain destroy", () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error("shields up or an unreadable shields posture");
    });
    expect(() => prepareSandboxDestroy("alpha")).toThrow(/shields up/);
  });

  it("skips the early refusal under --force", () => {
    mocks.assertMcpAdapterConfigMutationsAllowed.mockImplementation(() => {
      throw new Error("shields up or an unreadable shields posture");
    });
    expect(() => prepareSandboxDestroy("alpha", { force: true })).not.toThrow();
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).not.toHaveBeenCalled();
  });

  it("skips the assertion when the sandbox is already absent", () => {
    // Regression lock: the absent branch has its own retained-volume handling
    // and must keep bypassing this preflight.
    mocks.classifyDestroySandboxPresence.mockReturnValue("absent");
    prepareSandboxDestroy("alpha");
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).not.toHaveBeenCalled();
  });

  it("skips the assertion when no MCP bridges are registered", () => {
    mocks.getSandbox.mockReturnValue({ name: "alpha" } as SandboxEntry);
    prepareSandboxDestroy("alpha");
    expect(mocks.assertMcpAdapterConfigMutationsAllowed).not.toHaveBeenCalled();
  });
});
