// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import { buildChain } from "./dashboard/contract";
import { hostedNativeProvider } from "./inference/native-provider/hosted";
import { probeOnboardInferenceInvocation, verifyDeployment } from "./verify-deployment";
import {
  runSandboxInferenceInvocationProbe,
  verifyNativeHostedStatusAttachment,
} from "./actions/sandbox/inference-route-health";

vi.mock("./actions/sandbox/inference-route-health", () => ({
  runSandboxInferenceInvocationProbe: vi.fn(async () => ({ ok: true })),
  verifyNativeHostedStatusAttachment: vi.fn(async () => undefined),
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

beforeEach(() => vi.clearAllMocks());

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
