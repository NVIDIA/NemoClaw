// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { cliOpenShellInstalledVersionObserver } from "../../../../test/helpers/rebuild-flow-harness";
import type { ServingProfileProvenance } from "../../inference/serving/profile-provenance";

const savedProfileProvenance: ServingProfileProvenance = {
  schemaVersion: 1,
  catalogDigest: `sha256:${"1".repeat(64)}`,
  preset: {
    id: "vllm.dgx-spark-gb10.single.example",
    digest: `sha256:${"2".repeat(64)}`,
    displayName: "Example Spark profile",
    supportState: "experimental",
  },
  recipe: {
    id: "vllm.dgx-spark-gb10.single.example",
    digest: `sha256:${"3".repeat(64)}`,
    backend: "vllm",
  },
  model: { id: "example/model", revision: "revision-1" },
  runtimeImage: null,
  estimatedImageDownloadBytes: null,
  estimatedModelDownloadBytes: null,
};

describe("rebuildSandbox flow: target session", () => {
  installRebuildFlowTestHooks();

  it.each(["alpha", "other"])(
    "preserves saved profile metadata with current session %s (#11417)",
    async (sessionSandboxName) => {
      let recreatedProvenance: unknown;
      const harness = createRebuildFlowHarness({
        sessionSandboxName,
        sandboxEntry: {
          provider: "build",
          model: "example/model",
          servingProfileProvenance: savedProfileProvenance,
        },
        onboard: (session) => {
          recreatedProvenance = session.servingProfileProvenance;
        },
      });
      harness.session.provider = "build";
      harness.session.model = "example/model";
      // Stale session metadata must not replace the sandbox's saved metadata.
      harness.session.servingProfileProvenance = {
        ...savedProfileProvenance,
        catalogDigest: `sha256:${"4".repeat(64)}`,
      };

      await harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true });

      expect(recreatedProvenance).toEqual(savedProfileProvenance);
    },
  );

  it.each(["alpha", "other"])(
    "keeps missing profile metadata absent with current session %s (#11417)",
    async (sessionSandboxName) => {
      let recreatedProvenance: unknown;
      const harness = createRebuildFlowHarness({
        sessionSandboxName,
        sandboxEntry: {
          provider: "build",
          model: "example/model",
          servingProfileProvenance: undefined,
        },
        onboard: (session) => {
          recreatedProvenance = session.servingProfileProvenance;
        },
      });
      harness.session.provider = "build";
      harness.session.model = "example/model";
      harness.session.servingProfileProvenance = savedProfileProvenance;

      await harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true });

      expect(recreatedProvenance).toBeNull();
    },
  );

  it("isolates ambient onboard-selection env during recreate, then restores it (#5735)", async () => {
    const restoreEnv = snapshotEnv([
      "NEMOCLAW_AGENT",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_PROVIDER_KEY",
      "NVIDIA_INFERENCE_API_KEY",
    ]);
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    process.env.NEMOCLAW_PROVIDER = "install-vllm";
    process.env.NEMOCLAW_PROVIDER_KEY = "sk-bogus-installer-key";
    process.env.NVIDIA_INFERENCE_API_KEY = "hosted-source-key";

    let envSeenInsideOnboard: {
      agent: string | undefined;
      provider: string | undefined;
      providerKey: string | undefined;
      hostedSourceKey: string | undefined;
    } | null = null;

    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        onboard: () => {
          envSeenInsideOnboard = {
            agent: process.env.NEMOCLAW_AGENT,
            provider: process.env.NEMOCLAW_PROVIDER,
            providerKey: process.env.NEMOCLAW_PROVIDER_KEY,
            hostedSourceKey: process.env.NVIDIA_INFERENCE_API_KEY,
          };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenInsideOnboard).toEqual({
        agent: undefined,
        provider: undefined,
        providerKey: undefined,
        hostedSourceKey: "hosted-source-key",
      });
      const logged = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("Ignoring ambient NEMOCLAW_AGENT='langchain-deepagents-code'");
      expect(process.env.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
      expect(process.env.NEMOCLAW_PROVIDER).toBe("install-vllm");
      expect(process.env.NEMOCLAW_PROVIDER_KEY).toBe("sk-bogus-installer-key");
      expect(process.env.NVIDIA_INFERENCE_API_KEY).toBe("hosted-source-key");
    } finally {
      restoreEnv();
    }
  });

  it("stops an unattached N1x managed-vLLM rebuild before deleting the sandbox (#10955)", async () => {
    const restoreEnv = snapshotEnv(["NEMOCLAW_PROVIDER"]);
    process.env.NEMOCLAW_PROVIDER = "install-vllm";
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: {
          provider: "vllm-local",
          model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
          endpointUrl: null,
          endpointSource: null,
          openshellDriver: "docker",
          hostLocalInferenceReceipt: null,
          nimContainer: null,
        },
      });
      harness.session.provider = "vllm-local";
      harness.session.model = "nvidia/Qwen3.6-35B-A3B-NVFP4";
      harness.session.endpointUrl = null;
      harness.session.credentialEnv = null;
      harness.session.preferredInferenceApi = "openai-completions";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Legacy shared local inference cannot be rebuilt safely");
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(process.env.NEMOCLAW_PROVIDER).toBe("install-vllm");
    } finally {
      restoreEnv();
    }
  });

  it.each([
    { provider: "ollama-local", version: "0.1.3" },
    { provider: "vllm-local", version: "0.1.3" },
    { provider: "ollama-local", version: null },
    { provider: "vllm-local", version: null },
  ])(
    "refuses a retained Pi $provider rebuild before state changes with runtime version=$version",
    async ({ provider, version }) => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          agent: "pi",
          provider,
          model: "local-model",
          createdAt: "2026-09-01T00:00:00Z",
          nativeLocalProviderAttachment: undefined,
        },
      });
      const installedVersion = vi
        .spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion")
        .mockReturnValue(
          version === null
            ? { ok: false, error: { kind: "unavailable", message: "OpenShell binary not found." } }
            : { ok: true, version },
        );
      const before = structuredClone(harness.session);
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Legacy shared local inference cannot be rebuilt safely");
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
      expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.session).toEqual(before);
      expect(installedVersion).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { provider: "compatible-endpoint", version: "0.1.3" },
    { provider: "compatible-anthropic-endpoint", version: "0.1.3" },
    { provider: "compatible-endpoint", version: null },
  ])(
    "refuses retained public $provider rebuild before deletion on OpenShell $version",
    async ({ provider, version }) => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          agent: "openclaw",
          provider,
          model: "served-model",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          createdAt: "2026-09-01T00:00:00Z",
          nativeHostedProviderAttachment: undefined,
          nativeNvidiaProviderAttachment: undefined,
        },
      });
      vi.spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion").mockReturnValue(
        version === null
          ? { ok: false, error: { kind: "unavailable", message: "OpenShell binary not found." } }
          : { ok: true, version },
      );
      const before = structuredClone(harness.session);
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Legacy shared custom inference cannot be rebuilt safely");
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
      expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.session).toEqual(before);
    },
  );

  it("uses the exact preflighted agent base image only for the recreate", async () => {
    const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const restoreEnv = snapshotEnv([overrideEnvVar]);
    delete process.env[overrideEnvVar];
    let refSeenInsideOnboard: string | undefined;

    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          agent: "hermes",
          provider: "nvidia-prod",
          credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        },
        baseImagePreflight: {
          ok: true,
          imageRef: "nemoclaw-hermes-sandbox-base-local:12345678",
          overrideEnvVar,
        },
        onboard: () => {
          refSeenInsideOnboard = process.env[overrideEnvVar];
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(refSeenInsideOnboard).toBe("nemoclaw-hermes-sandbox-base-local:12345678");
      expect(process.env[overrideEnvVar]).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it("restores caller messaging config and plan env after rebuild", async () => {
    const keys = ["NEMOCLAW_MESSAGING_PLAN_B64", "TELEGRAM_REQUIRE_MENTION"];
    const restoreEnv = snapshotEnv(keys);
    process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "caller-plan";
    delete process.env.TELEGRAM_REQUIRE_MENTION;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        onboard: () => {
          process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "target-plan";
          process.env.TELEGRAM_REQUIRE_MENTION = "1";
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(process.env.NEMOCLAW_MESSAGING_PLAN_B64).toBe("caller-plan");
      expect(process.env.TELEGRAM_REQUIRE_MENTION).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it("recreates a matching-session custom-endpoint sandbox from a validated session endpoint while ignoring hostile ambient values for PRA-4 (#5735)", async () => {
    const restoreEnv = snapshotEnv([
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_PREFERRED_API",
      "COMPATIBLE_API_KEY",
    ]);
    process.env.NEMOCLAW_ENDPOINT_URL = "https://attacker.example.test/v1";
    process.env.NEMOCLAW_PROVIDER = "build";
    process.env.NEMOCLAW_MODEL = "attacker-model";
    process.env.NEMOCLAW_PREFERRED_API = "openai-responses";
    process.env.COMPATIBLE_API_KEY = "compat-key"; // pass credential preflight

    let envSeenInsideOnboard: Record<string, string | undefined> | null = null;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { provider: "compatible-endpoint", model: "session-model" },
        onboard: () => {
          envSeenInsideOnboard = {
            endpoint: process.env.NEMOCLAW_ENDPOINT_URL,
            provider: process.env.NEMOCLAW_PROVIDER,
            model: process.env.NEMOCLAW_MODEL,
            preferredApi: process.env.NEMOCLAW_PREFERRED_API,
          };
        },
      });
      harness.session.provider = "compatible-endpoint";
      harness.session.model = "session-model";
      harness.session.preferredInferenceApi = "openai-completions";
      harness.session.endpointUrl = "https://my-custom-endpoint.example/v1/";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenInsideOnboard).toEqual({
        endpoint: undefined,
        provider: undefined,
        model: undefined,
        preferredApi: undefined,
      });
      expect(harness.session.endpointUrl).toBe("https://my-custom-endpoint.example/v1");
      expect(harness.session.provider).toBe("compatible-endpoint");
      expect(harness.session.model).toBe("session-model");
      expect(harness.session.preferredInferenceApi).toBe("openai-completions");
      expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe("https://attacker.example.test/v1");
      expect(process.env.NEMOCLAW_PROVIDER).toBe("build");
      expect(process.env.NEMOCLAW_MODEL).toBe("attacker-model");
      expect(process.env.NEMOCLAW_PREFERRED_API).toBe("openai-responses");
    } finally {
      restoreEnv();
    }
  });

  it("aborts before backup/delete when a custom-endpoint target has no matching session (#5735)", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY"]);
    process.env.COMPATIBLE_API_KEY = "compat-key"; // pass credential preflight first
    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { provider: "compatible-endpoint", model: "custom-model" },
        sessionSandboxName: "some-other-sandbox",
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Cannot determine recreate endpoint");

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("cannot determine the inference endpoint");
      expect(errors).toContain("Sandbox is untouched");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });
});
