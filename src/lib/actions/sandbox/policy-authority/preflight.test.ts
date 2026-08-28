// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as policyAuthority from "../../../adapters/openshell/policy-authority";
import type { SandboxEntry } from "../../../state/registry";
import * as registry from "../../../state/registry";
import { preflightSandboxPolicyAuthority } from "./preflight";

const REQUIRED_POLICY = [
  "network_policies:",
  "  messaging_api:",
  "    endpoints:",
  "      - host: api.example.test",
  "        port: 443",
  "",
].join("\n");

describe("sandbox policy authority preflight", () => {
  let current: SandboxEntry;
  let updateSandbox: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    current = { name: "alpha", gatewayName: "nemoclaw" } as SandboxEntry;
    vi.spyOn(registry, "getSandbox").mockImplementation(() => current);
    updateSandbox = vi.spyOn(registry, "updateSandbox").mockImplementation((_name, update) => {
      current = { ...current, ...update } as SandboxEntry;
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records external authority after every required entry matches (#9833)", () => {
    const inspect = vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: {
        network_policies: {
          messaging_api: {
            endpoints: [{ host: "api.example.test", port: 443 }],
          },
        },
      },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    });

    expect(
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "add channel 'example'",
        requiredPolicyContents: [REQUIRED_POLICY],
        sandboxName: "alpha",
      }),
    ).toBe("externally-managed");

    expect(inspect).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
    });
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
  });

  it("records external authority before rejecting a missing entry (#9833)", () => {
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: {} },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    });

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "add channel 'example'",
        requiredPolicyContents: [REQUIRED_POLICY],
        sandboxName: "alpha",
      }),
    ).toThrow(/missing entries "messaging_api"/);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
  });

  it("rejects policy authority drift before recording state (#9833)", () => {
    current = { ...current, policyAuthority: "nemoclaw-managed" };
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: {} },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    });

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "start channel 'example'",
        requiredPolicyContents: [REQUIRED_POLICY],
        sandboxName: "alpha",
      }),
    ).toThrow(/policy authority changed/);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("propagates an inconclusive policy inspection before recording state (#9833)", () => {
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockImplementation(() => {
      throw new Error("OpenShell returned an unknown policy source");
    });

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "add channel 'example'",
        requiredPolicyContents: [REQUIRED_POLICY],
        sandboxName: "alpha",
      }),
    ).toThrow(/unknown policy source/);
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("records external authority before refusing removal (#9833)", () => {
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: {} },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    });

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "refuse",
        operation: "remove channel 'example'",
        sandboxName: "alpha",
      }),
    ).toThrow(/externally managed/);
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
  });

  it("records NemoClaw authority without requiring external entries (#9833)", () => {
    vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority").mockReturnValue({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
      policyIdentity: { hash: "managed-policy", activeVersion: 1 },
    });

    expect(
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "restart managed MCP servers",
        sandboxName: "alpha",
      }),
    ).toBe("nemoclaw-managed");
    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "nemoclaw-managed",
    });
  });

  it("rejects an invalid required policy before inspecting or recording authority (#9833)", () => {
    const inspect = vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority");

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "add channel 'example'",
        requiredPolicyContents: ["network_policies: [invalid]"],
        sandboxName: "alpha",
      }),
    ).toThrow(/required network policy document is invalid/);
    expect(inspect).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects an empty required policy before inspecting or recording authority (#9833)", () => {
    const inspect = vi.spyOn(policyAuthority, "inspectSandboxPolicyAuthority");

    expect(() =>
      preflightSandboxPolicyAuthority({
        externalPolicy: "verify",
        operation: "add channel 'example'",
        requiredPolicyContents: ["network_policies: {}"],
        sandboxName: "alpha",
      }),
    ).toThrow(/required network policy document is invalid/);
    expect(inspect).not.toHaveBeenCalled();
    expect(updateSandbox).not.toHaveBeenCalled();
  });
});
