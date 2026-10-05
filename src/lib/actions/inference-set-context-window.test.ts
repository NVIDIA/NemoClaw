// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { setDotpath, type OpenClawConfigUpdate } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import {
  baseSession,
  createCompatibleProviderCapture,
  createDeps,
} from "./inference-set.test-support";

describe("runInferenceSet context window", () => {
  const ollamaConfig = (): ConfigObject => ({
    agents: { defaults: { model: { primary: "inference/llama3.2:3b" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "llama3.2:3b", name: "inference/llama3.2:3b", contextWindow: 131072 }],
        },
      },
    },
  });

  function inferenceModels(config: ConfigObject): Array<Record<string, unknown>> {
    const models = config.models as { providers: { inference: { models: unknown } } };
    return models.providers.inference.models as Array<Record<string, unknown>>;
  }

  it("writes the recomputed context window into the in-sandbox config", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: 16384 });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(deps.calls.resolveContextWindowForModel).toHaveBeenCalledWith(
      "ollama-local",
      "qwen2.5:7b",
    );
    expect(inferenceModels(config)[0].contextWindow).toBe(16384);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/Context window for 'qwen2\.5:7b': 16384 tokens/);
  });

  it("drops another model's window and warns when the selected window is unknown (#12033)", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: null });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(inferenceModels(config)[0]).not.toHaveProperty("contextWindow");
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/could not determine the context window/i);
    expect(logged).toMatch(/removing the previous route's value/i);
    expect(logged).toMatch(/rebuild/);
  });

  it("preserves a same-route window when re-probing cannot determine a value", async () => {
    const config = ollamaConfig();
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "ollama-local",
      model: "llama3.2:3b",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
    };
    const deps = createDeps({
      config,
      entry,
      session: baseSession({
        provider: "ollama-local",
        model: "llama3.2:3b",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
      }),
      contextWindow: null,
    });

    await runInferenceSet({ provider: "ollama-local", model: "llama3.2:3b", noVerify: true }, deps);

    expect(inferenceModels(config)[0].contextWindow).toBe(131072);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/keeping the existing same-route value/i);
  });

  it("removes the old model's window when retrying after a registry-first partial switch", async () => {
    const config = ollamaConfig();
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "ollama-local",
      model: "qwen2.5:7b",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
    };
    const deps = createDeps({
      config,
      entry,
      session: baseSession({
        provider: "ollama-local",
        model: "qwen2.5:7b",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
      }),
      contextWindow: null,
    });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(inferenceModels(config)[0]).toMatchObject({
      id: "qwen2.5:7b",
      name: "inference/qwen2.5:7b",
    });
    expect(inferenceModels(config)[0]).not.toHaveProperty("contextWindow");
  });

  it.each(["nvidia-prod", "compatible-endpoint"])(
    "clears the old endpoint window after a failed same-model switch from %s",
    async (previousProvider) => {
      const entry: SandboxEntry = {
        name: "alpha",
        agent: "openclaw",
        provider: previousProvider,
        model: "llama3.2:3b",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      };
      const persistedConfig = ollamaConfig();
      const deps = createDeps({
        config: structuredClone(persistedConfig),
        entry,
        session: baseSession(entry),
        contextWindow: null,
        captureOpenshell: createCompatibleProviderCapture({
          name: "compatible-endpoint",
          type: "openai",
          credentialEnv: "COMPATIBLE_API_KEY",
          configKey: "OPENAI_BASE_URL",
          initiallyPresent: false,
        }),
      });
      deps.calls.readSandboxConfig.mockImplementation(() => structuredClone(persistedConfig));
      deps.calls.updateSandbox.mockImplementation((_name, updates) => {
        Object.assign(entry, updates);
        return true;
      });
      deps.calls.setOpenClawConfigValues
        .mockImplementationOnce(() => {
          throw new Error("sandbox exec crashed");
        })
        .mockImplementation((_name: string, updates: readonly OpenClawConfigUpdate[]) => {
          const provider = updates.find(
            (update) => update.dotpath === "models.providers.inference",
          )!;
          const primary = updates.find(
            (update) => update.dotpath === "agents.defaults.model.primary",
          )!;
          setDotpath(persistedConfig, provider.dotpath, structuredClone(provider.value));
          setDotpath(persistedConfig, primary.dotpath, primary.value);
          setDotpath(persistedConfig, "models.mode", "merge");
        });
      const options = {
        provider: "compatible-endpoint",
        model: "llama3.2:3b",
        endpointUrl: "http://host.openshell.internal:11434/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
        noVerify: true,
      };

      await expect(runInferenceSet(options, deps)).rejects.toThrow("sandbox exec crashed");
      expect(entry.endpointUrl).toBe(options.endpointUrl);
      expect(entry.openClawConfigSyncPending).toBe(true);
      expect(inferenceModels(persistedConfig)[0].contextWindow).toBe(131072);
      await expect(runInferenceSet(options, deps)).resolves.toMatchObject({
        inSandboxConfigSynced: true,
      });
      expect(inferenceModels(persistedConfig)[0]).not.toHaveProperty("contextWindow");
      expect(entry.openClawConfigSyncPending).toBeUndefined();
    },
  );

  it.each(["native response", "session", "receipt", "restart", "pairing"] as const)(
    "retains the pending route when %s completion fails",
    async (failure) => {
      const config = ollamaConfig();
      const entry: SandboxEntry = {
        name: "alpha",
        agent: "openclaw",
        provider: "ollama-local",
        model: "llama3.2:3b",
      };
      let rejectReceipt = failure === "receipt";
      const deps = createDeps({
        config: structuredClone(config),
        entry,
        session: baseSession(entry),
        contextWindow: 16384,
      });
      const restart = deps.calls.restartSandboxGateway.getMockImplementation()!;
      deps.calls.restartSandboxGateway.mockImplementationOnce(
        failure === "restart"
          ? async () => {
              throw new Error("restart unavailable");
            }
          : restart,
      );
      const pairing = deps.calls.settleOpenClawPairing.getMockImplementation()!;
      deps.calls.settleOpenClawPairing.mockImplementationOnce(
        failure === "pairing" ? () => ({ ok: false, failureLayer: "approval-rejected" }) : pairing,
      );
      deps.calls.readSandboxConfig.mockImplementation(() => structuredClone(config));
      const updateSession = deps.calls.updateSession.getMockImplementation()!;
      deps.calls.updateSession.mockImplementationOnce(
        failure === "session"
          ? () => {
              throw new Error("session unavailable");
            }
          : updateSession,
      );
      deps.calls.updateSandbox.mockImplementation((_name, updates) => {
        const rejected =
          rejectReceipt &&
          Object.hasOwn(updates, "openClawConfigSyncPending") &&
          updates.openClawConfigSyncPending === undefined;
        Object.assign(entry, rejected ? {} : updates);
        return !rejected;
      });
      const persistNativeValues = (_name: string, updates: readonly OpenClawConfigUpdate[]) => {
        const provider = updates.find((update) => update.dotpath === "models.providers.inference")!;
        const primary = updates.find(
          (update) => update.dotpath === "agents.defaults.model.primary",
        )!;
        setDotpath(config, provider.dotpath, structuredClone(provider.value));
        setDotpath(config, primary.dotpath, primary.value);
        setDotpath(config, "models.mode", "merge");
      };
      deps.calls.setOpenClawConfigValues
        .mockImplementation(persistNativeValues)
        .mockImplementationOnce(
          failure === "native response"
            ? (name: string, updates: readonly OpenClawConfigUpdate[]) => {
                persistNativeValues(name, updates);
                throw new Error("native response unavailable");
              }
            : persistNativeValues,
        );
      const options = { provider: "ollama-local", model: "qwen2.5:7b", noVerify: true };

      await expect(runInferenceSet(options, deps)).rejects.toThrow(
        {
          "native response": "native response unavailable",
          session: "session unavailable",
          receipt: "pending synchronization record could not be cleared",
          restart: "gateway restart/recovery did not complete successfully",
          pairing: "pairing did not converge",
        }[failure],
      );
      expect(entry.openClawConfigSyncPending).toBe(true);
      expect(inferenceModels(config)[0].contextWindow).toBe(16384);
      const completedRestarts = {
        "native response": 0,
        session: 0,
        receipt: 1,
        restart: 1,
        pairing: 1,
      }[failure];
      expect(deps.calls.restartSandboxGateway).toHaveBeenCalledTimes(completedRestarts);
      rejectReceipt = false;
      await expect(runInferenceSet(options, deps)).resolves.toMatchObject({
        configChanged: false,
        inSandboxConfigSynced: true,
      });
      expect(entry.openClawConfigSyncPending).toBeUndefined();
      expect(inferenceModels(config)[0].contextWindow).toBe(16384);
      expect(deps.calls.restartSandboxGateway).toHaveBeenCalledTimes(completedRestarts + 1);
    },
  );
});
