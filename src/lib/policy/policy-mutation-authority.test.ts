// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import fs from "node:fs";

const mocks = vi.hoisted(() => ({
  addCustomPolicy: vi.fn(),
  beginBaselineExclusionTransition: vi.fn(),
  getBaselineExclusions: vi.fn(),
  getBaselineExclusionTransition: vi.fn(),
  getSandbox: vi.fn(),
  captureSandboxBasePolicy: vi.fn(),
  inspectSandboxPolicyAuthority: vi.fn(),
  inspectOpenShellSandboxIdentityFingerprint: vi.fn(),
  compareAndSetSandboxPolicyCreationReceipt: vi.fn(),
  resolveOpenshell: vi.fn(),
  run: vi.fn(),
  runCapture: vi.fn(),
  updateSandbox: vi.fn(),
}));

vi.mock("../adapters/openshell/policy-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/openshell/policy-authority")>()),
  captureSandboxBasePolicy: mocks.captureSandboxBasePolicy,
  inspectOpenShellSandboxIdentityFingerprint: mocks.inspectOpenShellSandboxIdentityFingerprint,
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
  compareAndSetSandboxPolicyCreationReceipt: mocks.compareAndSetSandboxPolicyCreationReceipt,
  getBaselineExclusions: mocks.getBaselineExclusions,
  getBaselineExclusionTransition: mocks.getBaselineExclusionTransition,
  getSandbox: mocks.getSandbox,
  updateSandbox: mocks.updateSandbox,
}));

import {
  applyPermissivePolicy,
  applyPresetContent,
  excludeBaselineEntry,
  inspectPolicyMutationAuthority,
  inspectPolicyRecoveryAuthority,
  recheckPolicyMutationAuthority,
  removePreset,
  restoreBaselineEntry,
} from "./index";
import { PolicyAuthorityRefusalError } from "../adapters/openshell/policy-authority";

const SANDBOX = "authority-9833";
const GATEWAY_PORT = 8080;
const LIFECYCLE_GENERATION = "00000000-0000-4000-8000-000000000001";
const SANDBOX_IDENTITY = "a".repeat(64);
const INITIAL_POLICY_HASH = "policy-initial";
const UPDATED_POLICY_HASH = "policy-updated";
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
  let livePolicyHash: string;
  let liveBasePolicy: string;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    sandbox = {
      name: SANDBOX,
      gatewayName: "nemoclaw",
      gatewayPort: GATEWAY_PORT,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      lifecycleLiveIdentityFingerprint: SANDBOX_IDENTITY,
      policyAuthority: "nemoclaw-managed",
      policyCreationReceipt: {
        schemaVersion: 1,
        origin: "sandbox-create",
        gatewayName: "nemoclaw",
        gatewayPort: GATEWAY_PORT,
        sandboxName: SANDBOX,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        sandboxIdentityFingerprint: SANDBOX_IDENTITY,
        policyHash: INITIAL_POLICY_HASH,
        policyVersion: 1,
      },
      policies: [],
    };
    livePolicyHash = INITIAL_POLICY_HASH;
    liveBasePolicy = BASE_POLICY;
    mocks.getSandbox.mockImplementation(() => sandbox);
    mocks.getBaselineExclusions.mockReturnValue([]);
    mocks.getBaselineExclusionTransition.mockReturnValue(null);
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "owner-unknown",
      effectivePolicy: {},
      policyIdentity: { hash: livePolicyHash, activeVersion: 1 },
    });
    mocks.inspectSandboxPolicyAuthority.mockImplementation(() => ({
      authority: "owner-unknown",
      effectivePolicy: {},
      policyIdentity: { hash: livePolicyHash, activeVersion: 1 },
    }));
    mocks.inspectOpenShellSandboxIdentityFingerprint.mockReturnValue(SANDBOX_IDENTITY);
    mocks.captureSandboxBasePolicy.mockImplementation(() => liveBasePolicy);
    mocks.resolveOpenshell.mockReturnValue("/usr/local/bin/openshell");
    mocks.runCapture.mockImplementation(() => liveBasePolicy);
    mocks.run.mockImplementation((command: readonly string[]) => {
      const policyFlag = command.indexOf("--policy");
      expect(policyFlag).toBeGreaterThanOrEqual(0);
      liveBasePolicy = fs.readFileSync(command[policyFlag + 1] as string, "utf8");
      livePolicyHash = UPDATED_POLICY_HASH;
      return { status: 0 };
    });
    mocks.updateSandbox.mockImplementation((_name, updates) => {
      sandbox = { ...sandbox, ...updates };
      return true;
    });
    mocks.compareAndSetSandboxPolicyCreationReceipt.mockImplementation(
      (_name, expected, replacement) => {
        expect(sandbox.policyCreationReceipt).toEqual(expected);
        sandbox = { ...sandbox, policyCreationReceipt: replacement };
        return true;
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("verifies an externally supplied preset without recording authority (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "externally-managed" };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: { weather: WEATHER_POLICY } },
      policyIdentity: { hash: INITIAL_POLICY_HASH, activeVersion: 1 },
    });

    expect(
      applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, {
        custom: { sourcePath: "/tmp/weather.yaml" },
      }),
    ).toBe(true);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.addCustomPolicy).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("reads verified global authority without changing the registry (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "externally-managed" };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: { network_policies: { weather: WEATHER_POLICY } },
      policyIdentity: { hash: INITIAL_POLICY_HASH, activeVersion: 1 },
    });

    expect(inspectPolicyRecoveryAuthority(SANDBOX, "verify Shields recovery")).toMatchObject({
      authority: "externally-managed",
      authorityRecordedNow: false,
      gatewayName: "nemoclaw",
    });
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });

  it("rotates the receipt after a matching policy mutation (#9833)", () => {
    mocks.captureSandboxBasePolicy.mockImplementation(
      () => `Version: 2\nHash: updated\nStatus: Effective\n---\n${liveBasePolicy}`,
    );

    expect(
      applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, {
        custom: { sourcePath: "/tmp/weather.yaml" },
      }),
    ).toBe(true);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.captureSandboxBasePolicy).toHaveBeenCalledWith(SANDBOX, "nemoclaw");
    expect(mocks.compareAndSetSandboxPolicyCreationReceipt).toHaveBeenCalledOnce();
    expect(sandbox.policyCreationReceipt).toEqual(
      expect.objectContaining({ policyHash: UPDATED_POLICY_HASH, policyVersion: 1 }),
    );
    expect(mocks.addCustomPolicy).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith("  Applied preset: weather");
  });

  it.each([
    ["missing", undefined],
    ["pending", { schemaVersion: 1, origin: "pending-sandbox-create" }],
    ["malformed", { schemaVersion: 1, origin: "sandbox-create" }],
  ])("refuses a sandbox policy with a %s receipt before mutation (#9833)", (_label, receipt) => {
    sandbox = { ...sandbox, policyCreationReceipt: receipt };

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("policy creation receipt");
  });

  it("refuses a replacement sandbox before mutation (#9833)", () => {
    mocks.inspectOpenShellSandboxIdentityFingerprint.mockReturnValue("b".repeat(64));

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("live sandbox identity");
  });

  it.each([
    ["gateway", { gatewayName: "replacement-gateway" }],
    ["lifecycle", { lifecycleGeneration: "00000000-0000-4000-8000-000000000099" }],
  ])("refuses a receipt bound to a different %s (#9833)", (_label, replacement) => {
    sandbox = {
      ...sandbox,
      policyCreationReceipt: {
        ...(sandbox.policyCreationReceipt as Record<string, unknown>),
        ...replacement,
      },
    };

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("policy creation receipt");
  });

  it("refuses a stable out-of-band policy update before mutation (#9833)", () => {
    livePolicyHash = "policy-external-change";
    liveBasePolicy = `${BASE_POLICY}
  external_approval:
    endpoints:
      - host: approved.example.com
        port: 443
`;

    const result = applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true });
    expect(result).toBe(false);

    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.compareAndSetSandboxPolicyCreationReceipt).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("creation receipt does not match the live sandbox policy");
  });

  it("refuses live policy drift between inspection and mutation (#9833)", () => {
    const recorded = inspectPolicyMutationAuthority(SANDBOX, "apply a policy preset");
    livePolicyHash = "policy-concurrent-change";

    expect(() =>
      recheckPolicyMutationAuthority(SANDBOX, "apply a policy preset", recorded),
    ).toThrow(/creation receipt does not match the live sandbox policy/u);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses a registry receipt that changes during live verification (#9833)", () => {
    mocks.getSandbox.mockReturnValueOnce(sandbox).mockReturnValueOnce({
      ...sandbox,
      policyCreationReceipt: {
        ...(sandbox.policyCreationReceipt as Record<string, unknown>),
        policyHash: "concurrent-registry-change",
      },
    });

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);

    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(reportedErrors()).toContain("changed during live verification");
  });

  it("reports an incomplete update when receipt rotation fails (#9833)", () => {
    mocks.compareAndSetSandboxPolicyCreationReceipt.mockReturnValue(false);

    expect(applyPresetContent(SANDBOX, "weather", WEATHER_PRESET, { nonFatal: true })).toBe(false);

    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.addCustomPolicy).not.toHaveBeenCalled();
    expect(sandbox.policyCreationReceipt).toEqual(
      expect.objectContaining({ policyHash: INITIAL_POLICY_HASH }),
    );
    expect(reportedErrors()).toContain("policy update is incomplete");
  });

  it("refuses external and owner-unknown mutations before side effects (#9833)", () => {
    sandbox = { ...sandbox, policyAuthority: "externally-managed" };
    mocks.inspectSandboxPolicyAuthority.mockReturnValue({
      authority: "externally-managed",
      effectivePolicy: {},
      policyIdentity: { hash: INITIAL_POLICY_HASH, activeVersion: 1 },
    });

    expect(removePreset(SANDBOX, "weather", { nonFatal: true })).toBe(false);
    expect(excludeBaselineEntry(SANDBOX, "existing", "reviewed-digest", { nonFatal: true })).toBe(
      false,
    );
    expect(restoreBaselineEntry(SANDBOX, "existing", { nonFatal: true })).toBe(false);
    expect(() => applyPermissivePolicy(SANDBOX)).toThrow(PolicyAuthorityRefusalError);

    expect(mocks.getBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.beginBaselineExclusionTransition).not.toHaveBeenCalled();
    expect(mocks.runCapture).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateSandbox).not.toHaveBeenCalled();
  });
});
