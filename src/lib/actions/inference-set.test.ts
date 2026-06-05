// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../hermes-proxy-api-key";
import type { AgentConfigTarget } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import type { Session } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";

vi.mock("../adapters/openshell/runtime", () => ({
  runOpenshell: vi.fn(),
}));

vi.mock("../inference/local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
}));

vi.mock("../sandbox/config", () => ({
  readSandboxConfig: vi.fn(),
  recomputeSandboxConfigHash: vi.fn(),
  resolveAgentConfig: vi.fn(),
  writeSandboxConfig: vi.fn(),
}));

vi.mock("../shields/audit", () => ({
  appendAuditEntry: vi.fn(),
}));

import {
  type InferenceSetDeps,
  patchHermesInferenceConfig,
  patchOpenClawInferenceConfig,
  runInferenceSet,
} from "./inference-set";

const OPENCLAW_TARGET: AgentConfigTarget = {
  agentName: "openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configDir: "/sandbox/.openclaw",
  format: "json",
  configFile: "openclaw.json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

const HERMES_TARGET: AgentConfigTarget = {
  agentName: "hermes",
  configPath: "/sandbox/.hermes/config.yaml",
  configDir: "/sandbox/.hermes",
  format: "yaml",
  configFile: "config.yaml",
  sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
};

function baseSession(overrides: Partial<Session> = {}): Session {
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
    provider: "nvidia-prod",
    model: "moonshotai/kimi-k2.6",
    endpointUrl: "https://inference.local/v1",
    credentialEnv: "OPENAI_API_KEY",
    hermesAuthMethod: null,
    preferredInferenceApi: null,
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

function createDeps(options: {
  config: ConfigObject;
  entry?: SandboxEntry | null;
  entries?: SandboxEntry[];
  defaultSandbox?: string | null;
  requestedAgent?: string | null;
  target?: AgentConfigTarget;
  session?: Session | null;
  openshellStatus?: number;
}): InferenceSetDeps & {
  calls: {
    runOpenshell: ReturnType<typeof vi.fn>;
    writeSandboxConfig: ReturnType<typeof vi.fn>;
    recomputeSandboxConfigHash: ReturnType<typeof vi.fn>;
    updateSandbox: ReturnType<typeof vi.fn>;
    updateSession: ReturnType<typeof vi.fn>;
    appendAuditEntry: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
  getSession: () => Session | null;
} {
  let session = options.session ?? null;
  const entries = options.entries ?? [options.entry ?? { name: "alpha", agent: null }];
  const sandboxes = entries.reduce<Record<string, SandboxEntry>>((acc, entry) => {
    acc[entry.name] = entry;
    return acc;
  }, {});
  const defaultSandbox =
    options.defaultSandbox === undefined ? entries[0]?.name ?? null : options.defaultSandbox;
  const calls = {
    runOpenshell: vi.fn(() => ({ status: options.openshellStatus ?? 0, stdout: "", stderr: "" })),
    writeSandboxConfig: vi.fn(),
    recomputeSandboxConfigHash: vi.fn(),
    updateSandbox: vi.fn(() => true),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      const current = session ?? baseSession();
      session = mutator(current) ?? current;
      return session;
    }),
    appendAuditEntry: vi.fn(),
    log: vi.fn(),
  };
  return {
    getDefaultSandbox: () => defaultSandbox,
    getSandbox: (name: string) => sandboxes[name] ?? null,
    listSandboxes: () => ({ sandboxes: entries, defaultSandbox }),
    updateSandbox: calls.updateSandbox,
    getRequestedAgent: () => options.requestedAgent,
    loadSession: () => session,
    updateSession: calls.updateSession,
    resolveAgentConfig: () => options.target ?? OPENCLAW_TARGET,
    readSandboxConfig: () => options.config,
    writeSandboxConfig: calls.writeSandboxConfig,
    recomputeSandboxConfigHash: calls.recomputeSandboxConfigHash,
    runOpenshell: calls.runOpenshell,
    appendAuditEntry: calls.appendAuditEntry,
    log: calls.log,
    calls,
    getSession: () => session,
  };
}

describe("patchOpenClawInferenceConfig", () => {
  it("writes provider-qualified model refs while preserving model metadata", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [
              {
                id: "moonshotai/kimi-k2.6",
                name: "inference/moonshotai/kimi-k2.6",
                contextWindow: 131072,
                maxTokens: 8192,
                reasoning: true,
                compat: { supportsStore: false },
              },
            ],
          },
        },
      },
    };

    const result = patchOpenClawInferenceConfig(
      config,
      "nvidia-prod",
      "nvidia/nemotron-3-super-120b-a12b",
    );

    expect(result.changed).toBe(true);
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          apiKey: "unused",
          api: "openai-completions",
          models: [
            {
              id: "nvidia/nemotron-3-super-120b-a12b",
              name: "inference/nvidia/nemotron-3-super-120b-a12b",
              contextWindow: 131072,
              maxTokens: 8192,
              reasoning: true,
            },
          ],
        },
      },
    });
  });

  it("is a no-op when OpenClaw already matches the requested route", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
          },
        },
      },
    };

    const result = patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/model-a");

    expect(result.changed).toBe(false);
  });

  it("switches Anthropic routes to the Anthropic provider namespace", () => {
    const config: ConfigObject = { agents: {}, models: { providers: {} } };

    patchOpenClawInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(config.agents).toEqual({
      defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        anthropic: {
          baseUrl: "https://inference.local",
          apiKey: "unused",
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet-4-6", name: "anthropic/claude-sonnet-4-6" }],
        },
      },
    });
  });
});

describe("patchHermesInferenceConfig", () => {
  it("updates only the Hermes model block for the selected route", () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
        provider: "custom",
        base_url: "https://old.example/v1",
        temperature: 0.2,
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://should-not-change.example/v1",
          },
        },
      },
      terminal: { backend: "local" },
    };

    const result = patchHermesInferenceConfig(config, "hermes-provider", "openai/gpt-5.4-mini");

    expect(result.changed).toBe(true);
    expect(config.model).toEqual({
      default: "openai/gpt-5.4-mini",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      temperature: 0.2,
    });
    expect(config.models).toEqual({
      providers: {
        inference: {
          baseUrl: "https://should-not-change.example/v1",
        },
      },
    });
    expect(config.terminal).toEqual({ backend: "local" });
  });

  it("replaces stale Hermes API keys with the OpenShell proxy placeholder", () => {
    for (const api_key of ["no-key-required", "sk-real-looking-key-that-must-not-survive"]) {
      const config: ConfigObject = {
        model: {
          default: "old-model",
          provider: "custom",
          base_url: "https://old.example/v1",
          api_key,
        },
      };

      patchHermesInferenceConfig(config, "hermes-provider", "openai/gpt-5.4-mini");

      expect((config.model as ConfigObject).api_key).toBe(HERMES_PROXY_API_KEY_PLACEHOLDER);
    }
  });

  it("sets Hermes Anthropic Messages mode for Anthropic routes", () => {
    const config: ConfigObject = {
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };

    const result = patchHermesInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(result.route).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-4-6",
      inferenceBaseUrl: "https://inference.local",
      inferenceApi: "anthropic-messages",
    });
    expect(config.model).toEqual({
      default: "claude-sonnet-4-6",
      provider: "custom",
      base_url: "https://inference.local",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      api_mode: "anthropic_messages",
    });
  });

  it("clears stale Hermes API mode when switching back to OpenAI-style routes", () => {
    const config: ConfigObject = {
      model: {
        default: "claude-sonnet-4-6",
        provider: "custom",
        base_url: "https://inference.local",
        api_mode: "anthropic_messages",
      },
    };

    patchHermesInferenceConfig(config, "nvidia-prod", "nvidia/nemotron-3-super-120b-a12b");

    expect(config.model).toEqual({
      default: "nvidia/nemotron-3-super-120b-a12b",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
  });

  it("keeps Bedrock Runtime adapter routes OpenAI-compatible for Hermes", () => {
    const config: ConfigObject = { model: {} };

    const result = patchHermesInferenceConfig(
      config,
      "compatible-anthropic-endpoint",
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "openai-completions",
    );

    expect(result.route).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
    });
    expect(config.model).toEqual({
      default: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
  });
});

describe("runInferenceSet", () => {
  it("updates OpenShell, OpenClaw config, registry, and the matching onboard session", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });

    const result = await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--no-verify",
      ],
      { ignoreError: true },
    );
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" } },
    });
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("alpha", OPENCLAW_TARGET, config);
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledWith("alpha", OPENCLAW_TARGET);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("alpha", {
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(deps.getSession()).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: "https://inference.local/v1",
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason: "inference set openclaw:nvidia-prod:nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(result).toMatchObject({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      primaryModelRef: "inference/nvidia/nemotron-3-super-120b-a12b",
      configChanged: true,
      sessionUpdated: true,
      inSandboxConfigSynced: true,
    });
  });

  it("updates OpenShell, Hermes config.yaml, registry, and the matching onboard session", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
      terminal: { backend: "local" },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });

    const result = await runInferenceSet(
      {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "hermes-provider",
        "--model",
        "openai/gpt-5.4-mini",
        "--no-verify",
      ],
      { ignoreError: true },
    );
    expect(config).toEqual({
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      },
      terminal: { backend: "local" },
    });
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledTimes(1);
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("hermes", HERMES_TARGET, config);
    expect(deps.calls.writeSandboxConfig.mock.calls[0][1].configPath).toBe(
      "/sandbox/.hermes/config.yaml",
    );
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledWith("hermes", HERMES_TARGET);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("hermes", {
      provider: "hermes-provider",
      model: "openai/gpt-5.4-mini",
    });
    expect(deps.getSession()).toMatchObject({
      provider: "hermes-provider",
      model: "openai/gpt-5.4-mini",
      endpointUrl: "https://inference.local/v1",
      preferredInferenceApi: "openai-completions",
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "hermes",
        reason: "inference set hermes:hermes-provider:openai/gpt-5.4-mini",
      }),
    );
    expect(result).toMatchObject({
      sandboxName: "hermes",
      provider: "hermes-provider",
      model: "openai/gpt-5.4-mini",
      primaryModelRef: "inference/openai/gpt-5.4-mini",
      providerKey: "inference",
      configChanged: true,
      sessionUpdated: true,
    });
  });

  it("syncs OpenClaw compatible Anthropic switches to Anthropic Messages when changing provider families", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        noVerify: true,
      },
      deps,
    );

    expect(config.agents).toEqual({
      defaults: { model: { primary: "anthropic/claude-sonnet-proxy" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
        },
        anthropic: {
          baseUrl: "https://inference.local",
          apiKey: "unused",
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet-proxy", name: "anthropic/claude-sonnet-proxy" }],
        },
      },
    });
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(result).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-proxy",
    });
  });

  it("preserves same-provider Bedrock Runtime adapter routing for OpenClaw switches", async () => {
    const config: ConfigObject = {
      agents: {
        defaults: {
          model: { primary: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0" },
        },
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [
              {
                id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
                name: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      },
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        preferredInferenceApi: "openai-completions",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-sonnet-4-6-20260101-v1:0",
        noVerify: true,
      },
      deps,
    );

    expect(config.agents).toEqual({
      defaults: {
        model: { primary: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0" },
      },
    });
    expect(config.models).toMatchObject({
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [
            {
              id: "anthropic.claude-sonnet-4-6-20260101-v1:0",
              name: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
            },
          ],
        },
      },
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
    });
  });

  it("syncs Hermes compatible Anthropic switches to Anthropic Messages when changing provider families", async () => {
    const config: ConfigObject = {
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(config.model).toEqual({
      default: "claude-sonnet-proxy",
      provider: "custom",
      base_url: "https://inference.local",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      api_mode: "anthropic_messages",
    });
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(result).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-proxy",
    });
  });

  it("preserves same-provider Bedrock Runtime adapter routing for Hermes switches", async () => {
    const config: ConfigObject = {
      model: {
        default: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        preferredInferenceApi: "openai-completions",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-sonnet-4-6-20260101-v1:0",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(config.model).toEqual({
      default: "anthropic.claude-sonnet-4-6-20260101-v1:0",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
    });
  });

  it("uses the unambiguous registered Hermes sandbox under the nemohermes alias", async () => {
    const config: ConfigObject = { model: {} };
    const deps = createDeps({
      config,
      entries: [
        { name: "alpha", agent: "openclaw" },
        { name: "hermes-one", agent: "hermes" },
      ],
      defaultSandbox: "alpha",
      requestedAgent: "hermes",
      target: HERMES_TARGET,
    });

    await runInferenceSet({ provider: "hermes-provider", model: "z-ai/glm-5.1" }, deps);

    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith(
      "hermes-one",
      HERMES_TARGET,
      config,
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("hermes-one", {
      provider: "hermes-provider",
      model: "z-ai/glm-5.1",
    });
  });

  it("requires --sandbox when the nemohermes alias cannot choose one Hermes sandbox", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        { name: "hermes-one", agent: "hermes" },
        { name: "hermes-two", agent: "hermes" },
      ],
      requestedAgent: "hermes",
      target: HERMES_TARGET,
    });

    await expect(
      runInferenceSet({ provider: "hermes-provider", model: "z-ai/glm-5.1" }, deps),
    ).rejects.toThrow(/Pass --sandbox <name>/);

    expect(deps.calls.runOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("refuses unsupported agent sandboxes before changing OpenShell inference", async () => {
    const deps = createDeps({
      config: {},
      entry: { name: "spark", agent: "spark" },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "spark" },
        deps,
      ),
    ).rejects.toThrow(/supports OpenClaw and Hermes/);

    expect(deps.calls.runOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("does not write sandbox state when openshell inference set fails", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 17 });

    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "nvidia/model-a" }, deps),
    ).rejects.toThrow(/OpenShell inference route update failed/);

    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps gateway and registry consistent when the in-sandbox config write fails (#3726)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });
    deps.calls.writeSandboxConfig.mockImplementation(() => {
      throw new Error("sandbox exec crashed");
    });

    const result = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
      deps,
    );

    // Registry still updated despite the in-sandbox sync throwing (no stale registry → no revert).
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("alpha", {
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      inSandboxConfigSynced: false,
    });
    // Warned + pointed at rebuild, and never falsely reports "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/in-sandbox config failed/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
  });

  it("reports degraded (not synced) when the in-sandbox hash recompute fails (#3726)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });
    deps.calls.recomputeSandboxConfigHash.mockImplementation(() => {
      throw new Error("hash recompute failed");
    });

    const result = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
      deps,
    );

    // Config write happened and registry is updated; the run resolves without aborting.
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("alpha", {
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    });
    expect(result).toMatchObject({ inSandboxConfigSynced: false });

    // Degraded: warns about the stale integrity hash, points at rebuild, no "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/integrity hash/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
  });
});
