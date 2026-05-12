// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ConfigObject } from "../security/credential-filter";
import type { AgentConfigTarget } from "../sandbox/config";
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
    migratedLegacyValueHashes: null,
    gpuPassthrough: false,
    telegramConfig: null,
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    steps: {},
    ...overrides,
  };
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
        action: "shields_down",
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
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "shields_down",
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
});
