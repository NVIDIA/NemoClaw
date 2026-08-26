// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  managedPolicyInspection,
  managedSandboxEntry,
  SANDBOX_IDENTITY,
} from "../../../../test/helpers/managed-policy-receipt-fixture";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { SandboxEntry } from "../../state/registry";
import {
  createOnboardPolicyAuthorityBindings,
  qualifySandboxPolicyAuthority,
  requiredOnboardPolicyPresets,
} from "./preflight";

const requiredPolicy = {
  policyPath: "/tmp/unused.yaml",
  sourceBytes: Buffer.from(
    "version: 1\nnetwork_policies:\n  required_route:\n    endpoints: [example.com]\n",
  ),
  appliedPresets: [],
};

describe("sandbox policy authority preflight", () => {
  it("normalizes a null default agent before policy preflight (#9833)", () => {
    const openclaw = { name: "openclaw" };
    const loadAgent = vi.fn(() => openclaw);
    const getAgentPolicyPath = vi.fn(() => "/unused/openclaw-policy.yaml");
    const bindings = createOnboardPolicyAuthorityBindings(
      {
        GATEWAY_NAME: "nemoclaw",
        ROOT: "/repo",
        agentDefs: { loadAgent: loadAgent as never },
        agentOnboard: { getAgentPolicyPath: getAgentPolicyPath as never },
        inspectSandboxForCreate: () => ({ existingEntry: null, liveExists: false }),
        onboardSession: {
          loadSession: () => null,
          updateSession: vi.fn(),
        },
      },
      null,
      {
        inspectActiveGlobalPolicy: () => ({ state: "absent" }),
      },
    );

    expect(() =>
      bindings.preflightPolicyRequirements({
        gatewayName: "nemoclaw",
        sandboxName: null,
        agent: null,
        selectedMessagingChannels: [],
        hermesToolGateways: [],
        gpuPassthrough: false,
        provider: null,
        webSearchConfig: null,
        observabilityEnabled: false,
        operation: "prepare the default sandbox",
      }),
    ).not.toThrow();
    expect(loadAgent).toHaveBeenCalledExactlyOnceWith("openclaw");
  });

  it("includes every final selected policy requirement (#9833)", () => {
    expect(
      requiredOnboardPolicyPresets({
        additionalPresets: ["github", "github"],
        provider: "ollama-local",
        webSearchConfig: { provider: "tavily", fetchEnabled: true },
        agentName: "langchain-deepagents-code",
        observabilityEnabled: true,
      }),
    ).toEqual(["github", "local-inference", "tavily", "observability-otlp-local"]);
  });

  it("does not require a local-inference preset for a proven route-only provider (#9833)", () => {
    expect(
      requiredOnboardPolicyPresets({
        additionalPresets: ["github"],
        provider: "vllm-local",
        hostLocalInferenceRouteOnly: true,
        webSearchConfig: null,
        agentName: "openclaw",
        observabilityEnabled: false,
      }),
    ).toEqual(["github"]);
  });

  it("uses live sandbox metadata and accepts externally supplied requirements (#9833)", () => {
    const inspectSandbox = vi.fn(() => ({
      authority: "externally-managed" as const,
      effectivePolicy: {
        network_policies: { required_route: { endpoints: ["example.com"] } },
      },
      policyIdentity: { hash: "sha256:external", activeVersion: 1 },
    }));

    const result = qualifySandboxPolicyAuthority(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        liveExists: true,
        recordedAuthorities: ["externally-managed"],
        prepareRequiredPolicy: () => requiredPolicy,
        operation: "prepare sandbox 'demo'",
      },
      {
        inspectSandboxPolicyAuthority: inspectSandbox,
      },
    );

    expect(result.authority).toBe("externally-managed");
    expect(inspectSandbox).toHaveBeenCalledWith({
      sandboxName: "demo",
      gatewayName: "nemoclaw",
    });
  });

  it.each([
    ["malformed YAML", "version: [unterminated"],
    ["non-mapping YAML", "- version: 1"],
    ["an invalid policy root", "unexpected: true"],
  ])("rejects %s through the canonical required-policy parser (#9833)", (_case, source) => {
    const cleanup = vi.fn(() => true);

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["externally-managed"],
          prepareRequiredPolicy: () => ({
            ...requiredPolicy,
            sourceBytes: Buffer.from(source),
            cleanup,
          }),
          operation: "verify external policy",
        },
        {
          inspectSandboxPolicyAuthority: () => ({
            authority: "externally-managed",
            effectivePolicy: { network_policies: {} },
            policyIdentity: { hash: "sha256:external", activeVersion: 1 },
          }),
        },
      ),
    ).toThrow(/required sandbox policy is invalid/u);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("stops before cleanup-owning callers when external requirements are missing (#9833)", () => {
    const cleanup = vi.fn(() => true);

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: false,
          recordedAuthorities: [],
          prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
          operation: "create sandbox 'demo'",
        },
        {
          inspectActiveGlobalPolicy: () => ({
            state: "active",
            inspection: {
              authority: "externally-managed",
              effectivePolicy: { network_policies: {} },
              policyIdentity: { hash: "sha256:external", activeVersion: 1 },
            },
          }),
        },
      ),
    ).toThrow(/external policy authority to supply/u);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("preserves the authority refusal when temporary-policy cleanup also fails (#9833)", () => {
    const cleanup = vi.fn(() => false);
    let received: unknown;

    try {
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: false,
          recordedAuthorities: [],
          prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
          operation: "create sandbox 'demo'",
        },
        {
          inspectActiveGlobalPolicy: () => ({
            state: "active",
            inspection: {
              authority: "externally-managed",
              effectivePolicy: { network_policies: {} },
              policyIdentity: { hash: "sha256:external", activeVersion: 1 },
            },
          }),
        },
      );
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(PolicyAuthorityRefusalError);
    expect(received).toMatchObject({
      message: expect.stringMatching(/external policy authority to supply/u),
      cause: expect.any(AggregateError),
    });
    expect((received as Error).message).toMatch(
      /temporary sandbox policy cleanup failed.*remove the temporary sandbox policy before retrying/iu,
    );
    expect((received as Error).message).not.toContain("example.com");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects live and create-time authority drift before materializing requirements (#9833)", () => {
    const prepareRequiredPolicy = vi.fn(() => requiredPolicy);

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          prepareRequiredPolicy,
          operation: "recreate sandbox 'demo'",
        },
        {
          inspectSandboxPolicyAuthority: () => ({
            authority: "externally-managed",
            effectivePolicy: {},
            policyIdentity: { hash: "sha256:external", activeVersion: 1 },
          }),
        },
      ),
    ).toThrow(/authority changed/u);
    expect(prepareRequiredPolicy).not.toHaveBeenCalled();
  });

  it("does not materialize requirements for NemoClaw-managed policy (#9833)", () => {
    const prepareRequiredPolicy = vi.fn(() => requiredPolicy);

    expect(
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: false,
          recordedAuthorities: [],
          prepareRequiredPolicy,
          operation: "create sandbox 'demo'",
        },
        {
          inspectActiveGlobalPolicy: () => ({ state: "absent" }),
        },
      ).authority,
    ).toBe("nemoclaw-managed");
    expect(prepareRequiredPolicy).not.toHaveBeenCalled();
  });

  it("refuses a recorded managed owner without a durable gateway port (#9833)", () => {
    const recorded = {
      ...managedSandboxEntry("demo"),
      gatewayPort: undefined,
    } as unknown as SandboxEntry;
    const assertGatewayBinding = vi.fn();

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        {
          inspectSandboxPolicyAuthority: managedPolicyInspection,
          assertOpenShellGatewayPortBinding: assertGatewayBinding,
        },
      ),
    ).toThrow(/ownership is not durably verified/u);
    expect(assertGatewayBinding).not.toHaveBeenCalled();
  });

  it("refuses when the recorded route becomes pending during live verification (#9833)", () => {
    const recorded = managedSandboxEntry("demo");

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          readRecordedSandbox: () => ({
            ...recorded,
            pendingRouteReservation: true,
          }),
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        {
          inspectSandboxPolicyAuthority: managedPolicyInspection,
          inspectOpenShellSandboxIdentityFingerprint: () => SANDBOX_IDENTITY,
          assertOpenShellGatewayPortBinding: vi.fn(),
        },
      ),
    ).toThrow(/recorded sandbox policy boundary changed/u);
  });
});
