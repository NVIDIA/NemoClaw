// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  executeGatewaySupervisorAction: vi.fn(),
  isShieldsDown: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
}));

vi.mock("../../adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../../shields", () => ({
  isShieldsDown: mocks.isShieldsDown,
}));

import {
  assertAgentMcpConfigMutationAllowed,
  assertAgentMcpTeardownRuntimeCapability,
} from "./mcp-bridge-adapters";
import { assertOpenClawMcpConfigMutationAllowed } from "./mcp-bridge-adapter-openclaw";

// #10469: Mcporter's managed project config is
// `/sandbox/.openclaw/workspace/config/mcporter.json`, and `workspace` is a
// `readOnlyRoots` entry in `agents/openclaw/state-lock-plan.json`. With shields
// up the state-dir guard re-owns that subtree to `root:sandbox` and clears the
// group write bit, so every in-sandbox `mcporter config` write fails. Before
// this guard existed the raw Node error escaped as
// `EACCES: permission denied, open '/sandbox/.openclaw/workspace/config/mcporter.json'`.
describe("OpenClaw MCP config mutation posture (#10469)", () => {
  beforeEach(() => {
    mocks.isShieldsDown.mockReset();
  });

  it("allows a mutation while the config is mutable", () => {
    mocks.isShieldsDown.mockReturnValue(true);
    expect(() => assertOpenClawMcpConfigMutationAllowed("alpha")).not.toThrow();
    expect(mocks.isShieldsDown).toHaveBeenCalledWith("alpha", false);
  });

  it("refuses a mutation while Shields are up and keeps the posture probe read-only (#10469)", () => {
    mocks.isShieldsDown.mockReturnValue(false);
    expect(() => assertOpenClawMcpConfigMutationAllowed("alpha")).toThrow(
      /shields up or an unreadable shields posture/,
    );
    expect(() => assertOpenClawMcpConfigMutationAllowed("alpha")).toThrow(
      '`nemoclaw alpha shields down --timeout 15m --reason "MCP maintenance"`',
    );
    // `false` keeps the probe read-only: a mutation preflight must never repair
    // the posture it is inspecting.
    expect(mocks.isShieldsDown).toHaveBeenCalledWith("alpha", false);
  });
});

describe("assertAgentMcpConfigMutationAllowed adapter routing", () => {
  beforeEach(() => {
    mocks.isShieldsDown.mockReset();
  });

  it("routes the mcporter adapter through the OpenClaw posture check", () => {
    mocks.isShieldsDown.mockReturnValue(false);
    expect(() => assertAgentMcpConfigMutationAllowed("alpha", "mcporter")).toThrow(
      /OpenClaw sandbox 'alpha' has shields up/,
    );
  });

  it("lets the mcporter adapter through once the config is mutable", () => {
    mocks.isShieldsDown.mockReturnValue(true);
    expect(() => assertAgentMcpConfigMutationAllowed("alpha", "mcporter")).not.toThrow();
  });

  it("keeps the Hermes adapter on its own posture check", () => {
    mocks.isShieldsDown.mockReturnValue(false);
    expect(() => assertAgentMcpConfigMutationAllowed("alpha", "hermes-config")).toThrow(
      /Hermes sandbox 'alpha' has shields up/,
    );
  });

  it("guards the mcporter teardown capability probe too (#10469)", () => {
    // `mcp remove` calls this before any provider, policy, or adapter side
    // effect, and reaches it through the same predicate, so a locked config
    // refuses there as well. `--force` does not bypass it: the ownership state
    // is preserved for a retry once shields are down.
    mocks.isShieldsDown.mockReturnValue(false);
    expect(() => assertAgentMcpTeardownRuntimeCapability("alpha", "mcporter")).toThrow(
      /OpenClaw sandbox 'alpha' has shields up/,
    );
  });

  it("leaves the Deep Agents adapter unguarded regardless of posture", () => {
    // Regression lock: `/sandbox/.deepagents/.nemoclaw-mcp.json` sits outside
    // any recursive state lock — the agent ships no `state-lock-plan.json` — and
    // teardown of a legacy entry must stay possible on an older image.
    mocks.isShieldsDown.mockReturnValue(false);
    expect(() => assertAgentMcpConfigMutationAllowed("alpha", "deepagents-config")).not.toThrow();
    expect(mocks.isShieldsDown).not.toHaveBeenCalled();
  });
});
