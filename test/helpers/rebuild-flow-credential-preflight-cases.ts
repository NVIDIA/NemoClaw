// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createRebuildFlowHarness, installRebuildFlowTestHooks } from "./rebuild-flow-test-harness";

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
  return (args: string[]) => {
    if (args[0] !== "provider" || args[1] !== "get") {
      return { status: 0, output: "", stdout: "", stderr: "" };
    }
    const provider = args[2];
    if (!registeredProviders.includes(provider)) {
      return { status: 1, output: "", stdout: "", stderr: "provider missing" };
    }
    const credentialEnv = credentialKeys[provider] ?? "NVIDIA_INFERENCE_API_KEY";
    const output = [
      `Name: ${provider}`,
      "Type: openai",
      `Credential keys: ${credentialEnv}`,
      "Config keys: OPENAI_BASE_URL",
    ].join("\n");
    return { status: 0, output, stdout: output, stderr: "" };
  };
}

function diagnostics(harness: Harness): string {
  return harness.errorSpy.mock.calls.flat().map(String).join("\n");
}

function makeMessagingPlan() {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "hermes",
    workflow: "onboard",
    channels: [
      {
        channelId: "discord",
        displayName: "discord",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function registerRebuildFlowCredentialPreflightTests(): void {
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

    it("copies the staged Hermes messaging plan into the rebuild resume session", async () => {
      const plan = makeMessagingPlan();
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

    it.each([
      "ollama-local",
      "vllm-local",
    ])("migrates a legacy %s target away from OPENAI_API_KEY (#2519)", async (provider) => {
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
    });

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
}
