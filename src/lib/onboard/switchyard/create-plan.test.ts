// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { switchyardBindingFixture } from "../../../../test/helpers/hermes-switchyard";
import {
  createHermesSwitchyardRoutingIntent,
  type SwitchyardProviderBindings,
} from "../../hermes-switchyard-routing";
import { nativeInferenceCreateIntentFields } from "../sandbox-registration";
import { materializeSandboxCreatePlan, resolveSandboxCreateIntent } from "../sandbox-create-plan";
import type { SandboxEntry } from "../../state/registry";
import { createSwitchyardProviderFixture } from "../../../../test/support/switchyard-provider-adapter";
import { validateAttachedSwitchyardProvidersBeforeSandboxCreation } from "../sandbox-create/provider-publication";

describe("Switchyard sandbox creation", () => {
  it.each([
    {
      failure: "malformed",
      prepare: () => undefined!,
    },
    {
      failure: "missing",
      prepare: (
        f: ReturnType<typeof createSwitchyardProviderFixture>,
        bindings: SwitchyardProviderBindings,
      ) => {
        f.providers.delete(bindings.providers[0].providerName);
        return bindings;
      },
    },
    {
      failure: "stale",
      prepare: (
        f: ReturnType<typeof createSwitchyardProviderFixture>,
        bindings: SwitchyardProviderBindings,
      ) => {
        const first = bindings.providers[0];
        f.providers.set(first.providerName, {
          ...f.providers.get(first.providerName)!,
          revision: { id: first.providerId, resourceVersion: first.resourceVersion + 1 },
        });
        return bindings;
      },
    },
  ])("cleans create sources when provider validation is $failure (#13863)", async ({ prepare }) => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const f = createSwitchyardProviderFixture(routing);
    const { bindings } = await f.setup();
    const input = {
      openshellDriver: "docker",
      inferenceProvider: null,
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: [],
      gatewayName: f.input.gatewayName,
      hermesSwitchyard: { routing, bindings: prepare(f, bindings) },
    };
    const cleanupCreateSources = vi.fn();
    const deps = {
      runOpenshell: vi.fn(),
      providerAdapter: f.input.adapter,
      cleanupCreateSources,
    };

    await expect(
      validateAttachedSwitchyardProvidersBeforeSandboxCreation(input, deps),
    ).rejects.toThrow();
    expect(cleanupCreateSources).toHaveBeenCalledTimes(1);
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
  });

  it("preserves provider validation and create-source cleanup errors together (#13863)", async () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const input = {
      openshellDriver: "docker",
      inferenceProvider: null,
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: [],
      gatewayName: "test-gateway",
      hermesSwitchyard: { routing, bindings: undefined! },
    };
    const cleanupFailure = new Error("cleanup failed");
    const cleanupCreateSources = vi.fn(() => {
      throw cleanupFailure;
    });
    const failure = await validateAttachedSwitchyardProvidersBeforeSandboxCreation(input, {
      runOpenshell: vi.fn(),
      cleanupCreateSources,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toHaveProperty(
      "name",
      "SwitchyardProviderBindingError",
    );
    expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
    expect(cleanupCreateSources).toHaveBeenCalledTimes(1);
  });

  it("attaches both observed providers in the initial create request without a shared inference provider (#13863)", async () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const bindings = switchyardBindingFixture(routing);
    const entry: SandboxEntry = {
      name: "alpha",
      model: routing.capable.model,
      provider: routing.capable.provider,
      hermesSwitchyard: { routing, bindings },
    };
    const fields = nativeInferenceCreateIntentFields(entry.provider, entry);
    expect(fields.inferenceProvider).toBeNull();
    const intent = resolveSandboxCreateIntent({
      ...fields,
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "alpha",
      channels: [],
      enabledChannels: [],
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: {
        sandboxGpuEnabled: false,
        hostGpuDetected: false,
        sandboxGpuDevice: null,
      },
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      agentName: "hermes",
    });
    const plan = await materializeSandboxCreatePlan({
      intent,
      fromRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`,
      messagingTokenDefs: [],
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: () => "unused",
      prepareInitialSandboxCreatePolicy: () => ({
        policyPath: "/tmp/test-policy.yaml",
        appliedPresets: [],
      }),
    });
    expect(plan.createRequest.providers).toEqual(bindings.providers.map((p) => p.providerName));
    expect(plan.createRequest.providers).not.toContain("nemoclaw-nvidia-prod-v1");
    expect(intent.hermesSwitchyard).toEqual({ routing, bindings });
    expect(() => nativeInferenceCreateIntentFields("nvidia-prod", entry)).toThrow("does not match");
  });
});
