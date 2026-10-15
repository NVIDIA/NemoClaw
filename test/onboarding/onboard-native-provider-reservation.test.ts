// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeLocalSetupReceipt } from "../support/native-local-setup-harness";
import { createDirectSetupInferenceHarness } from "../helpers/onboard-split-context";

const testHome = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-reservation-"));
  vi.stubEnv("HOME", directory);
  return directory;
});

beforeEach((context) => {
  vi.stubEnv("HOME", testHome);
  fs.mkdirSync(testHome, { recursive: true });
  context.onTestFinished(() => {
    vi.unstubAllEnvs();
    fs.rmSync(testHome, { recursive: true, force: true });
  });
});

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

describe("native selection with published shared-route staging enabled", () => {
  it.each([
    ["openclaw", "llama-cpp-local"],
    ["openclaw", "compatible-endpoint"],
    ["langchain-deepagents-code", "llama-cpp-local"],
    ["langchain-deepagents-code", "compatible-endpoint"],
  ])(
    "reserves %s native %s ownership without changing the shared route (#12977)",
    async (agentName, provider) => {
      const port = provider === "llama-cpp-local" ? 8081 : 8000;
      const endpointUrl = `http://127.0.0.1:${port}/v1`;
      const harness = createDirectSetupInferenceHarness({
        overrides: {
          isNonInteractive: () => true,
          hydrateCredentialEnv: () => "fixture-local-key",
          getSandbox: () => ({
            name: "test-box",
            agent: agentName,
            provider: "nvidia-prod",
            model: "old-model",
            gatewayName: "nemoclaw",
          }),
        },
      });
      const result = await harness.setupInference(
        "test-box",
        "new-model",
        provider,
        endpointUrl,
        "LOCAL_KEY",
        null,
        [],
        { agentName, deferPublishedRouteReservation: true, onboardEndpointUrl: endpointUrl },
      );
      expect(result).toEqual({ ok: true });
      expect(harness.updateSandbox).toHaveBeenCalledExactlyOnceWith(
        "test-box",
        expect.objectContaining({
          provider,
          model: "new-model",
          nativeLocalProviderAttachment: expect.objectContaining({
            provider,
            endpointUrl: `http://host.openshell.internal:${port}/v1`,
            gatewayName: "nemoclaw",
            sandboxName: "test-box",
          }),
        }),
      );
      expect(harness.native.providers.size).toBe(1);
      expect(harness.commands.filter(({ command }) => command.startsWith("inference set"))).toEqual(
        [],
      );
    },
  );
});
