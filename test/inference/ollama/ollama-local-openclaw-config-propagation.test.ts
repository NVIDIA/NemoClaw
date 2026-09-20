// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfig,
  buildManagedInferenceSafeguardCompaction,
} from "../../../scripts/generate-openclaw-config.mts";
import { patchStagedDockerfile } from "../../../src/lib/onboard/dockerfile-patch";
import { mapManagedStartupProfileToAgentEnvironment } from "../../../src/lib/onboard/managed-startup/agent-environment";
import { buildManagedStartupOnboardProfile } from "../../../src/lib/onboard/managed-startup/onboard-profile";

const tmpRoots: string[] = [];

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-config-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function readDockerArgs(dockerfilePath: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of fs.readFileSync(dockerfilePath, "utf-8").split("\n")) {
    const match = line.match(/^ARG ([A-Z0-9_]+)=(.*)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

function decodeCompat(args: Record<string, string>): Record<string, unknown> {
  const compatB64 = args.NEMOCLAW_INFERENCE_COMPAT_B64;
  assert.ok(compatB64, "expected NEMOCLAW_INFERENCE_COMPAT_B64 to be patched");
  return JSON.parse(Buffer.from(compatB64, "base64").toString("utf-8"));
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ollama-local OpenClaw config propagation", () => {
  it("propagates streaming usage compat through the managed inference route", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:0.5b",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    expect(dockerArgs).toMatchObject({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(decodeCompat(dockerArgs)).toEqual({ supportsUsageInStreaming: true });

    const config = buildConfig({
      ...dockerArgs,
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_AGENT_TIMEOUT: "600",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "qwen2.5:0.5b",
      name: "inference/qwen2.5:0.5b",
      compat: { supportsUsageInStreaming: true },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/qwen2.5:0.5b");
  });

  it("carries the ollama-local upstream provider through the staged Dockerfile (#5468)", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_UPSTREAM_PROVIDER=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:0.5b",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    // The managed-route key collapses to "inference", but the upstream provider
    // the user actually selected is preserved for config-time decisions.
    expect(dockerArgs.NEMOCLAW_PROVIDER_KEY).toBe("inference");
    expect(dockerArgs.NEMOCLAW_UPSTREAM_PROVIDER).toBe("ollama-local");
  });
});

describe("OpenClaw managed-route compaction policy (#5468, #4781)", () => {
  it("delegates small Local Ollama reserve clamping to OpenClaw 2026.9.1", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toBeUndefined();
  });

  it("uses safeguard compaction for remote managed inference (#4781)", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
    });
  });

  it("gives the N1x managed-vLLM profile its extended compaction time (#11805)", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "nvidia/Qwen3.6-35B-A3B-NVFP4",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "vllm-local",
      NEMOCLAW_SERVING_PRESET: "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/Qwen3.6-35B-A3B-NVFP4",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "32768",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });

    expect(config.agents.defaults.compaction).toEqual({
      mode: "safeguard",
      timeoutSeconds: 300,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
    });
  });

  it("carries the N1x preset through managed startup into generated config (#11805)", () => {
    const built = buildManagedStartupOnboardProfile({
      agentName: "openclaw",
      inference: {
        routeProvider: "inference",
        upstreamProvider: "vllm-local",
        model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
        routedBaseUrl: "https://inference.local/v1",
        upstreamEndpointUrl: null,
        api: "openai-completions",
        primaryModelRef: "inference/nvidia/Qwen3.6-35B-A3B-NVFP4",
        compatibility: {},
      },
      chatUiUrl: "http://127.0.0.1:18789",
      effectiveDashboardPort: 18_789,
      manageDashboard: true,
      dashboardBindAddress: undefined,
      wslExposure: false,
      hermesDashboardState: { config: null, enabled: false },
      webSearch: null,
      toolDisclosure: "progressive",
      hermesToolGateways: [],
      messagingPlan: null,
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
      environment: {
        NEMOCLAW_CONTEXT_WINDOW: "32768",
        NEMOCLAW_MAX_TOKENS: "4096",
        NEMOCLAW_SERVING_PRESET: "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4",
      },
      corporateCa: null,
    });
    const mapped = mapManagedStartupProfileToAgentEnvironment(built.profile);
    const config = buildConfig(mapped.configurationEnvironment);

    expect(mapped.configurationEnvironment.NEMOCLAW_SERVING_PRESET).toBe(
      "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4",
    );
    expect(config.agents.defaults.compaction).toMatchObject({ timeoutSeconds: 300 });
    expect(config.agents.defaults.compaction).not.toHaveProperty("reserveTokens");
    expect(config.agents.defaults.compaction).not.toHaveProperty("reserveTokensFloor");
  });

  it("keeps the standard safeguard for the same vLLM model with a larger window (#11805)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        "vllm-local",
        "https://inference.local/v1",
        undefined,
        262144,
        4096,
      ),
    ).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
    });
  });

  it("keeps the standard safeguard when a clone retains the N1x preset on another provider (#11805)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        "nvidia-prod",
        "https://inference.local/v1",
        "vllm.n1x.single.qwen3-6-35b-a3b-nvfp4",
        32768,
        4096,
      ),
    ).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
    });
  });

  it("treats a missing legacy upstream provider as remote managed inference (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        undefined,
        "https://inference.local/v1",
        "nvidia/nemotron-3-super-120b-a12b",
        131072,
        4096,
      ),
    ).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
    });
  });

  it("leaves OpenClaw's default reserve intact for large Local Ollama windows", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:7b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:7b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toBeUndefined();
  });

  it("does not enable managed-inference safeguards outside inference.local (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
        "nvidia/nemotron-3-super-120b-a12b",
        131072,
        4096,
      ),
    ).toBeUndefined();
  });

  it.each(["https://inference.local.evil/v1", "https://inference.local@evil.example/v1"])(
    "rejects a confusing managed-inference hostname %s (#4781)",
    (baseUrl) => {
      expect(
        buildManagedInferenceSafeguardCompaction(
          "inference",
          "nvidia-prod",
          baseUrl,
          "nvidia/nemotron-3-super-120b-a12b",
          131072,
          4096,
        ),
      ).toBeUndefined();
    },
  );

  it("does not enable managed-inference safeguards for another provider key (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "nvidia-prod",
        "nvidia-prod",
        "https://inference.local/v1",
        "nvidia/nemotron-3-super-120b-a12b",
        131072,
        4096,
      ),
    ).toBeUndefined();
  });
});
