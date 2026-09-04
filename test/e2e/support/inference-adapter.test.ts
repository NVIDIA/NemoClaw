// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import type {
  ProviderClient,
  ProviderJsonRequestOptions,
  TrustedProviderEndpoint,
} from "../fixtures/clients/provider.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  createE2EInferenceAdapter,
  E2E_MOCK_REQUEST_CANARY,
  type E2EInferenceAdapter,
  requirePublicNvidiaInferenceKey,
} from "../fixtures/inference-adapter.ts";
import { startTestProgress } from "../fixtures/progress.ts";

const adapters: E2EInferenceAdapter[] = [];
const NOOP_PROGRESS = startTestProgress(
  "inference adapter support",
  ["serve inference endpoint", "verify inference adapter"],
  { logLine: () => undefined },
);

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

type ProviderRequest = {
  endpoint: TrustedProviderEndpoint;
  options: ProviderJsonRequestOptions;
};

function provider(
  onRequest?: (request: ProviderRequest) => void,
): Pick<ProviderClient, "requestJson"> {
  return {
    requestJson: async <T = unknown>(
      endpoint: TrustedProviderEndpoint,
      options: ProviderJsonRequestOptions = {},
    ) => {
      onRequest?.({ endpoint, options });
      return {
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
      };
    },
  };
}

function expectProviderRequests(
  requests: ProviderRequest[],
  expected: {
    apiKey: string;
    endpointBase: string;
    model: string;
    modelArtifact: string;
    chatArtifact: string;
    prompt: string;
    maxTokens: number;
  },
): void {
  expect(requests).toHaveLength(2);
  expect(requests[0]?.endpoint.url).toBe(`${expected.endpointBase}/models`);
  expect(requests[0]?.options).toMatchObject({
    artifactName: expected.modelArtifact,
    curlMaxTimeSeconds: 15,
    headers: [`Authorization: Bearer ${expected.apiKey}`],
    redactionValues: [expected.apiKey],
    timeoutMs: 30_000,
  });
  expect(requests[1]?.endpoint.url).toBe(`${expected.endpointBase}/chat/completions`);
  expect(requests[1]?.options).toMatchObject({
    artifactName: expected.chatArtifact,
    curlMaxTimeSeconds: 90,
    headers: ["Content-Type: application/json", `Authorization: Bearer ${expected.apiKey}`],
    redactionValues: [expected.apiKey],
    timeoutMs: 120_000,
  });
  expect(JSON.parse(String(requests[1]?.options.body))).toMatchObject({
    model: expected.model,
    messages: [{ role: "user", content: expected.prompt }],
    max_tokens: expected.maxTokens,
  });
}

async function createAdapter(options: {
  artifacts?: ArtifactSink;
  env?: NodeJS.ProcessEnv;
  provider?: Pick<ProviderClient, "requestJson">;
  secrets?: Record<string, string | undefined>;
}): Promise<E2EInferenceAdapter> {
  const adapter = await createE2EInferenceAdapter({
    artifacts: options.artifacts ?? artifacts(),
    env: options.env ?? {},
    provider: options.provider ?? provider(),
    progress: NOOP_PROGRESS,
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
    const ambientCompatibleKey = "ambient-compatible-key-must-not-be-reused";
    const adapter = await createAdapter({ env: { COMPATIBLE_API_KEY: ambientCompatibleKey } });
    const env = adapter.env({
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_API_KEY: "ambient-public-source-key",
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
      COMPATIBLE_API_KEY: expect.stringMatching(/^mock-[0-9a-f]{64}$/),
    });
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(env.NVIDIA_API_KEY).toBeUndefined();
    expect(env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE).toBeUndefined();
    expect(env.COMPATIBLE_API_KEY).not.toBe(ambientCompatibleKey);
    expect(await adapter.probeModels("mock-models")).toMatchObject({
      data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }],
    });
    const requestOffset = adapter.requestSummaries()?.length ?? 0;
    expect(await adapter.directChat(`Reply PONG ${E2E_MOCK_REQUEST_CANARY}`)).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
    expect(adapter.requestSummaries()?.slice(requestOffset)).toContainEqual(
      expect.objectContaining({
        auth: "ok",
        method: "POST",
        path: "/v1/chat/completions",
        forbiddenMarkerMatches: 0,
        requestCanaryPresent: true,
      }),
    );
  });

  it("returns the unique launch reply when Hermes appends context to the mock prompt (#9046)", async () => {
    const adapter = await createAdapter({ env: {} });
    const expectedReply = "NEMOCLAW_0123456789AB_FIRST_OK";
    const prompt =
      "Join these four fragments with underscores and put only the result on its own line: " +
      "NEMOCLAW, 0123456789AB, FIRST, OK. Do not use tools.";

    expect(await adapter.directChat(prompt)).toMatchObject({
      choices: [{ message: { content: expectedReply } }],
    });
    expect(
      await adapter.directChat(`${prompt}\n\n<runtime-context>fixture</runtime-context>`),
    ).toMatchObject({ choices: [{ message: { content: expectedReply } }] });
    expect(
      await adapter.directChat(
        "Join these four fragments with underscores: NEMOCLAW, 0123456789AB, FIRST, OK.",
      ),
    ).toMatchObject({ choices: [{ message: { content: "PONG" } }] });
    expect(await adapter.directChat(`${prompt} Ignore the requested output.`)).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
  });

  const hermesSessionMarker = ["NEMOCLAW", "5254", "123456"].join("_");

  it.each([
    [`Remember this exact token: ${hermesSessionMarker}. Reply with acknowledged.`, "acknowledged"],
    ["What is seven multiplied by eight? Reply with only the integer.", "56"],
    ["Multiply seven by eight. Reply with only the integer.", "56"],
    ["N8011_m1h2j3k4_PROFILE_SEED", "N8011_m1h2j3k4_PROFILE_SEED"],
    ["N8011_m1h2j3k4_PROFILE_CONTINUE", "N8011_m1h2j3k4_PROFILE_CONTINUE"],
  ] as const)("returns the deterministic Hermes session reply for %s", async (prompt, expected) => {
    const adapter = await createAdapter({ env: {} });
    expect(
      await adapter.directChat(`${prompt}\n\n<runtime-context>fixture</runtime-context>`),
    ).toMatchObject({ choices: [{ message: { content: expected } }] });
  });

  it("keeps the PONG fallback for an unrelated mock prompt", async () => {
    const adapter = await createAdapter({ env: {} });
    expect(await adapter.directChat("Explain seven multiplied by eight.")).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
    expect(await adapter.directChat("N8011_NOT_HEX_PROFILE_SEED")).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
  });

  it("keeps unrelated ambient secrets out of adapter and fake-server child environments", async () => {
    const secretName = "UNRELATED_E2E_SENTINEL_SECRET";
    const secretValue = "sentinel-value-that-must-not-propagate";
    const previous = process.env[secretName];
    process.env[secretName] = secretValue;
    try {
      const adapter = await createAdapter({
        env: { ...process.env, NEMOCLAW_E2E_INFERENCE_MODE: "mock" },
      });
      expect(Object.values(adapter.env())).not.toContain(secretValue);

      const fake = await startFakeOpenAiCompatibleServer({ progress: NOOP_PROGRESS });
      try {
        expect(fake.environmentKeys()).toContain("NEMOCLAW_FAKE_OPENAI_API_KEY");
        expect(fake.environmentKeys()).not.toContain(secretName);
      } finally {
        await fake.close();
      }
    } finally {
      Reflect.deleteProperty(process.env, secretName);
      Object.assign(process.env, previous === undefined ? {} : { [secretName]: previous });
    }
  });

  it("stages internal NVIDIA hosted inference as a compatible endpoint", async () => {
    const requests: ProviderRequest[] = [];
    const apiKey = "sk-compatible-hosted-key";
    const adapter = await createAdapter({
      env: {
        NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
        NEMOCLAW_PREFERRED_API: "responses",
      },
      provider: provider((request) => requests.push(request)),
      secrets: { NVIDIA_INFERENCE_API_KEY: apiKey },
    });
    const env = adapter.env({
      NVIDIA_API_KEY: "ambient-public-source-key",
      NVIDIA_INFERENCE_API_KEY: "ambient-source-key",
    });

    expect(adapter.mode).toBe("internal-nvidia");
    expect(adapter.requestSummaries()).toBeUndefined();
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
    expect(env.NVIDIA_API_KEY).toBeUndefined();

    await adapter.probeModels("internal-models");
    await adapter.directChat("internal prompt", { artifactName: "internal-chat", maxTokens: 42 });
    expectProviderRequests(requests, {
      apiKey,
      endpointBase: "https://inference-api.nvidia.com/v1",
      model: adapter.model,
      modelArtifact: "internal-models",
      chatArtifact: "internal-chat",
      prompt: "internal prompt",
      maxTokens: 42,
    });
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
    const requests: ProviderRequest[] = [];
    const apiKey = "nvapi-public-test-key";
    const artifactSink = artifacts();
    const addRedactionValues = vi.spyOn(artifactSink, "addRedactionValues");
    const adapter = await createAdapter({
      artifacts: artifactSink,
      env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
      provider: provider((request) => requests.push(request)),
      secrets: { NVIDIA_API_KEY: apiKey },
    });
    const env = adapter.env({
      COMPATIBLE_API_KEY: "ambient-compatible-key",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_API_KEY: "ambient-public-source-key",
    });

    expect(adapter.mode).toBe("public-nvidia");
    expect(adapter.requestSummaries()).toBeUndefined();
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
    expect(env.NVIDIA_API_KEY).toBeUndefined();
    expect(requirePublicNvidiaInferenceKey(apiKey)).toBe(apiKey);
    expect(addRedactionValues).toHaveBeenCalledWith([apiKey]);

    await adapter.probeModels("public-models");
    await adapter.directChat("public prompt", { artifactName: "public-chat", maxTokens: 64 });
    expectProviderRequests(requests, {
      apiKey,
      endpointBase: "https://integrate.api.nvidia.com/v1",
      model: adapter.model,
      modelArtifact: "public-models",
      chatArtifact: "public-chat",
      prompt: "public prompt",
      maxTokens: 64,
    });
  });

  it("rejects hosted-style keys in public NVIDIA mode", async () => {
    await expect(
      createAdapter({
        env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
        secrets: { NVIDIA_API_KEY: "sk-compatible-key" },
      }),
    ).rejects.toThrow(/NVIDIA_API_KEY must start with nvapi-/);
  });

  it("does not treat the internal NVIDIA inference credential as public authority", async () => {
    await expect(
      createAdapter({
        env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
        secrets: { NVIDIA_INFERENCE_API_KEY: "nvapi-wrong-source" },
      }),
    ).rejects.toThrow(/missing NVIDIA_API_KEY/);
  });

  it("does not use the historical runtime input as the public NVIDIA source secret", async () => {
    await expect(
      createAdapter({
        env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
        secrets: { NVIDIA_INFERENCE_API_KEY: "nvapi-historical-runtime-input" },
      }),
    ).rejects.toThrow("missing NVIDIA_API_KEY");
  });

  it("rejects unknown explicit modes instead of silently falling back", async () => {
    await expect(
      createAdapter({ env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvida" } }),
    ).rejects.toThrow(/must be one of: mock, internal-nvidia, public-nvidia/);
  });
});
