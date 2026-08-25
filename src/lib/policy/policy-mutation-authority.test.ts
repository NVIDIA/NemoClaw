// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const mocks = vi.hoisted(() => ({
  addCustomPolicy: vi.fn(),
  beginBaselineExclusionTransition: vi.fn(),
  getBaselineExclusions: vi.fn(),
  getBaselineExclusionTransition: vi.fn(),
  getSandbox: vi.fn(),
  inspectSandboxPolicyAuthority: vi.fn(),
  resolveOpenshell: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-authority")>()),
  inspectSandboxPolicyAuthority: mocks.inspectSandboxPolicyAuthority,
}));

vi.mock("../adapters/openshell/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/resolve")>()),
  resolveOpenshell: mocks.resolveOpenshell,
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  run: mocks.run,
  runCapture: mocks.runCapture,
}));

vi.mock("../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/registry")>()),
  addCustomPolicy: mocks.addCustomPolicy,
  beginBaselineExclusionTransition: mocks.beginBaselineExclusionTransition,
  getBaselineExclusions: mocks.getBaselineExclusions,
  getBaselineExclusionTransition: mocks.getBaselineExclusionTransition,
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));

import {
  applyPermissivePolicy,
  applyPresetContent,
  excludeBaselineEntry,
  inspectPolicyRecoveryAuthority,
  removePreset,
  restoreBaselineEntry,
} from "./index";
import { PolicyAuthorityRefusalError } from "../adapters/openshell/policy-authority";

const SANDBOX = "authority-9833";
const BASE_POLICY = `version: 1
network_policies:
  existing:
    endpoints:
      - host: existing.example.com
        port: 443
`;
const WEATHER_PRESET = `preset:
  name: weather
  description: Read-only weather
network_policies:
  weather:
    name: weather
    endpoints:
      - host: wttr.in
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
`;
const WEATHER_POLICY = YAML.parse(WEATHER_PRESET).network_policies.weather;

function reportedErrors(): string {
  return vi
    .mocked(console.error)
    .mock.calls.flat()
    .map((entry) => String(entry))
    .join("\n");
}

describe("PolicyMutationAuthority", () => {
  let sandbox: Record<string, unknown>;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    sandbox = {
      name: SANDBOX,
      gatewayName: "nemoclaw",
      policies: [],
    };
    mocks.getSandbox.mockImplementation(() => sandbox);
    mocks.getBaselineExclusions.mockReturnValue([]);
    mocks.getBaselineExclusionTransition.mockReturnValue(null);
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "nemoclaw-managed",
      effectivePolicy: {},
    });
    mocks.resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    mocks.runCapture.mockReturnValue(BASE_POLICY);
    mocks.run.mockReturnValue({ status: 0 });
    mocks.updateSandbox.mockImplementation((_name, updates) => {
      sandbox = { ...sandbox, ...updates };
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("accepts an externally supplied custom preset without setting or attributing it (#9833)", () => {
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: { weather: WEATHER_POLICY } },
    });

    expect(
      applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, {
        custom: { sourcePath: "/tmp/weather.yaml" },
      }),
    ).toBe(true);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.addCustomPolicy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.updateSandbox).toHaveBeenCalledWith(SANDBOX, {
      policyAuthority: "externally-managed",
    });
  });

  it("records external authority before refusing a missing preset requirement (#9833)", () => {
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: {} },
    });

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET)).toBe(false);

    expect(reportedErrors()).toContain("external policy authority");
    expect(reportedErrors()).toContain('"weather"');
    expect(reportedErrors()).not.toContain("wttr.in");
    expect(reportedErrors()).not.toContain("network_policies:");
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).toHaveBeenCalledOnce();
    expect(sandbox).toEqual(
      expect.objectContaining({ policyAuthority: "externally-managed", policies: [] }),
    );
  });

  it("reads external recovery authority without replacing the durable owner (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "nemoclaw-managed" };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: { weather: WEATHER_POLICY } },
    });

    expect(inspectPolicyRecoveryAuthority(SANDBOX, "verify Shields recovery")).toMatchObject({
      authority: "externally-managed",
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
    });
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks authority before policy set and refuses an ownership change (#9833)", () => {
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);

    expect(mocks.inspectSandboxPolicyAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.runCapture).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).toHaveBeenCalledOnce();
    expect(sandbox).toEqual(
      expect.objectContaining({ policyAuthority: "nemoclaw-managed", policies: [] }),
    );
    expect(reportedErrors()).toContain("policy authority changed");
    expect(reportedErrors()).toContain("external policy authority");
  });

  it("withholds single-preset success when the final registry check changes authority (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "nemoclaw-managed" };
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(
      applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, {
        custom: { sourcePath: "/tmp/weather.yaml" },
      }),
    ).toBe(false);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.addCustomPolicy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith("  Applied preset: weather");
    expect(reportedErrors()).toContain("policy authority changed");
  });

  it("refuses external removal before reading or changing policy state (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "externally-managed", policies: ["weather"] };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: { weather: WEATHER_POLICY } },
    });

    expect(removePreset(SANDBOX, "weather", { nonFatal: true })).toBe(false);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("external policy authority");
  });

  it("refuses external baseline and permissive changes before side effects (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "externally-managed" };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: {},
    });

    expect(excludeBaselineEntry(SANDBOX, "existing", "reviewed-digest", { nonFatal: true })).toBe(
      false,
    );
    expect(restoreBaselineEntry(SANDBOX, "existing", { nonFatal: true })).toBe(false);
    expect(() => applyPermissivePolicy(SANDBOX)).toThrow(/external policy authority/);

    expect(mocks.getBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.beginBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("throws when permissive policy authority changes after the policy set (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "nemoclaw-managed" };
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(() => applyPermissivePolicy(SANDBOX)).toThrow(/policy authority changed/u);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalledWith("  Applied permissive policy.");
  });

  it("throws a typed refusal when permissive policy authority changes before submission (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "nemoclaw-managed" };
    mocks.inspectSandboxPolicyAuthority
      .mockReturnValueOnce({ authority: "nemoclaw-managed", effectivePolicy: {} })
      .mockReturnValueOnce({ authority: "externally-managed", effectivePolicy: {} });

    expect(() => applyPermissivePolicy(SANDBOX)).toThrow(PolicyAuthorityRefusalError);

    expect(mocks.inspectSandboxPolicyAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith("  Applied permissive policy.");
    expect(reportedErrors()).toBe("");
  });
});
