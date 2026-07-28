// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SandboxConfigError } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import { InferenceSetError, runInferenceSet } from "./inference-set";
import {
  baseSession,
  createDeps,
  createExistingCompatibleProviderCapture,
} from "./inference-set.test-support";

describe("runInferenceSet degraded state handling", () => {
  it("aborts before mutating any layer when the sandbox config read fails (#6997)", async () => {
    const deps = createDeps({ config: {}, session: baseSession() });
    // A stopped sandbox surfaces SandboxConfigError from the in-sandbox read —
    // the exact path from the issue.
    deps.calls.readSandboxConfig.mockImplementation(() => {
      throw new SandboxConfigError([
        "  Cannot read openclaw config (/sandbox/.openclaw/openclaw.json).",
        "  Is the sandbox running?",
      ]);
    });

    const error = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
      deps,
    ).then(
      () => {
        throw new Error("expected runInferenceSet to reject");
      },
      (rejection: unknown) => rejection,
    );

    // Converted to the command-layer error type with an actionable message, so
    // the CLI reports cleanly instead of dumping a raw SandboxConfigError stack.
    expect(error).toBeInstanceOf(InferenceSetError);
    expect((error as Error).message).toMatch(/Is the sandbox running/);
    expect((error as Error).message).toMatch(/Start the sandbox and retry/);

    // #6997 core guarantee: the read is a pre-flight gate, so a stopped sandbox
    // leaves EVERY mutable layer untouched. Previously the read ran after the
    // gateway route and registry were committed, leaving a half-applied switch.
    // Assert zero mutation so re-ordering the read back after the mutations
    // regresses this test. (The read-only `openshell provider get` probe that
    // runs earlier is not a mutation, so filter to the route-SET call.)
    const routeSetCalls = deps.calls.captureOpenshell.mock.calls.filter(
      (args) => Array.isArray(args[0]) && args[0][0] === "inference" && args[0][1] === "set",
    );
    expect(routeSetCalls).toHaveLength(0);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
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
      { provider: "anthropic-prod", model: "claude-sonnet-4-6", noVerify: true },
      deps,
    );

    // Registry still updated despite the in-sandbox sync throwing (no stale registry → no revert).
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "anthropic-prod",
        model: "claude-sonnet-4-6",
      }),
    );
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "anthropic-prod",
      model: "claude-sonnet-4-6",
      inSandboxConfigSynced: false,
    });
    // Warned + pointed at rebuild, and never falsely reports "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/in-sandbox config failed/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("reconciles the provider marker when a config-write retry uses the registered provider", async () => {
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    };
    let persistedConfig: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" } },
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            headers: {
              "X-NemoClaw-Upstream-Provider": "nvidia-prod",
            },
            models: [
              {
                id: "nvidia/nemotron-3-super-120b-a12b",
                name: "inference/nvidia/nemotron-3-super-120b-a12b",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({
      config: structuredClone(persistedConfig),
      entry,
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
      captureOpenshell: createExistingCompatibleProviderCapture({
        name: "compatible-endpoint",
        type: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        configKey: "OPENAI_BASE_URL",
      }),
    });
    deps.calls.readSandboxConfig.mockImplementation(() => structuredClone(persistedConfig));
    deps.calls.updateSandbox.mockImplementation((_name, updates) => {
      Object.assign(entry, updates);
      return true;
    });
    deps.calls.writeSandboxConfig
      .mockImplementationOnce(() => {
        throw new Error("sandbox exec crashed");
      })
      .mockImplementation((_name, _target, config) => {
        persistedConfig = structuredClone(config);
      });

    const options = {
      provider: "compatible-endpoint",
      model: "openai/gpt-5.4-mini",
      endpointUrl: "http://host.openshell.internal:11434/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      inferenceApi: "openai-completions",
      noVerify: true,
    };

    await expect(runInferenceSet(options, deps)).resolves.toMatchObject({
      inSandboxConfigSynced: false,
    });
    expect(persistedConfig.models).toMatchObject({
      providers: {
        inference: {
          headers: {
            "X-NemoClaw-Upstream-Provider": "nvidia-prod",
          },
        },
      },
    });

    await expect(runInferenceSet(options, deps)).resolves.toMatchObject({
      inSandboxConfigSynced: true,
    });
    expect(persistedConfig.models).toMatchObject({
      providers: {
        inference: {
          headers: {
            "X-NemoClaw-Upstream-Provider": "compatible-endpoint",
          },
        },
      },
    });
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
      { provider: "anthropic-prod", model: "claude-sonnet-4-6", noVerify: true },
      deps,
    );

    // Config write happened and registry is updated; the run resolves without aborting.
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "anthropic-prod",
        model: "claude-sonnet-4-6",
      }),
    );
    expect(result).toMatchObject({ inSandboxConfigSynced: false });

    // Degraded: warns about the stale integrity hash, points at rebuild, no "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/integrity hash/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });
});
