// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import { loadAgent } from "../../agent/defs";
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
  it("preflights policy authority for the default OpenClaw agent (#9833)", () => {
    const inspectSandboxForCreate = vi.fn(() => ({ existingEntry: null, liveExists: false }));
    const loadDefaultAgent = vi.fn((name: string) => loadAgent(name));
    const bindings = createOnboardPolicyAuthorityBindings(
      {
        GATEWAY_NAME: "nemoclaw-18080",
        ROOT: "/unused",
        agentDefs: { loadAgent: loadDefaultAgent },
        agentOnboard: { getAgentPolicyPath: vi.fn(() => null) },
        inspectSandboxForCreate,
        onboardSession: {
          loadSession: () => null,
          updateSession: (mutator) => {
            const session: { policyAuthority?: "nemoclaw-managed" | "externally-managed" } = {};
            mutator(session);
            return session;
          },
        },
      },
      null,
      {
        inspectGlobalPolicyAuthority: () => ({
          authority: "nemoclaw-managed",
          effectivePolicy: {},
        }),
      },
    );

    expect(() =>
      bindings.preflightPolicyRequirements({
        gatewayName: "nemoclaw-18080",
        sandboxName: null,
        agent: null,
        selectedMessagingChannels: [],
        hermesToolGateways: [],
        gpuPassthrough: false,
        provider: null,
        webSearchConfig: null,
        observabilityEnabled: false,
        operation: "select an inference provider",
      }),
    ).not.toThrow();
    expect(loadDefaultAgent).toHaveBeenCalledExactlyOnceWith("openclaw");
    expect(inspectSandboxForCreate).toHaveBeenCalledExactlyOnceWith("my-assistant");
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
    }));
    const inspectGlobal = vi.fn(() => ({
      authority: "externally-managed" as const,
      effectivePolicy: {
        network_policies: { required_route: { endpoints: ["example.com"] } },
      },
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
        inspectGlobalPolicyAuthority: inspectGlobal,
        inspectSandboxPolicyAuthority: inspectSandbox,
      },
    );

    expect(result.authority).toBe("externally-managed");
    expect(inspectSandbox).toHaveBeenCalledWith({
      sandboxName: "demo",
      gatewayName: "nemoclaw",
    });
    expect(inspectGlobal).toHaveBeenCalledWith({ gatewayName: "nemoclaw" });
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
          inspectGlobalPolicyAuthority: () => ({
            authority: "externally-managed",
            effectivePolicy: { network_policies: {} },
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
          inspectGlobalPolicyAuthority: () => ({
            authority: "externally-managed",
            effectivePolicy: { network_policies: {} },
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
            authority: "nemoclaw-managed",
            effectivePolicy: {},
          }),
          inspectGlobalPolicyAuthority: () => ({
            authority: "externally-managed",
            effectivePolicy: { network_policies: {} },
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
          inspectGlobalPolicyAuthority: () => ({
            authority: "nemoclaw-managed",
            effectivePolicy: {},
          }),
        },
      ).authority,
    ).toBe("nemoclaw-managed");
    expect(prepareRequiredPolicy).not.toHaveBeenCalled();
  });
});
