// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeLocalSetupReceipt } from "../support/native-local-setup-harness";
import { createDirectSetupInferenceHarness } from "../helpers/onboard-split-context";

describe("native provider ownership before route reservation", () => {
  it("retires an unreserved provider after host smoke fails (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "openclaw",
      }),
    ).rejects.toThrow("host smoke refused");
    expect(harness.native.adapter.createProvider).toHaveBeenCalledOnce();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(0);
    expect(harness.native.authorities.size).toBe(0);
  });
});

describe("native provider cleanup uncertainty", () => {
  it("retains authority when deletion cannot be confirmed (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    harness.native.adapter.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "connection_loss", message: "delete outcome unknown" },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "openclaw",
      }),
    ).rejects.toThrow(/host smoke refused[\s\S]*cleanup was not confirmed/);
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });

  it("retains authority after a failed reservation response (#12558)", async () => {
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        updateSandbox: () => {
          throw new Error("reservation response lost");
        },
      },
    });
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "openclaw",
      }),
    ).rejects.toThrow("reservation response lost");
    expect(harness.native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });

  it("keeps an existing selected provider after a pre-reservation failure (#12558)", async () => {
    const existing = nativeLocalSetupReceipt({
      provider: "vllm-local",
      sandboxName: "test-box",
      gatewayName: "nemoclaw",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      authMode: "sentinel",
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        applyLocalInferenceRoute: undefined,
        getSandbox: () => ({
          name: "test-box",
          provider: "vllm-local",
          nativeLocalProviderAttachment: existing,
        }),
        verifyOnboardInferenceSmoke: async () => {
          throw new Error("host smoke refused");
        },
      },
    });
    harness.native.seed(existing);
    await expect(
      harness.setupInference("test-box", "meta-llama", "vllm-local", null, null, null, [], {
        agentName: "openclaw",
      }),
    ).rejects.toThrow("host smoke refused");
    expect(harness.native.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(harness.native.providers.size).toBe(1);
    expect(harness.native.authorities.size).toBe(1);
  });
});
