// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { switchyardBindingFixture } from "../../../../test/helpers/hermes-switchyard";
import { createHermesSwitchyardRoutingIntent } from "../../hermes-switchyard-routing";
import { nativeInferenceCreateIntentFields } from "../sandbox-registration";
import { materializeSandboxCreatePlan, resolveSandboxCreateIntent } from "../sandbox-create-plan";
import type { SandboxEntry } from "../../state/registry";

describe("Switchyard sandbox creation", () => {
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
