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
import {
  runWithVerifiedSwitchyardAttachments,
  validateAttachedSwitchyardProvidersBeforeSandboxCreation,
} from "../sandbox-create/provider-publication";

describe("Switchyard sandbox creation", () => {
  it("keeps ordinary startup independent of Switchyard attachment verification (#13863)", async () => {
    const runOpenshell = vi.fn();
    const revalidateSandboxIdentity = vi.fn();
    const activate = vi.fn(() => "released");
    await expect(
      runWithVerifiedSwitchyardAttachments(
        "ordinary",
        {
          openshellDriver: "docker",
          inferenceProvider: null,
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: [],
          gatewayName: "test-gateway",
        },
        { runOpenshell, cleanupCreateSources: vi.fn() },
        revalidateSandboxIdentity,
        activate,
      ),
    ).resolves.toBe("released");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(revalidateSandboxIdentity).not.toHaveBeenCalled();
  });

  it("verifies native attachments and sandbox identity before activating startup (#13863)", async () => {
    const routing = createHermesSwitchyardRoutingIntent({
      efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
      capable: { provider: "openai-api", model: "gpt-5" },
    });
    const f = createSwitchyardProviderFixture(routing);
    const { bindings } = await f.setup();
    vi.clearAllMocks();
    const revalidateSandboxIdentity = vi.fn();
    const activate = vi.fn(() => "released");
    await expect(
      runWithVerifiedSwitchyardAttachments(
        f.input.sandboxName,
        {
          openshellDriver: "docker",
          inferenceProvider: null,
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: [],
          gatewayName: f.input.gatewayName,
          hermesSwitchyard: { routing, bindings },
        },
        {
          runOpenshell: vi.fn(),
          providerAdapter: f.input.adapter,
          cleanupCreateSources: vi.fn(),
        },
        revalidateSandboxIdentity,
        activate,
      ),
    ).resolves.toBe("released");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(revalidateSandboxIdentity).toHaveBeenCalledTimes(2);
    expect(f.methods.listProviderAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      activate.mock.invocationCallOrder[0],
    );
    expect(revalidateSandboxIdentity.mock.invocationCallOrder[1]).toBeLessThan(
      activate.mock.invocationCallOrder[0],
    );
    expect(f.methods.createProvider).not.toHaveBeenCalled();
    expect(f.methods.deleteProvider).not.toHaveBeenCalled();
    expect(f.methods.updateProvider).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "stale", "profile", "conflicting"] as const)(
    "gates startup on %s native provider attachments (#13863)",
    async (state) => {
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const f = createSwitchyardProviderFixture(routing);
      const { bindings } = await f.setup();
      const first = bindings.providers[0];
      switch (state) {
        case "missing":
          f.names.splice(0, 1);
          break;
        case "duplicate":
          f.names.push(first.providerName);
          break;
        case "stale":
          f.providers.set(first.providerName, {
            ...f.providers.get(first.providerName)!,
            revision: { id: first.providerId, resourceVersion: first.resourceVersion + 1 },
          });
          break;
        case "profile":
          f.methods.inspectProviderProfile.mockResolvedValueOnce({
            ok: true,
            value: { credentialKeys: ["WRONG_KEY"] },
          });
          break;
        case "conflicting":
          f.names.push("unrelated-provider");
          f.providers.set("unrelated-provider", {
            name: "unrelated-provider",
            type: "generic",
            configKeys: [],
            credentialKeys: [first.credentialEnv],
          });
          break;
      }
      vi.clearAllMocks();
      const input = {
        openshellDriver: "docker",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: f.input.gatewayName,
        hermesSwitchyard: { routing, bindings },
      };
      const revalidateSandboxIdentity = vi.fn();
      const activate = vi.fn(() => "released");
      const result = runWithVerifiedSwitchyardAttachments(
        f.input.sandboxName,
        input,
        {
          runOpenshell: vi.fn(),
          providerAdapter: f.input.adapter,
          cleanupCreateSources: vi.fn(),
        },
        revalidateSandboxIdentity,
        activate,
      );
      await expect(result).rejects.toThrow();
      expect(activate).not.toHaveBeenCalled();
      expect(f.methods.createProvider).not.toHaveBeenCalled();
      expect(f.methods.deleteProvider).not.toHaveBeenCalled();
      expect(f.methods.updateProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      check: 1,
      revalidate: vi.fn(() => {
        throw new Error("sandbox identity changed");
      }),
    },
    {
      check: 2,
      revalidate: vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error("sandbox identity changed");
        }),
    },
  ])(
    "blocks startup when sandbox identity check $check fails (#13863)",
    async ({ check, revalidate: revalidateSandboxIdentity }) => {
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
      });
      const f = createSwitchyardProviderFixture(routing);
      const { bindings } = await f.setup();
      const activate = vi.fn();
      await expect(
        runWithVerifiedSwitchyardAttachments(
          f.input.sandboxName,
          {
            openshellDriver: "docker",
            inferenceProvider: null,
            messagingProviders: [],
            messagingProviderRequests: [],
            extraProviders: [],
            gatewayName: f.input.gatewayName,
            hermesSwitchyard: { routing, bindings },
          },
          {
            runOpenshell: vi.fn(),
            providerAdapter: f.input.adapter,
            cleanupCreateSources: vi.fn(),
          },
          revalidateSandboxIdentity,
          activate,
        ),
      ).rejects.toThrow("sandbox identity changed");
      expect(activate).not.toHaveBeenCalled();
      expect(revalidateSandboxIdentity).toHaveBeenCalledTimes(check);
    },
  );

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

  it.each([false, true])(
    "attaches every observed provider with dedicated judge=%s in the initial request (#13863)",
    async (dedicated) => {
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
        capable: { provider: "openai-api", model: "gpt-5" },
        ...(dedicated ? { judge: { provider: "anthropic-prod", model: "claude-judge" } } : {}),
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
      expect(plan.createRequest.providers).toHaveLength(dedicated ? 3 : 2);
      expect(plan.createRequest.providers).not.toContain("nemoclaw-nvidia-prod-v1");
      expect(intent.hermesSwitchyard).toEqual({ routing, bindings });
      expect(() => nativeInferenceCreateIntentFields("nvidia-prod", entry)).toThrow(
        "does not match",
      );
    },
  );
});
