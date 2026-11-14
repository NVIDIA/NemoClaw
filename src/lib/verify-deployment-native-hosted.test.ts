// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import { buildChain } from "./dashboard/contract";
import { hostedNativeProvider } from "./inference/native-provider/hosted";
import {
  onboardInferenceVerificationContext,
  probeOnboardInferenceInvocation,
  verifyDeployment,
} from "./verify-deployment";
import { registeredInferenceFixture } from "../../test/helpers/registered-inference";
import { verifyRegisteredInferenceProviderAttachment } from "./inference/config";
import {
  runSandboxInferenceInvocationProbe,
  verifyNativeHostedStatusAttachment,
  verifyRegisteredStatusAttachment,
} from "./actions/sandbox/inference-route-health";

vi.mock("./actions/sandbox/inference-route-health", () => ({
  runSandboxInferenceInvocationProbe: vi.fn(async () => ({ ok: true })),
  verifyNativeHostedStatusAttachment: vi.fn(async () => undefined),
  verifyRegisteredStatusAttachment: vi.fn(async () => undefined),
}));

const definition = hostedNativeProvider(
  "hermes-provider",
  "https://inference.nousresearch.com/v1",
)!;
const attachment = {
  schemaVersion: 1,
  profileId: definition.profileId,
  providerName: definition.providerName,
  providerId: "owned-id",
  endpointUrl: definition.endpointUrl,
  allowedIps: ["93.184.216.34"],
};
const context = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  agentName: "hermes",
  provider: "hermes-provider",
  model: "test-model",
  preferredInferenceApi: "openai-completions",
  nativeHostedProviderAttachment: attachment,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyRegisteredStatusAttachment).mockReset();
});

it.each([true, false])(
  "qualifies a native hosted route only when its invocation succeeds: %s",
  async (ok) => {
    const executeSandboxCommand = vi.fn(async () => ({ status: 0, stdout: "200", stderr: "" }));
    const probeInferenceInvocation = vi.fn(async () => ({ ok }));
    const result = await verifyDeployment(
      "alpha",
      buildChain(),
      {
        executeSandboxCommand,
        probeHostPort: () => 200,
        getMessagingChannels: () => [],
        providerExistsInGateway: () => true,
        probeInferenceInvocation,
      },
      { retryDelaysMs: [], sleep: async () => {}, inferenceRouteContext: context },
    );
    expect(result.verification.inferenceRouteWorking).toBe(ok);
    expect(probeInferenceInvocation).toHaveBeenCalledOnce();
    expect(executeSandboxCommand.mock.calls.flat().join("\n")).not.toContain("inference.local");
  },
);

it("verifies the recorded native attachment and probes its authenticated endpoint", async () => {
  await expect(probeOnboardInferenceInvocation(context)).resolves.toEqual({ ok: true });
  expect(verifyNativeHostedStatusAttachment).toHaveBeenCalledExactlyOnceWith({
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    expected: attachment,
  });
  expect(runSandboxInferenceInvocationProbe).toHaveBeenCalledWith(
    expect.objectContaining({
      nativeProvider: true,
      nativeEndpointUrl: definition.endpointUrl,
      provider: "hermes-provider",
    }),
  );
});

it("does not probe a shared route after native attachment verification fails", async () => {
  vi.mocked(verifyNativeHostedStatusAttachment).mockRejectedValueOnce(
    new Error("ownership changed"),
  );
  await expect(probeOnboardInferenceInvocation(context)).resolves.toEqual(
    expect.objectContaining({ ok: false }),
  );
  expect(runSandboxInferenceInvocationProbe).not.toHaveBeenCalled();
});

it("rejects a malformed recorded attachment before invoking inference", async () => {
  await expect(
    probeOnboardInferenceInvocation({ ...context, nativeHostedProviderAttachment: {} }),
  ).resolves.toEqual(expect.objectContaining({ ok: false }));
  expect(runSandboxInferenceInvocationProbe).not.toHaveBeenCalled();
});

it("preserves the legacy route when no native attachment was recorded", async () => {
  await probeOnboardInferenceInvocation({ ...context, nativeHostedProviderAttachment: undefined });
  expect(verifyNativeHostedStatusAttachment).not.toHaveBeenCalled();
  expect(runSandboxInferenceInvocationProbe).toHaveBeenCalledWith(
    expect.not.objectContaining({ nativeProvider: true }),
  );
});

it.each(["openclaw", "hermes"])(
  "preserves a registered provider through %s onboarding verification",
  async (agentName) => {
    const fixture = registeredInferenceFixture(true);
    const flow = {
      provider: "native-extra",
      model: "selected-model",
      endpointUrl: fixture.binding.endpointUrl,
      preferredInferenceApi: fixture.binding.inferenceApi,
      credentialEnv: fixture.binding.credentialEnv,
    };
    const selected = onboardInferenceVerificationContext(
      "alpha",
      fixture.binding.gatewayName,
      agentName,
      flow,
      {
        ...flow,
        registeredInferenceProviderAttachment: fixture.binding,
      },
    );
    expect(selected.route.registeredInferenceProviderAttachment).toEqual(fixture.binding);
    expect(selected.invocation.registeredInferenceProviderAttachment).toEqual(fixture.binding);
    vi.mocked(verifyRegisteredStatusAttachment).mockImplementationOnce(async ({ expected }) => {
      await verifyRegisteredInferenceProviderAttachment({ adapter: fixture.adapter, expected });
    });
    await expect(probeOnboardInferenceInvocation(selected.invocation)).resolves.toEqual({
      ok: true,
    });
    expect(verifyRegisteredStatusAttachment).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      gatewayName: fixture.binding.gatewayName,
      expected: fixture.binding,
    });
    expect(runSandboxInferenceInvocationProbe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "native-extra",
        model: "selected-model",
        nativeProvider: true,
        registeredInferenceProviderAttachment: fixture.binding,
        preferredInferenceApi: fixture.binding.inferenceApi,
      }),
    );
    expect(verifyNativeHostedStatusAttachment).not.toHaveBeenCalled();
  },
);

it.each(["served", "failed", "missing-probe"])(
  "requires an actual registered-provider invocation for deployment: %s",
  async (scenario) => {
    const { binding } = registeredInferenceFixture(true);
    const executeSandboxCommand = vi.fn(async () => ({ status: 0, stdout: "200", stderr: "" }));
    const probeInferenceInvocation = vi.fn(async () => ({ ok: scenario === "served" }));
    const result = await verifyDeployment(
      "alpha",
      buildChain(),
      {
        executeSandboxCommand,
        probeHostPort: () => 200,
        getMessagingChannels: () => [],
        providerExistsInGateway: () => true,
        ...(scenario === "missing-probe" ? {} : { probeInferenceInvocation }),
      },
      {
        retryDelaysMs: [],
        sleep: async () => {},
        inferenceRouteContext: {
          gatewayName: binding.gatewayName,
          provider: binding.providerName,
          endpointUrl: binding.endpointUrl,
          preferredInferenceApi: binding.inferenceApi,
          credentialEnv: binding.credentialEnv,
          registeredInferenceProviderAttachment: binding,
        },
      },
    );
    expect(result.verification.inferenceRouteWorking).toBe(scenario === "served");
    expect(executeSandboxCommand.mock.calls.flat().join("\n")).not.toContain("inference.local");
  },
);

it.each([
  "replaced",
  "detached",
  "wrong-gateway",
  "wrong-endpoint",
  "wrong-api",
  "wrong-key",
  "malformed",
])("refuses a registered invocation after its selected binding changes: %s", async (scenario) => {
  const fixture = registeredInferenceFixture(true);
  const changes: Record<string, Partial<typeof fixture.state>> = {
    replaced: { id: "replacement-id" },
    detached: { attached: false },
  };
  Object.assign(fixture.state, changes[scenario]);
  vi.mocked(verifyRegisteredStatusAttachment).mockImplementationOnce(async ({ expected }) => {
    await verifyRegisteredInferenceProviderAttachment({ adapter: fixture.adapter, expected });
  });
  const result = await probeOnboardInferenceInvocation({
    sandboxName: "alpha",
    agentName: "hermes",
    provider: "native-extra",
    model: "selected-model",
    gatewayName: scenario === "wrong-gateway" ? "other" : fixture.binding.gatewayName,
    endpointUrl:
      scenario === "wrong-endpoint" ? "https://other.example/v1" : fixture.binding.endpointUrl,
    preferredInferenceApi:
      scenario === "wrong-api" ? "anthropic-messages" : fixture.binding.inferenceApi,
    credentialEnv: scenario === "wrong-key" ? "OTHER_KEY" : fixture.binding.credentialEnv,
    registeredInferenceProviderAttachment: scenario === "malformed" ? {} : fixture.binding,
  });
  expect(result.ok).toBe(false);
  expect(runSandboxInferenceInvocationProbe).not.toHaveBeenCalled();
  expect(fixture.adapter.attachProvider).not.toHaveBeenCalled();
  expect(fixture.adapter.detachProvider).not.toHaveBeenCalled();
});
