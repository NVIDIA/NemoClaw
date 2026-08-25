// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createApfInterceptorPolicyVerifier,
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

describe("APF-interceptor policy verification", () => {
  it("records a contained sandbox-scoped policy as read-only without claiming provenance (#9833)", () => {
    const cleanup = vi.fn(() => true);
    const inspectSandboxPolicyAuthority = vi.fn(() => ({
      authority: "nemoclaw-managed" as const,
      effectivePolicy: {
        version: 7,
        network_policies: {
          additional_route: { endpoints: ["other.example.com"] },
          required_route: { endpoints: ["example.com"] },
        },
      },
    }));
    const verify = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      { inspectSandboxPolicyAuthority },
    );

    expect(verify("continue onboarding")).toEqual({ authority: "externally-managed" });
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "demo",
      gatewayName: "nemoclaw",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed when the post-create policy is global, insufficient, or changed (#9833)", () => {
    const cleanup = vi.fn(() => true);
    const inspectGlobalSource = vi.fn(() => ({
      authority: "externally-managed" as const,
      effectivePolicy: {
        network_policies: { required_route: { endpoints: ["example.com"] } },
      },
    }));
    const verifyGlobalSource = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      { inspectSandboxPolicyAuthority: inspectGlobalSource },
    );
    expect(() => verifyGlobalSource("continue onboarding")).toThrow(
      /global policy source is ambiguous/u,
    );
    expect(cleanup).not.toHaveBeenCalled();

    const inspectInsufficient = vi.fn(() => ({
      authority: "nemoclaw-managed" as const,
      effectivePolicy: { network_policies: {} },
    }));
    const verifyInsufficient = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      { inspectSandboxPolicyAuthority: inspectInsufficient },
    );
    expect(() => verifyInsufficient("continue onboarding")).toThrow(
      /missing entries "required_route"/u,
    );

    const inspectChanged = vi
      .fn()
      .mockReturnValueOnce({
        authority: "nemoclaw-managed" as const,
        effectivePolicy: {
          network_policies: {
            required_route: { endpoints: ["example.com"] },
            unrelated: { endpoints: ["first.example.com"] },
          },
        },
      })
      .mockReturnValueOnce({
        authority: "nemoclaw-managed" as const,
        effectivePolicy: {
          network_policies: {
            required_route: { endpoints: ["example.com"] },
            unrelated: { endpoints: ["second.example.com"] },
          },
        },
      });
    const verifyChanged = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      { inspectSandboxPolicyAuthority: inspectChanged },
    );
    expect(() => verifyChanged("verify the created sandbox")).not.toThrow();
    expect(() => verifyChanged("register providers")).toThrow(/effective policy changed/u);
    expect(cleanup).toHaveBeenCalledTimes(3);
  });

  it.each([
    { description: "a missing observed effective policy", effectivePolicy: {} },
    {
      description: "an invalid observed effective policy version",
      effectivePolicy: { version: "1", network_policies: {} },
    },
    {
      description: "an invalid observed effective network policy",
      effectivePolicy: { version: 1, network_policies: [] },
    },
  ])("fails closed for $description (#9833)", ({ effectivePolicy }) => {
    const cleanup = vi.fn(() => true);
    const verify = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      {
        inspectSandboxPolicyAuthority: vi.fn(() => ({
          authority: "nemoclaw-managed" as const,
          effectivePolicy,
        })),
      },
    );

    expect(() => verify("continue onboarding")).toThrow(/observed effective.*invalid|missing/u);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports policy refusal and temporary-policy cleanup failure together (#9833)", () => {
    const cleanup = vi.fn(() => false);
    const verify = createApfInterceptorPolicyVerifier(
      {
        sandboxName: "demo",
        gatewayName: "nemoclaw",
        prepareRequiredPolicy: () => ({ ...requiredPolicy, cleanup }),
      },
      {
        inspectSandboxPolicyAuthority: vi.fn(() => ({
          authority: "nemoclaw-managed" as const,
          effectivePolicy: { network_policies: {} },
        })),
      },
    );

    const error = (() => {
      try {
        verify("continue onboarding");
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing entries") }),
        expect.objectContaining({
          message: expect.stringContaining("temporary sandbox policy could not be removed"),
        }),
      ]),
    );
  });
});
