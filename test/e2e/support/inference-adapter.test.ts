// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  createE2EInferenceAdapter,
  type E2EInferenceAdapter,
  requirePublicNvidiaInferenceKey,
} from "../fixtures/inference-adapter.ts";

const adapters: E2EInferenceAdapter[] = [];

function artifacts(): ArtifactSink {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-adapter-test-"));
  return new ArtifactSink(root);
}

function secrets(values: Record<string, string | undefined>) {
  return {
    required: (name: string) => {
      const value = values[name];
      return (
        value ??
        (() => {
          throw new Error(`missing ${name}`);
        })()
      );
    },
  };
}

function provider() {
  return {
    requestJson: async <T = unknown>() => ({
      json: { data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }] } as T,
      result: {
        artifacts: { result: "", stderr: "", stdout: "" },
        artifactPaths: [],
        command: ["stub-provider-request"],
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "{}",
        timedOut: false,
      },
    }),
  };
}

async function createAdapter(options: {
  env?: NodeJS.ProcessEnv;
  secrets?: Record<string, string | undefined>;
}): Promise<E2EInferenceAdapter> {
  const adapter = await createE2EInferenceAdapter({
    artifacts: artifacts(),
    env: options.env ?? {},
    provider: provider(),
    secrets: secrets(options.secrets ?? {}),
  });
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (adapters.length > 0) {
    await adapters.pop()?.close();
  }
});

describe("E2E inference adapter", () => {
  it("defaults to hermetic mock mode with a fake compatible endpoint", async () => {
    const adapter = await createAdapter({ env: {} });
    const env = adapter.env({
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_INFERENCE_API_KEY: "ambient-source-key",
    });

    expect(adapter.mode).toBe("mock");
    expect(adapter.expectedRouteProvider).toBe("compatible-endpoint");
    expect(adapter.endpointUrl).toMatch(/^http:\/\/host\.openshell\.internal:\d+\/v1$/);
    expect(env).toMatchObject({
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_INFERENCE_MODE: "mock",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      COMPATIBLE_API_KEY: "fake-compatible-key",
    });
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBeUndefined();
    expect(await adapter.probeModels("mock-models")).toMatchObject({
      data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }],
    });
    expect(await adapter.directChat("Reply PONG")).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
  });

  it("stages internal NVIDIA hosted inference as a compatible endpoint", async () => {
    const adapter = await createAdapter({
      env: {
        NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
        NEMOCLAW_PREFERRED_API: "responses",
      },
      secrets: { NVIDIA_INFERENCE_API_KEY: "sk-compatible-hosted-key" },
    });
    const env = adapter.env({ NVIDIA_INFERENCE_API_KEY: "ambient-source-key" });

    expect(adapter.mode).toBe("internal-nvidia");
    expect(adapter.expectedRouteProvider).toBe("compatible-endpoint");
    expect(env).toMatchObject({
      NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_PREFERRED_API: "responses",
      COMPATIBLE_API_KEY: "sk-compatible-hosted-key",
    });
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  });

  it("rejects internal NVIDIA endpoint overrides outside the fixture-owned host", async () => {
    await expect(
      createAdapter({
        env: {
          NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
          NEMOCLAW_ENDPOINT_URL: "https://untrusted.example/v1",
        },
        secrets: { NVIDIA_INFERENCE_API_KEY: "sk-compatible-hosted-key" },
      }),
    ).rejects.toThrow(/provider endpoint host is not allowed: untrusted\.example/);
  });

  it("rejects non-OK mock model probes before writing artifacts", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "missing" }), { status: 401 }));
    const adapter = await createAdapter({ env: {} });

    await expect(adapter.probeModels("mock-models-unauthorized")).rejects.toThrow(
      /model probe failed with HTTP 401/,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds mock fallback requests with provider-equivalent timeouts", async () => {
    const modelSignal = new AbortController().signal;
    const chatSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(modelSignal)
      .mockReturnValueOnce(chatSignal);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "PONG" } }] })),
      );
    const adapter = await createAdapter({ env: {} });

    await adapter.probeModels("mock-models-bounded");
    await adapter.directChat("Reply PONG", { artifactName: "mock-chat-bounded" });

    expect(timeout).toHaveBeenNthCalledWith(1, 30_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 120_000);
    expect(fetch).toHaveBeenNthCalledWith(1, expect.any(String), { signal: modelSignal });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ method: "POST", signal: chatSignal }),
    );
  });

  it("centralizes public NVIDIA nvapi validation", async () => {
    const adapter = await createAdapter({
      env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
      secrets: { NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key" },
    });
    const env = adapter.env({
      COMPATIBLE_API_KEY: "ambient-compatible-key",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
    });

    expect(adapter.mode).toBe("public-nvidia");
    expect(adapter.expectedRouteProvider).toBe("nvidia-prod");
    expect(adapter.endpointUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(env).toMatchObject({
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
    });
    expect(env.COMPATIBLE_API_KEY).toBeUndefined();
    expect(env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBeUndefined();
    expect(requirePublicNvidiaInferenceKey("nvapi-public-test-key")).toBe("nvapi-public-test-key");
  });

  it("rejects hosted-style keys in public NVIDIA mode", async () => {
    await expect(
      createAdapter({
        env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
        secrets: { NVIDIA_INFERENCE_API_KEY: "sk-compatible-key" },
      }),
    ).rejects.toThrow(/must start with nvapi-/);
  });

  it("rejects unknown explicit modes instead of silently falling back", async () => {
    await expect(
      createAdapter({ env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvida" } }),
    ).rejects.toThrow(/must be one of: mock, internal-nvidia, public-nvidia/);
  });
});
