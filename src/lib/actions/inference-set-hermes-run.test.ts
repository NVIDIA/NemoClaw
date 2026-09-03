// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const portableMocks = vi.hoisted(() => ({
  assertUnavailable: vi.fn(),
}));

vi.mock("../onboard/experimental/portable-agent-lifecycle", async (importOriginal) => ({
  ...(await importOriginal()),
  assertHermesPortableCommandUnavailable: portableMocks.assertUnavailable,
}));
import { HERMES_PROXY_REWRITE_SENTINEL } from "../hermes-managed-route";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps, HERMES_TARGET } from "./inference-set.test-support";

describe("runInferenceSet Hermes routing", () => {
  beforeEach(() => {
    portableMocks.assertUnavailable.mockReset();
  });

  it("rejects schema-5 before OpenShell or registry mutation (#9203)", async () => {
    portableMocks.assertUnavailable.mockImplementation(() => {
      throw new Error("schema-5 rejected");
    });
    const deps = createDeps({
      config: {},
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow("schema-5 rejected");

    expect(deps.calls.prepareRunOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rechecks schema-5 after the lifecycle lock is acquired (#9203)", async () => {
    portableMocks.assertUnavailable
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("schema-5 appeared");
      });
    const deps = createDeps({
      config: {},
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow("schema-5 appeared");

    expect(deps.calls.prepareRunOpenshell).toHaveBeenCalledOnce();
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
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
      contextWindow: 128_000,
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

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
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
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 },
    );
    expect(config).toEqual({
      _nemoclaw_upstream: {
        provider: "hermes-provider",
        provider_key: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      },
      custom_providers: [
        {
          name: "hermes-provider",
          base_url: "https://inference.local/v1",
          api_key: HERMES_PROXY_REWRITE_SENTINEL,
          discover_models: true,
        },
      ],
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: HERMES_PROXY_REWRITE_SENTINEL,
        context_length: 128_000,
      },
      providers: {
        "hermes-provider": {
          name: "hermes-provider",
          api: "https://inference.local/v1",
          api_key: HERMES_PROXY_REWRITE_SENTINEL,
          default_model: "openai/gpt-5.4-mini",
          discover_models: true,
        },
      },
      terminal: { backend: "local" },
    });
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledTimes(1);
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("hermes", HERMES_TARGET, config);
    expect(deps.calls.writeSandboxConfig.mock.calls[0][1].configPath).toBe(
      "/sandbox/.hermes/config.yaml",
    );
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledWith("hermes", HERMES_TARGET);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      }),
    );
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
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expect(deps.calls.resolveContextWindowForModel).toHaveBeenCalledWith(
      "hermes-provider",
      "openai/gpt-5.4-mini",
    );
  });

  it("uses Hermes model discovery when the selected context window is unavailable", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
        provider: "custom",
        base_url: "https://inference.local/v1",
        context_length: 32_768,
      },
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
      contextWindow: null,
    });

    await runInferenceSet(
      {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(config.model).not.toHaveProperty("context_length");
    const logs = deps.calls.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("omitting context_length so Hermes can discover it");
  });

  it("re-seeds the isolated Hermes dashboard config after an in-place switch (#6893)", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
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
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });

    await runInferenceSet(
      {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    // The dashboard-home config only re-mirrors the gateway model routing at
    // startup, so the in-place switch must re-seed it or Dashboard Chat stays on
    // the previous model. It must run after the gateway config was written.
    expect(deps.calls.seedHermesDashboardConfig).toHaveBeenCalledWith("hermes", HERMES_TARGET);
    const writeOrder = deps.calls.writeSandboxConfig.mock.invocationCallOrder[0];
    const seedOrder = deps.calls.seedHermesDashboardConfig.mock.invocationCallOrder[0];
    expect(seedOrder).toBeGreaterThan(writeOrder);
  });

  it("fails after commit when the in-sandbox config write fails (#7083)", async () => {
    const config: ConfigObject = {
      model: { default: "moonshotai/kimi-k2.6", provider: "custom" },
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
    deps.calls.writeSandboxConfig.mockImplementation(() => {
      throw new Error("write failed");
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "InferenceSetError",
      exitCode: 1,
      message: expect.stringMatching(/Hermes inference route synchronization did not complete/),
    });

    // A failed in-sandbox Hermes config write leaves the old config in place; re-seeding the
    // dashboard from it would be pointless. The host route remains committed, but
    // the command must fail so automation cannot accept a partial switch.
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      }),
    );
    expect(deps.calls.seedHermesDashboardConfig).not.toHaveBeenCalled();
  });

  it("fails after commit when the config hash refresh fails (#7083)", async () => {
    const config: ConfigObject = {
      model: { default: "moonshotai/kimi-k2.6", provider: "custom" },
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
    deps.calls.recomputeSandboxConfigHash.mockImplementation(() => {
      throw new Error("hash refresh failed");
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "InferenceSetError",
      exitCode: 1,
      message: expect.stringMatching(/Hermes inference route synchronization did not complete/),
    });

    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledOnce();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      }),
    );
    expect(deps.calls.seedHermesDashboardConfig).not.toHaveBeenCalled();
    const logs = deps.calls.log.mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("failed to refresh its integrity hash"))).toBe(true);
    expect(logs.some((line) => line.includes("rebuild"))).toBe(true);
    expect(logs.some((line) => line.includes("Inference route synced"))).toBe(false);
  });

  it("fails after commit when the dashboard does not converge (#6893)", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
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
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
      seedHermesDashboardConfigResult: "failed",
    });

    await expect(
      runInferenceSet(
        {
          provider: "hermes-provider",
          model: "openai/gpt-5.4-mini",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "InferenceSetError",
      exitCode: 1,
      message: expect.stringMatching(/committed route was not rolled back.*Restart the sandbox/u),
    });

    // The route, main config, durable session, and audit are already committed,
    // but the command must fail instead of claiming complete convergence.
    expect(deps.getSession()?.model).toBe("openai/gpt-5.4-mini");
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledOnce();
    const logs = deps.calls.log.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("Inference route synced"))).toBe(false);
    expect(logs.some((l) => l.includes("could not refresh the dashboard"))).toBe(true);
  });

  it("still reports synced when the dashboard profile is absent (Dashboard disabled) (#6893)", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
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
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
      seedHermesDashboardConfigResult: "absent",
    });

    await runInferenceSet(
      {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    // Nothing to converge — the switch is fully applied, so it still reports synced
    // and does not warn.
    const logs = deps.calls.log.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("Inference route synced"))).toBe(true);
    expect(logs.some((l) => l.includes("could not refresh the dashboard"))).toBe(false);
  });

  it("keeps Hermes custom Anthropic switches off the managed Anthropic SSE frontend (#6289)", async () => {
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
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });
    deps.calls.captureOpenshell.mockImplementation((args: string[]) =>
      args[0] === "provider" && args[1] === "get"
        ? {
            status: 0,
            output:
              "Name: compatible-anthropic-endpoint\nType: openai\nCredential keys: COMPATIBLE_ANTHROPIC_API_KEY\nConfig keys: OPENAI_BASE_URL",
            stdout: "",
            stderr: "",
          }
        : { status: 0, output: "", stdout: "", stderr: "" },
    );

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
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_REWRITE_SENTINEL,
    });
    // The upstream annotation must track the selected provider together with
    // the API-family field, so the two cannot drift apart on later switches.
    expect(config._nemoclaw_upstream).toEqual({
      provider: "compatible-anthropic-endpoint",
      provider_key: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "hermes",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "openai-completions",
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/claude-sonnet-proxy",
    });
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("rejects inference set before mutating a legacy Anthropic provider (#6289)", async () => {
    const config: ConfigObject = { model: {} };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });
    deps.calls.captureOpenshell.mockReturnValue({
      status: 0,
      output:
        "Name: compatible-anthropic-endpoint\nType: anthropic\nCredential keys: COMPATIBLE_ANTHROPIC_API_KEY\nConfig keys: ANTHROPIC_BASE_URL",
      stdout: "",
      stderr: "",
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
          sandboxName: "hermes",
          noVerify: true,
        },
        deps,
      ),
    ).rejects.toThrow("Run 'nemoclaw hermes rebuild'");

    expect(deps.calls.captureOpenshell).toHaveBeenCalledTimes(1);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("rejects an explicit Anthropic frontend request for Hermes custom endpoints (#6289)", async () => {
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
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-anthropic-endpoint",
          model: "nvidia/nvidia/nemotron-3-super-v3",
          sandboxName: "hermes",
          noVerify: true,
          endpointUrl: "https://inference-api.nvidia.com",
          credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      ),
    ).rejects.toThrow("require the managed openai-completions frontend");

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
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
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
      api_key: HERMES_PROXY_REWRITE_SENTINEL,
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
        {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw-9090",
          gatewayPort: 9090,
          provider: "nvidia-prod",
          model: "nvidia/model-a",
        },
        {
          name: "hermes-one",
          agent: "hermes",
          provider: "hermes-provider",
          model: "z-ai/glm-5.1",
        },
      ],
      defaultSandbox: "alpha",
      requestedAgent: "hermes",
      target: HERMES_TARGET,
    });

    await runInferenceSet({ provider: "hermes-provider", model: "z-ai/glm-5.1" }, deps);

    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("hermes-one", HERMES_TARGET, config);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes-one",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "z-ai/glm-5.1",
      }),
    );
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

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });
});
