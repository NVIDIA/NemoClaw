// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import type { Session } from "../state/onboard-session";
import {
  hermesApiMode,
  normalizeInferenceApi,
  resolveRuntimeInferenceApi,
} from "./inference-route-api";

vi.mock("../inference/local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    sessionId: "session-1",
    resumable: true,
    status: "complete",
    mode: "onboard",
    startedAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
    lastStepStarted: null,
    lastCompletedStep: null,
    failure: null,
    agent: "openclaw",
    sandboxName: "alpha",
    provider: "compatible-anthropic-endpoint",
    model: "old-model",
    endpointUrl: "https://inference.local/v1",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    hermesAuthMethod: null,
    preferredInferenceApi: "openai-completions",
    nimContainer: null,
    routerPid: null,
    routerCredentialHash: null,
    webSearchConfig: null,
    policyPresets: null,
    messagingChannels: null,
    messagingChannelConfig: null,
    disabledChannels: null,
    migratedLegacyValueHashes: null,
    hermesToolGateways: null,
    gpuPassthrough: false,
    telegramConfig: null,
    wechatConfig: null,
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    machine: {
      version: 1,
      state: "complete",
      stateEnteredAt: "2026-05-11T00:00:00.000Z",
      revision: 0,
    },
    steps: {},
    ...overrides,
  } as Session;
}

function resolve(
  config: ConfigObject,
  overrides: Partial<Parameters<typeof resolveRuntimeInferenceApi>[0]> = {},
) {
  return resolveRuntimeInferenceApi({
    agentName: "openclaw",
    config,
    currentProvider: "compatible-anthropic-endpoint",
    provider: "compatible-anthropic-endpoint",
    sandboxName: "alpha",
    session: null,
    ...overrides,
  });
}

describe("normalizeInferenceApi", () => {
  it("accepts supported route API names only", () => {
    expect(normalizeInferenceApi("openai-completions")).toBe("openai-completions");
    expect(normalizeInferenceApi("anthropic-messages")).toBe("anthropic-messages");
    expect(normalizeInferenceApi("openai-responses")).toBe("openai-responses");
    expect(normalizeInferenceApi("openai")).toBeNull();
    expect(normalizeInferenceApi(null)).toBeNull();
  });
});

describe("resolveRuntimeInferenceApi", () => {
  it("uses matching onboard session route API before config fallbacks", () => {
    expect(
      resolve(
        {
          agents: { defaults: { model: { primary: "anthropic/old-model" } } },
          models: {
            providers: {
              anthropic: { api: "anthropic-messages" },
            },
          },
        },
        {
          session: session({ preferredInferenceApi: "openai-completions" }),
        },
      ),
    ).toBe("openai-completions");
  });

  it("defaults compatible Anthropic provider-family switches to Anthropic Messages", () => {
    expect(
      resolve(
        {},
        {
          currentProvider: "nvidia-prod",
          session: session({
            provider: "nvidia-prod",
            preferredInferenceApi: "openai-completions",
          }),
        },
      ),
    ).toBe("anthropic-messages");
  });

  it("uses OpenClaw primary inference refs before stale Anthropic provider blocks", () => {
    expect(
      resolve({
        agents: {
          defaults: {
            model: { primary: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0" },
          },
        },
        models: {
          providers: {
            anthropic: { api: "anthropic-messages" },
            inference: { api: "openai-completions" },
          },
        },
      }),
    ).toBe("openai-completions");
  });

  it("uses OpenClaw primary Anthropic refs before stale inference provider blocks", () => {
    expect(
      resolve({
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-proxy" },
          },
        },
        models: {
          providers: {
            anthropic: { api: "anthropic-messages" },
            inference: { api: "openai-completions" },
          },
        },
      }),
    ).toBe("anthropic-messages");
  });

  it("does not let malformed inference provider blocks select a stale Anthropic family", () => {
    expect(
      resolve({
        agents: {
          defaults: {
            model: { primary: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0" },
          },
        },
        models: {
          providers: {
            anthropic: { api: "anthropic-messages" },
            inference: null,
          },
        },
      }),
    ).toBe("openai-completions");
  });

  it("preserves OpenAI Responses when the active inference provider block uses it", () => {
    expect(
      resolve({
        agents: {
          defaults: {
            model: { primary: "inference/openai/gpt-5.4" },
          },
        },
        models: {
          providers: {
            anthropic: { api: "anthropic-messages" },
            inference: { api: "openai-responses" },
          },
        },
      }),
    ).toBe("openai-responses");
  });

  it("reads Hermes api_mode for same-provider Hermes switches", () => {
    expect(
      resolve(
        { model: { api_mode: "anthropic_messages" } },
        { agentName: "hermes", session: null },
      ),
    ).toBe("anthropic-messages");
  });
});

describe("hermesApiMode", () => {
  it("maps managed route API values to Hermes config modes", () => {
    expect(hermesApiMode("openai-completions")).toBeNull();
    expect(hermesApiMode("anthropic-messages")).toBe("anthropic_messages");
    expect(hermesApiMode("openai-responses")).toBe("codex_responses");
  });
});
