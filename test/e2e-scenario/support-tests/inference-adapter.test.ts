// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
  };
}

function host(stdout = "127.0.0.1\n") {
  return {
    command: async () => ({
      artifacts: { result: "", stderr: "", stdout: "" },
      command: ["stub-host-command"],
      exitCode: 0,
      artifactPaths: [],
      signal: null,
      stderr: "",
      stdout,
      timedOut: false,
    }),
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
    host: host(),
    provider: provider(),
    secrets: secrets(options.secrets ?? {}),
  });
  adapters.push(adapter);
  return adapter;
}

afterEach(async () => {
  while (adapters.length > 0) {
    await adapters.pop()?.close();
  }
});

describe("E2E inference adapter", () => {
  it("defaults to hermetic mock mode with a fake compatible endpoint", async () => {
    const adapter = await createAdapter({ env: {} });
    const env = adapter.env({ NEMOCLAW_AGENT: "hermes" });

    expect(adapter.mode).toBe("mock");
    expect(adapter.expectedRouteProvider).toBe("compatible-endpoint");
    expect(env).toMatchObject({
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_E2E_INFERENCE_MODE: "mock",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      COMPATIBLE_API_KEY: "nemoclaw-e2e-compatible-key",
    });
    expect(env.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(await adapter.probeModels("mock-models")).toMatchObject({
      data: [{ id: "nvidia/nvidia/nemotron-3-ultra" }],
    });
    expect(await adapter.directChat("Reply PONG")).toMatchObject({
      choices: [{ message: { content: "PONG" } }],
    });
  });

  it("stages internal NVIDIA hosted inference as a compatible endpoint", async () => {
    const adapter = await createAdapter({
      env: { NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia" },
      secrets: { NVIDIA_INFERENCE_API_KEY: "sk-compatible-hosted-key" },
    });
    const env = adapter.env();

    expect(adapter.mode).toBe("internal-nvidia");
    expect(adapter.expectedRouteProvider).toBe("compatible-endpoint");
    expect(env).toMatchObject({
      NEMOCLAW_E2E_INFERENCE_MODE: "internal-nvidia",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NEMOCLAW_COMPAT_MODEL: "nvidia/nvidia/nemotron-3-ultra",
      NVIDIA_INFERENCE_API_KEY: "sk-compatible-hosted-key",
      COMPATIBLE_API_KEY: "sk-compatible-hosted-key",
    });
  });

  it("centralizes public NVIDIA nvapi validation", async () => {
    const adapter = await createAdapter({
      env: { NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" },
      secrets: { NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key" },
    });
    const env = adapter.env();

    expect(adapter.mode).toBe("public-nvidia");
    expect(adapter.expectedRouteProvider).toBe("nvidia-prod");
    expect(env).toMatchObject({
      NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia",
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
    });
    expect(env.COMPATIBLE_API_KEY).toBeUndefined();
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
