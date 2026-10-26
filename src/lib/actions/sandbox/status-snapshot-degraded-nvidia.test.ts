// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxEntry } from "../../state/registry";
import type { SandboxInferenceInvocationResult } from "./inference-invocation-probe";
import { collectSandboxStatusSnapshot, isInferenceHealthFailing } from "./status-snapshot";

it("keeps degraded inference nonfatal while unverified and unhealthy routes fail (#13616)", () => {
  const health: ProviderHealthStatus = {
    ok: true,
    probed: false,
    degraded: true,
    providerLabel: "Inference route",
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    detail: "NVIDIA upstream is temporarily unavailable",
  };
  expect(isInferenceHealthFailing(health)).toBe(false);
  expect(isInferenceHealthFailing({ ...health, degraded: undefined })).toBe(true);
  expect(isInferenceHealthFailing({ ...health, ok: false })).toBe(true);
});

it("keeps exhausted native NVIDIA HTTP 500 health degraded and nonfatal (#13616)", async () => {
  const attachment = {
    schemaVersion: 1,
    profileId: "nemoclaw-nvidia-inference-v1",
    providerName: "nemoclaw-nvidia-prod-v1",
    providerId: "owned-provider-id",
  } as const;
  const invocation: SandboxInferenceInvocationResult = {
    ok: false,
    detail: "sandbox inference invocation probe returned HTTP 500",
    httpStatus: 500,
  };
  const sandbox: SandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    provider: "nvidia-prod",
    model: "nvidia/nemotron",
    nativeNvidiaProviderAttachment: attachment,
  };
  const options = {
    suppressInferenceProbe: false,
    deps: {
      getSandbox: () => sandbox,
      listPublishedSandboxesAcrossGatewayRoots: () => [sandbox],
      reconcile: async () => ({ state: "present" as const, output: "Phase: Ready" }),
      inferenceRouteObserver: {
        observeInferenceRoute: async () => {
          throw new Error("live route lookup not needed for this test");
        },
      },
      probeProviderHealthImpl: () => null,
      probeSandboxInferenceGatewayHealthImpl: async () => null,
      probeSandboxInferenceInvocationImpl: async () => invocation,
      reportInferenceProbeRetry: vi.fn(),
    },
  };
  const verifyNativeNvidiaProviderAttachmentImpl = vi.fn(async () => undefined);
  const probeSandboxInferenceInvocationImpl = vi.fn(async () => invocation);
  const probeSandboxInferenceGatewayHealthImpl = vi.fn(async () => null);
  const delayInferenceRecoveryProbe = vi.fn(async () => undefined);
  const snapshot = await collectSandboxStatusSnapshot("alpha", {
    ...options,
    deps: {
      ...options.deps,
      verifyNativeNvidiaProviderAttachmentImpl,
      probeSandboxInferenceInvocationImpl,
      probeSandboxInferenceGatewayHealthImpl,
      delayInferenceRecoveryProbe,
    },
  });

  expect(verifyNativeNvidiaProviderAttachmentImpl).toHaveBeenCalledWith(
    expect.objectContaining({
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
      expected: attachment,
    }),
  );
  expect(probeSandboxInferenceGatewayHealthImpl).not.toHaveBeenCalled();
  expect(probeSandboxInferenceInvocationImpl).toHaveBeenCalledTimes(3);
  expect(probeSandboxInferenceInvocationImpl).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "nvidia-prod",
      model: "nvidia/nemotron",
      nativeProvider: true,
    }),
    {},
    95_000,
  );
  expect(delayInferenceRecoveryProbe).toHaveBeenCalledTimes(2);
  expect(snapshot.inferenceHealth).toMatchObject({ ok: true, probed: false, degraded: true });
  expect(isInferenceHealthFailing(snapshot.inferenceHealth)).toBe(false);
});
