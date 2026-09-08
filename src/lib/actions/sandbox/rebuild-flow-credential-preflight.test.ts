// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeMessagingPlan } from "../../../../test/helpers/messaging-plan-fixtures";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { makePreparedRecoveryManifest } from "./rebuild-flow-test-fixtures";

type Harness = ReturnType<typeof createRebuildFlowHarness>;

const MODEL = "test/model";

function configureSession(
  harness: Harness,
  provider: string,
  credentialEnv: string | null,
  overrides: Record<string, unknown> = {},
): void {
  Object.assign(harness.session, {
    sandboxName: "alpha",
    provider,
    model: MODEL,
    credentialEnv,
    ...overrides,
  });
}

function providerRuntime(
  registeredProviders: readonly string[],
  credentialKeys: Record<string, string> = {},
) {
  const describeProvider = (provider: string) => {
    const credentialEnv = credentialKeys[provider] ?? "NVIDIA_INFERENCE_API_KEY";
    const output = [
      `Name: ${provider}`,
      "Type: openai",
      `Credential keys: ${credentialEnv}`,
      "Config keys: OPENAI_BASE_URL",
    ].join("\n");
    return { status: 0, output, stdout: output, stderr: "" };
  };
  const missingProvider = { status: 1, output: "", stdout: "", stderr: "provider not found" };
  return (args: string[]) => {
    const provider = args[0] === "provider" && args[1] === "get" ? args[2] : undefined;
    return provider === undefined
      ? undefined
      : registeredProviders.includes(provider)
        ? describeProvider(provider)
        : missingProvider;
  };
}

function diagnostics(harness: Harness): string {
  return harness.errorSpy.mock.calls.flat().map(String).join("\n");
}

function makeStagedHermesMessagingPlan() {
  return makeMessagingPlan({
    sandboxName: "alpha",
    agent: "hermes",
    channels: ["discord"],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: "alpha-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: "discord-bot-token-hash",
      },
    ],
  });
}

describe("rebuildSandbox flow: credential preflight", () => {
  installRebuildFlowTestHooks();

  it("aborts before backup when the target provider and credential are missing", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: nvidia-prod");

    const output = diagnostics(harness);
    expect(output).toContain("provider 'nvidia-prod' is not registered in OpenShell");
    expect(output).toContain("NVIDIA_INFERENCE_API_KEY");
    expect(output).not.toContain("provider credential not found");
    expect(output).not.toContain("export NVIDIA_INFERENCE_API_KEY=<your-key>");
    expect(output).toContain("Sandbox is untouched");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
  });

  it("continues when canonical hydration supplies a saved provider credential", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      hydrateCredentialEnv: (credentialEnv) =>
        credentialEnv === "NVIDIA_INFERENCE_API_KEY" ? "saved-provider-key" : null,
      runOpenshell: providerRuntime(["nvidia-prod"]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.hydrateCredentialEnvSpy).toHaveBeenCalledWith("NVIDIA_INFERENCE_API_KEY");
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it("does not let a host credential bypass a missing gateway provider", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      hydrateCredentialEnv: () => "host-provider-key",
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: nvidia-prod");

    expect(diagnostics(harness)).not.toContain("missing from gateway; recreating it");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("lets validated prepared recovery recreate a missing provider from a host key (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://inference.example.test/v1",
        preferredInferenceApi: "openai-completions",
      },
      hydrateCredentialEnv: () => "host-provider-key",
      runOpenshell: providerRuntime([]),
      sandboxInventory: {
        sandboxes: [{ name: "alpha", phase: "Error", readiness: "terminal" }],
      },
    });
    configureSession(harness, "compatible-endpoint", "COMPATIBLE_API_KEY", {
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["provider", "get", "compatible-endpoint"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        rebuildProviderReconfigure: {
          sandboxName: "alpha",
          provider: "compatible-endpoint",
          model: MODEL,
          credentialEnv: "COMPATIBLE_API_KEY",
          endpointUrl: "https://inference.example.test/v1",
        },
      }),
    );
  });

  it("aborts if the missing provider appears at the delete edge (#6114)", async () => {
    const missingProvider = providerRuntime([]);
    const registeredProvider = providerRuntime(["compatible-endpoint"], {
      "compatible-endpoint": "COMPATIBLE_API_KEY",
    });
    const providerLookups = [missingProvider, registeredProvider];
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://inference.example.test/v1",
        preferredInferenceApi: "openai-completions",
      },
      hydrateCredentialEnv: () => "host-provider-key",
      runOpenshell: (args) =>
        args[0] === "provider" ? (providerLookups.shift() ?? registeredProvider)(args) : undefined,
      staleRecovery: false,
    });
    configureSession(harness, "compatible-endpoint", "COMPATIBLE_API_KEY", {
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("changed during rebuild preflight");

    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("aborts if the provider credential disappears at the delete edge (#6114)", async () => {
    let credentialHydrations = 0;
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://inference.example.test/v1",
        preferredInferenceApi: "openai-completions",
      },
      hydrateCredentialEnv: () => {
        credentialHydrations += 1;
        return credentialHydrations < 3 ? "host-provider-key" : null;
      },
      runOpenshell: providerRuntime([]),
      staleRecovery: false,
    });
    configureSession(harness, "compatible-endpoint", "COMPATIBLE_API_KEY", {
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("became unavailable before sandbox deletion");

    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("aborts when the delete-edge provider lookup is indeterminate (#6114)", async () => {
    const missingProvider = providerRuntime([]);
    const indeterminateProvider = () => ({
      status: 7,
      output: "",
      stdout: "",
      stderr: "gateway transport unavailable",
    });
    const providerLookups = [missingProvider, indeterminateProvider];
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://inference.example.test/v1",
        preferredInferenceApi: "openai-completions",
      },
      hydrateCredentialEnv: () => "host-provider-key",
      runOpenshell: (args) =>
        args[0] === "provider"
          ? (providerLookups.shift() ?? indeterminateProvider)(args)
          : undefined,
      staleRecovery: false,
    });
    configureSession(harness, "compatible-endpoint", "COMPATIBLE_API_KEY", {
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("could not be verified before sandbox deletion");

    expectNoSandboxDelete(harness.runOpenshellSpy);
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("keeps prepared recovery fail-closed when the missing provider has no host key (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "https://inference.example.test/v1",
        preferredInferenceApi: "openai-completions",
      },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
      staleRecovery: true,
    });
    configureSession(harness, "compatible-endpoint", "COMPATIBLE_API_KEY", {
      endpointUrl: "https://inference.example.test/v1",
      preferredInferenceApi: "openai-completions",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Missing gateway provider: compatible-endpoint");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("copies the staged Hermes messaging plan into the rebuild resume session", async () => {
    const plan = makeStagedHermesMessagingPlan();
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        agent: "hermes",
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      buildMessagingRebuildPlan: () => plan,
      hydrateCredentialEnv: () => "saved-provider-key",
      runOpenshell: providerRuntime(["nvidia-prod"]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.agent).toBe("hermes");
    expect(
      (harness.session.messagingPlan as typeof plan).channels.map((channel) => channel.channelId),
    ).toEqual(["discord"]);
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
  });

  it("stops before backup when the agent base-image preflight fails", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { agent: "hermes" },
      baseImagePreflight: { ok: false, imageRef: null, overrideEnvVar: null },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureRebuildAgentBaseImageSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("skips credential hydration for local inference", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: "ollama-local", model: MODEL, credentialEnv: null },
      hydrateCredentialEnv: () => {
        throw new Error("local inference must not hydrate a credential");
      },
    });
    configureSession(harness, "ollama-local", null);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.hydrateCredentialEnvSpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it.each(["ollama-local", "vllm-local"])(
    "migrates a legacy %s target away from OPENAI_API_KEY (#2519)",
    async (provider) => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { provider, model: MODEL, credentialEnv: "OPENAI_API_KEY" },
      });
      configureSession(harness, provider, "OPENAI_API_KEY");

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      const output = harness.logSpy.mock.calls.flat().map(String).join("\n");
      expect(output).toContain("GH #2519");
      expect(output).toContain(provider);
      expect(harness.session.credentialEnv).toBeNull();
      expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when a matching session omits the remote target credential", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: "openai-api", model: MODEL, credentialEnv: null },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "openai-api", null);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: openai-api");

    expect(diagnostics(harness)).toContain("OPENAI_API_KEY");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("uses the registry target instead of a stale provider in the matching session", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: "openai-api", model: MODEL, credentialEnv: null },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime(["nvidia-prod"]),
    });
    configureSession(harness, "nvidia-prod", null);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: openai-api");

    expect(diagnostics(harness)).toContain("provider 'openai-api' is not registered");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("does not let a mismatched stale local session bypass the remote target preflight", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: "openai-api", model: MODEL, credentialEnv: null },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "ollama-local", "OPENAI_API_KEY", {
      sandboxName: "other-local-sandbox",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: openai-api");

    const output = diagnostics(harness);
    expect(output).toContain("OPENAI_API_KEY");
    expect(output).not.toContain("GH #2519");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("applies the same missing-provider preflight to non-NVIDIA remotes", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: "openai-api", model: MODEL },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "openai-api", "OPENAI_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: openai-api");

    expect(diagnostics(harness)).toContain("OPENAI_API_KEY");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("reuses a registered Hermes OAuth provider without a host OpenAI key", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        agent: "hermes",
        provider: "hermes-provider",
        model: MODEL,
        credentialEnv: "OPENAI_API_KEY",
        hermesAuthMethod: "oauth",
      },
      hermesCredentialKeys: ["OPENAI_API_KEY"],
      hermesProviderExists: true,
      hydrateCredentialEnv: () => null,
    });
    configureSession(harness, "hermes-provider", "OPENAI_API_KEY", {
      hermesAuthMethod: "oauth",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(diagnostics(harness)).not.toContain("Missing credential: OPENAI_API_KEY");
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it("reuses a registered nvidia-prod provider without a host key", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime(["nvidia-prod"]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(diagnostics(harness)).not.toContain("Missing credential: NVIDIA_INFERENCE_API_KEY");
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
  });

  it("rejects nvidia-prod when both gateway registration and host key are missing", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "nvidia-prod",
        model: MODEL,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      },
      hydrateCredentialEnv: () => null,
      runOpenshell: providerRuntime([]),
    });
    configureSession(harness, "nvidia-prod", "NVIDIA_INFERENCE_API_KEY");

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing gateway provider: nvidia-prod");

    expect(diagnostics(harness)).toContain("Sandbox is untouched");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("registers an exported Hermes API key before backup without logging it", async () => {
    const restoreEnv = snapshotEnv(["NOUS_API_KEY"]);
    process.env.NOUS_API_KEY = "nous-key-from-env";

    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          agent: "hermes",
          provider: "hermes-provider",
          model: MODEL,
          credentialEnv: "NOUS_API_KEY",
          hermesAuthMethod: "api_key",
        },
        hermesProviderExists: false,
      });
      configureSession(harness, "hermes-provider", "NOUS_API_KEY", {
        agent: "hermes",
        hermesAuthMethod: "api_key",
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.registerHermesInferenceProviderSpy).toHaveBeenCalledWith(
        "nous-key-from-env",
        expect.any(Function),
        "NOUS_API_KEY",
      );
      const output = [...harness.logSpy.mock.calls, ...harness.errorSpy.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(output).toContain(
        "Hermes Provider is not registered in OpenShell; registering it from the configured exported API-key environment variable before rebuild.",
      );
      expect(output).not.toContain("NOUS_API_KEY");
      expect(output).not.toContain("nous-key-from-env");
      expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
      expect(harness.registerHermesInferenceProviderSpy.mock.invocationCallOrder[0]!).toBeLessThan(
        harness.backupSandboxStateSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      restoreEnv();
    }
  });

  it("rejects missing Hermes OAuth state before backup", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        agent: "hermes",
        provider: "hermes-provider",
        model: MODEL,
        credentialEnv: "OPENAI_API_KEY",
        hermesAuthMethod: "oauth",
      },
      hermesProviderExists: false,
      hydrateCredentialEnv: () => null,
    });
    configureSession(harness, "hermes-provider", "OPENAI_API_KEY", {
      hermesAuthMethod: "oauth",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing Hermes Provider credentials");

    const output = diagnostics(harness);
    expect(output).toContain("Hermes Provider is not registered in OpenShell");
    expect(output).toContain("credentials must be stored in OpenShell");
    expect(output).not.toContain("Missing credential: OPENAI_API_KEY");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });
});
