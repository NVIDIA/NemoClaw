// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet OpenClaw gateway restart", () => {
  it("supervisor-restarts OpenClaw after cross-family sync (#4504)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "openai/nvidia/model-a" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "openai/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });

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
        openai: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [{ id: "nvidia/model-a", name: "openai/nvidia/model-a" }],
        },
        anthropic: {
          baseUrl: "https://inference.local",
          apiKey: "unused",
          api: "anthropic-messages",
          headers: {
            "X-NemoClaw-Upstream-Provider": "compatible-anthropic-endpoint",
          },
          models: [
            {
              id: "claude-sonnet-proxy",
              name: "anthropic/claude-sonnet-proxy",
              maxTokens: 4096,
            },
          ],
        },
      },
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(result).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-proxy",
    });
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha");
    expect(deps.calls.settleOpenClawPairing).toHaveBeenCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      openclawVersion: "",
      stateDirectory: "/sandbox/.openclaw",
    });
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  Inference route synced for 'alpha': anthropic/claude-sonnet-proxy",
    );
    const restartOrder = deps.calls.restartSandboxGateway.mock.invocationCallOrder[0] ?? 0;
    const pairingOrder = deps.calls.settleOpenClawPairing.mock.invocationCallOrder[0] ?? 0;
    expect(deps.calls.writeSandboxConfig.mock.invocationCallOrder[0]).toBeLessThan(restartOrder);
    expect(deps.calls.recomputeSandboxConfigHash.mock.invocationCallOrder[0]).toBeLessThan(
      restartOrder,
    );
    expect(restartOrder).toBeLessThan(pairingOrder);
  });

  it("does not restart OpenClaw when the requested route is already current (#4504)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            headers: {
              "X-NemoClaw-Upstream-Provider": "nvidia-prod",
            },
            models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      entry: { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "nvidia/model-a" },
      session: baseSession({ provider: "nvidia-prod", model: "nvidia/model-a" }),
    });

    const result = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/model-a", noVerify: true },
      deps,
    );

    expect(result.configChanged).toBe(false);
    expect(result.inSandboxConfigSynced).toBe(true);
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expect(deps.calls.settleOpenClawPairing).not.toHaveBeenCalled();
  });

  it("reports a post-commit restart failure without rolling state back (#4504)", async () => {
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
    const deps = createDeps({
      config,
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      restartSandboxGateway: () => ({
        ok: false,
        failureLayer: "health timeout",
        detail: "replacement gateway did not become healthy",
      }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow(
      "The committed route was not rolled back. Retry with 'nemoclaw alpha gateway restart'.",
    );

    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha");
    expect(deps.calls.settleOpenClawPairing).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledOnce();
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledOnce();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        preferredInferenceApi: "anthropic-messages",
      }),
    ]);
    expect(deps.calls.log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(
      "Inference route synced",
    );
  });

  it("fails a committed cross-family switch when pairing does not converge (#9527)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "openai/nvidia/model-a" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "openai/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      settleOpenClawPairing: () => ({
        ok: false,
        failureLayer: "approval-rejected",
      }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow(
      "OpenClaw gateway pairing did not converge (approval-rejected). The committed route was not rolled back.",
    );

    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.calls.settleOpenClawPairing).toHaveBeenCalledOnce();
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledOnce();
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledOnce();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
      }),
    ]);
    expect(deps.calls.log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(
      "Inference route synced",
    );
  });

  it("does not expose pairing command output from a post-commit failure (#9527)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "openai/nvidia/model-a" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "openai/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      settleOpenClawPairing: () => {
        throw new Error("token=do-not-report");
      },
    });

    const failure = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        noVerify: true,
      },
      deps,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("pairing-operation-failed");
    expect((failure as Error).message).not.toContain("do-not-report");
  });

  it("restarts when leaving a legacy Anthropic route without provider.api (#4504)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-proxy" } } },
      models: {
        providers: {
          anthropic: {
            models: [{ id: "claude-sonnet-proxy", name: "anthropic/claude-sonnet-proxy" }],
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
        model: "claude-sonnet-proxy",
      },
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      restartSandboxGateway: () => {
        throw new Error("raw restart detail must stay private");
      },
    });

    await expect(
      runInferenceSet(
        {
          provider: "nvidia-prod",
          model: "nvidia/model-a",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow(
      "The committed route was not rolled back. Retry with 'nemoclaw alpha gateway restart'.",
    );

    expect(deps.calls.log.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain(
      "Inference route synced",
    );
  });
});
