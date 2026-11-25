// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeLocalIdentity } from "../../inference/native-local/contract";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { preflightAuthoritativeRebuildTarget } from "../../onboard/authoritative-rebuild-target";

const mocks = vi.hoisted(() => ({
  detectGpu: vi.fn(),
  detectGpuWithRuntimeProviderProof: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  ensureValidatedWebSearchCredential: vi.fn(),
  isDockerDesktopWslRuntime: vi.fn(),
  isLinuxDockerDriverGatewayEnabled: vi.fn(),
  preflightAuthoritativeRebuildTarget: vi.fn(),
  preflightRebuildCredentials: vi.fn(),
  readGatewayProviderMetadata: vi.fn(),
  runOpenshell: vi.fn(),
  providerAdapter: vi.fn(),
}));

vi.mock("../../adapters/openshell/managed-provider-adapter", () => ({
  createManagedProviderAdapter: mocks.providerAdapter,
}));
vi.mock("../../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../inference/nim", () => ({
  detectGpu: mocks.detectGpu,
}));

vi.mock("../../onboard/gateway-provider-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../onboard/gateway-provider-metadata")>();
  return {
    ...actual,
    readGatewayProviderMetadata: mocks.readGatewayProviderMetadata,
  };
});

vi.mock("./rebuild-onboard-dependencies", () => ({
  rebuildOnboardDependencies: {
    detectGpuWithRuntimeProviderProof: mocks.detectGpuWithRuntimeProviderProof,
    ensureValidatedWebSearchCredential: mocks.ensureValidatedWebSearchCredential,
    preflightAuthoritativeRebuildTarget: mocks.preflightAuthoritativeRebuildTarget,
  },
}));

vi.mock("../../onboard/docker-driver-platform", () => ({
  isLinuxDockerDriverGatewayEnabled: mocks.isLinuxDockerDriverGatewayEnabled,
}));

vi.mock("../../onboard/docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
}));

vi.mock("../../onboard/docker-gpu-sandbox-create", () => ({
  isDockerDesktopWslRuntime: mocks.isDockerDesktopWslRuntime,
}));

vi.mock("./rebuild-credential-preflight", () => ({
  preflightRebuildCredentials: mocks.preflightRebuildCredentials,
}));

import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import type { RebuildTargetConfig } from "./rebuild-target-config";
import {
  preflightAuthoritativeOnboardRuntime,
  preflightRebuildTargetRuntime,
} from "./rebuild-target-runtime";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const TARGET = {
  resumeConfig: {
    provider: "ollama-local",
    model: "test-model",
  },
  durableConfig: {
    webSearchConfig: null,
  },
  hermesToolGateways: [],
  credentialEnv: null,
  fromDockerfile: null,
  agentDefinition: null,
} as unknown as RebuildTargetConfig;
const ENTRY = { mcp: null, openshellDriver: "docker" } as unknown as RebuildSandboxEntry;
const RECREATE_OPTIONS = {
  sandboxGpu: "enable",
  sandboxGpuDevice: null,
  controlUiPort: 18789,
  targetGatewayPort: 8080,
} as RebuildRecreateOnboardOpts;

describe("preflightRebuildTargetRuntime GPU route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    mocks.detectGpuWithRuntimeProviderProof.mockReturnValue({
      type: "nvidia",
      name: "NVIDIA test GPU",
      count: 1,
      totalMemoryMB: 24_576,
      perGpuMB: 24_576,
      nimCapable: true,
      platform: "linux",
      containerGpuProof: { providerId: "docker", passed: true },
    });
    mocks.isLinuxDockerDriverGatewayEnabled.mockReturnValue(true);
    mocks.isDockerDesktopWslRuntime.mockReturnValue(false);
    mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
    mocks.preflightRebuildCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
  });

  it.each([
    { control: "auto", selectedRoute: "native" },
    { control: "fallback", selectedRoute: "native" },
    { control: "1", selectedRoute: "compatibility" },
  ] as const)(
    "passes the $selectedRoute rebuild GPU route into network preflight (#6110)",
    async ({ control, selectedRoute }) => {
      vi.stubEnv("NEMOCLAW_DOCKER_GPU_PATCH", control);
      const log = vi.fn();
      const bail = vi.fn((message: string): never => {
        throw new Error(message);
      });

      await expect(
        preflightRebuildTargetRuntime(TARGET, ENTRY, RECREATE_OPTIONS, log, bail, {
          skipImagePreflight: true,
        }),
      ).resolves.toEqual({
        ok: true,
        preparedImage: null,
        requiresGatewayProviderReconfigure: false,
      });

      expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledOnce();
      expect(mocks.detectGpuWithRuntimeProviderProof).toHaveBeenCalledExactlyOnceWith("docker");
      expect(mocks.detectGpu).not.toHaveBeenCalled();
      expect(mocks.enforceDockerGpuPatchPreserveNetwork).toHaveBeenCalledWith(
        "ollama-local",
        expect.objectContaining({
          sandboxGpuEnabled: true,
          hostGpuPlatform: "linux",
          sandboxGpuDevice: null,
        }),
        {
          dockerDriverGateway: true,
          selectedRoute,
          gatewayPort: 8080,
          log,
          reverifyBridgeReachability: expect.any(Function),
        },
      );
      expect(bail).not.toHaveBeenCalled();
    },
  );

  it("uses the validated resume endpoint for credential preflight", async () => {
    const endpointUrl = "http://localhost:11434/v1";
    const target = {
      ...TARGET,
      resumeConfig: {
        ...TARGET.resumeConfig,
        provider: "compatible-endpoint",
        endpointUrl,
      },
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    } as RebuildTargetConfig;
    const entry = {
      ...ENTRY,
      provider: "compatible-endpoint",
      model: "test-model",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    } as RebuildSandboxEntry;

    await expect(
      preflightRebuildTargetRuntime(target, entry, RECREATE_OPTIONS, vi.fn(), vi.fn() as never, {
        skipImagePreflight: true,
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(mocks.preflightRebuildCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it("passes the immutable base provenance into replacement image preflight (#7144)", async () => {
    const metadata = {
      schema: 1,
      key: "current-base",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      ref: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      digest: `sha256:${"a".repeat(64)}`,
      source: "pinned",
      pinnedRemoteRef: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"a".repeat(64)}`,
      imageId: `sha256:${"b".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.41",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    } as const;
    const imagePreflight = vi
      .spyOn(rebuildImagePreflight, "preflightRebuildImage")
      .mockResolvedValue({
        ok: true,
        imageTag: "preflight:test",
        prepared: null,
      } as never);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    try {
      await expect(
        preflightRebuildTargetRuntime(
          TARGET,
          ENTRY,
          { ...RECREATE_OPTIONS, preResolvedBaseImageMetadata: metadata },
          vi.fn(),
          bail,
        ),
      ).resolves.toEqual({
        ok: true,
        preparedImage: null,
        requiresGatewayProviderReconfigure: false,
      });

      expect(imagePreflight).toHaveBeenCalledWith(
        expect.objectContaining({ preResolvedBaseImageMetadata: metadata }),
      );
    } finally {
      imagePreflight.mockRestore();
    }
  });

  it("builds the replacement image with the recorded dashboard origin (#13177)", async () => {
    vi.stubEnv("CHAT_UI_URL", "https://ambient.example.test");
    const imagePreflight = vi
      .spyOn(rebuildImagePreflight, "preflightRebuildImage")
      .mockResolvedValue({ ok: true, imageTag: "preflight:test", prepared: null } as never);
    try {
      await expect(
        preflightRebuildTargetRuntime(
          TARGET,
          { ...ENTRY, dashboardExternalUrl: "https://launchpad.example.test:18789" },
          { ...RECREATE_OPTIONS, controlUiPort: 18_790 },
          vi.fn(),
          vi.fn() as never,
        ),
      ).resolves.toMatchObject({ ok: true });

      expect(imagePreflight).toHaveBeenCalledWith(
        expect.objectContaining({ chatUiUrl: "https://launchpad.example.test:18790" }),
      );
    } finally {
      imagePreflight.mockRestore();
    }
  });
});

function nativeHostedRebuildHarness(selection: {
  provider: string;
  profileId: string;
  providerName: string;
  credentialEnv: string;
  field: "nativeNvidiaProviderAttachment" | "nativeHostedProviderAttachment";
}) {
  const receipt = {
    schemaVersion: 1 as const,
    profileId: selection.profileId,
    providerName: selection.providerName,
    providerId: "owned",
  };
  const metadata = {
    name: receipt.providerName,
    type: receipt.profileId,
    credentialKeys: [selection.credentialEnv],
    configKeys: [],
    revision: { id: "owned", resourceVersion: 1 },
  };
  const adapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true as const, value: undefined })),
    getProvider: vi.fn(async () => ({ ok: true as const, value: metadata })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true as const,
      value: { names: [receipt.providerName] },
    })),
  };
  mocks.providerAdapter.mockReturnValue(adapter as unknown as OpenShellProviderAdapter);
  const route = vi.fn(() => "mismatched" as const);
  const authority = { checkpoint: "gateway-authority" };
  mocks.preflightAuthoritativeRebuildTarget.mockImplementation(async (options) => {
    await preflightAuthoritativeRebuildTarget(
      { ...options, controlUiPort: null },
      {
        resolveBaselinePolicy: () => ({}),
        bindGatewayAuthority: vi.fn(),
        runFatalRuntimePreflight: vi.fn(),
        ensureOpenshell: vi.fn(),
        assertGatewayReadiness: vi.fn(),
        inferenceRouteState: route,
        observeForwardPorts: vi.fn(),
      },
    );
    return authority;
  });
  const resumeConfig = {
    ...TARGET.resumeConfig,
    agent: "openclaw",
    provider: selection.provider,
    [selection.field]: receipt,
  } as RebuildResumeConfig;
  const options = { ...RECREATE_OPTIONS, targetGatewayName: "nemoclaw" };
  const run = () =>
    preflightAuthoritativeOnboardRuntime("alpha", resumeConfig, options, (message): never => {
      throw new Error(message);
    });
  return { adapter, authority, metadata, options, receipt, resumeConfig, route, run };
}

const NATIVE_NVIDIA_REBUILD_SELECTION = {
  provider: "nvidia-prod",
  profileId: "nemoclaw-nvidia-inference-v1",
  providerName: "nemoclaw-nvidia-prod-v1",
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  field: "nativeNvidiaProviderAttachment" as const,
};

describe("authoritative rebuild readiness", () => {
  afterEach(() => {
    mocks.preflightAuthoritativeRebuildTarget.mockReset();
  });

  it.each([
    NATIVE_NVIDIA_REBUILD_SELECTION,
    {
      provider: "openai-api",
      profileId: "nemoclaw-openai-inference-v1",
      providerName: "nemoclaw-openai-api-v1",
      credentialEnv: "OPENAI_API_KEY",
      field: "nativeHostedProviderAttachment" as const,
    },
    {
      provider: "anthropic-prod",
      profileId: "nemoclaw-anthropic-inference-v1",
      providerName: "nemoclaw-anthropic-prod-v1",
      credentialEnv: "ANTHROPIC_API_KEY",
      field: "nativeHostedProviderAttachment" as const,
    },
  ])("verifies the recorded $provider attachment instead of a shared route", async (selection) => {
    const h = nativeHostedRebuildHarness(selection);
    await expect(h.run()).resolves.toBe(true);
    expect(h.options.rebuildGatewayAuthority).toBe(h.authority);
    expect(h.route).not.toHaveBeenCalled();
    expect(h.adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringContaining(`${selection.profileId}.yaml`),
    });
    expect(h.adapter.getProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: selection.providerName,
    });
    expect(h.adapter.listProviderAttachments).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
    });
  });

  it("rejects a changed native NVIDIA provider identity before granting rebuild authority", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    h.metadata.revision.id = "replacement";
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.listProviderAttachments).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it("rejects a missing native NVIDIA sandbox attachment without falling back to a shared route", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    h.adapter.listProviderAttachments.mockResolvedValue({ ok: true, value: { names: [] } });
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.route).not.toHaveBeenCalled();
  });

  it("rejects native NVIDIA authority paired with a different logical provider", async () => {
    const h = nativeHostedRebuildHarness({
      ...NATIVE_NVIDIA_REBUILD_SELECTION,
      provider: "openai-api",
    });
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.getProvider).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it("rejects a native NVIDIA provider with unexpected credential keys", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    h.metadata.credentialKeys = ["UNRELATED_API_KEY"];
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.listProviderAttachments).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it("preserves native profile verification failure without granting rebuild authority", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    h.adapter.importProviderProfile.mockRejectedValue(new Error("profile boundary unavailable"));
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.getProvider).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it("rejects an unavailable native provider observation without using the shared route", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    h.adapter.getProvider.mockRejectedValue(new Error("provider observation unavailable"));
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.listProviderAttachments).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it("rejects conflicting native local and NVIDIA authority before inspecting a provider", async () => {
    const h = nativeHostedRebuildHarness(NATIVE_NVIDIA_REBUILD_SELECTION);
    const binding = {
      provider: "compatible-endpoint" as const,
      endpointUrl: "http://host.openshell.internal:11435/v1",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "authenticated" as const,
      gatewayName: "nemoclaw",
      sandboxName: "alpha",
    };
    Object.assign(h.resumeConfig, {
      nativeLocalProviderAttachment: {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1,
        providerId: "local-owned",
      },
    });
    await expect(h.run()).rejects.toThrow("Replacement onboarding preflight failed");
    expect(h.options).not.toHaveProperty("rebuildGatewayAuthority");
    expect(h.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(h.adapter.getProvider).not.toHaveBeenCalled();
    expect(h.route).not.toHaveBeenCalled();
  });

  it.each(["authenticated", "sentinel"] as const)(
    "rebuilds the recorded %s local attachment when the shared route differs (#13197)",
    async (authMode) => {
      const binding = {
        provider: "compatible-endpoint" as const,
        endpointUrl: "http://host.openshell.internal:11435/v1",
        credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        authMode,
        gatewayName: "nemoclaw",
        sandboxName: "alpha",
      };
      const receipt = {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "owned",
      };
      const providerAdapter = {
        inspectProviderProfile: vi.fn(async () => ({
          ok: true,
          value: { credentialKeys: [binding.credentialEnv] },
        })),
        getProvider: vi.fn(async () => ({
          ok: true,
          value: {
            name: receipt.providerName,
            type: receipt.profileId,
            credentialKeys: [binding.credentialEnv],
            configKeys: [],
            revision: { id: "owned", resourceVersion: 1 },
          },
        })),
        listProviderAttachments: vi.fn(async () => ({
          ok: true,
          value: { names: [receipt.providerName] },
        })),
      };
      mocks.providerAdapter.mockReturnValue(providerAdapter as unknown as OpenShellProviderAdapter);
      const route = vi.fn(() => "mismatched" as const);
      const readiness = vi.fn();
      const authority = { checkpoint: "gateway-authority" };
      mocks.preflightAuthoritativeRebuildTarget.mockImplementation(async (options) => {
        await preflightAuthoritativeRebuildTarget(
          { ...options, controlUiPort: null },
          {
            resolveBaselinePolicy: () => ({}),
            bindGatewayAuthority: vi.fn(),
            runFatalRuntimePreflight: readiness,
            ensureOpenshell: vi.fn(),
            assertGatewayReadiness: vi.fn(),
            inferenceRouteState: route,
            observeForwardPorts: vi.fn(),
          },
        );
        return authority;
      });
      const recreateOptions = { ...RECREATE_OPTIONS, targetGatewayName: "nemoclaw" };
      const bail = (message: string): never => {
        throw new Error(message);
      };
      try {
        await expect(
          preflightAuthoritativeOnboardRuntime(
            "alpha",
            {
              ...TARGET.resumeConfig,
              agent: "langchain-deepagents-code",
              provider: binding.provider,
              nativeLocalProviderAttachment: receipt,
            },
            recreateOptions,
            bail,
          ),
        ).resolves.toBe(true);
        expect(recreateOptions.rebuildGatewayAuthority).toBe(authority);
        expect(readiness).toHaveBeenCalledOnce();
        expect(route).not.toHaveBeenCalled();
        expect(providerAdapter.getProvider).toHaveBeenCalledWith({
          target: { kind: "named", gatewayName: "nemoclaw" },
          providerName: receipt.providerName,
        });
        expect(providerAdapter.listProviderAttachments).toHaveBeenCalledWith({
          target: { kind: "named", gatewayName: "nemoclaw" },
          sandboxName: "alpha",
        });
      } finally {
        mocks.preflightAuthoritativeRebuildTarget.mockReset();
      }
    },
  );

  it("passes recorded managed-vLLM intent to the pre-delete readiness gate (#9292)", async () => {
    const authority = { checkpoint: "gateway-authority" };
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };
    mocks.preflightAuthoritativeRebuildTarget.mockResolvedValue(authority);
    const recreateOptions = {
      ...RECREATE_OPTIONS,
      allowDeferredN1xManagedVllm: true,
      allowLegacyDgxStationQualification: true,
      runtimeSelection,
    } as RebuildRecreateOnboardOpts;
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      preflightAuthoritativeOnboardRuntime(
        "alpha",
        { provider: "vllm-local", model: "test-model" } as RebuildResumeConfig,
        recreateOptions,
        bail,
      ),
    ).resolves.toBe(true);

    expect(mocks.preflightAuthoritativeRebuildTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDeferredN1xManagedVllm: true,
        allowLegacyDgxStationQualification: true,
        provider: "vllm-local",
        model: "test-model",
        runtimeSelection,
        sandboxName: "alpha",
      }),
    );
    expect(recreateOptions.rebuildGatewayAuthority).toBe(authority);
    expect(bail).not.toHaveBeenCalled();
  });
});

describe("preflightRebuildTargetRuntime web search credential", () => {
  const WEB_SEARCH_TARGET = {
    ...TARGET,
    durableConfig: {
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    },
  } as unknown as RebuildTargetConfig;
  const WEB_SEARCH_ENTRY = {
    name: "my-assistant",
    mcp: null,
  } as unknown as RebuildSandboxEntry;
  const GATEWAY_BINDING_METADATA = {
    name: "my-assistant-brave-search",
    type: "brave",
    credentialKeys: ["BRAVE_API_KEY"],
    configKeys: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });
    vi.stubEnv("BRAVE_API_KEY", "");
    mocks.detectGpu.mockReturnValue({
      type: "nvidia",
      name: "NVIDIA test GPU",
      count: 1,
      totalMemoryMB: 24_576,
      perGpuMB: 24_576,
      nimCapable: true,
      platform: "linux",
    });
    mocks.isLinuxDockerDriverGatewayEnabled.mockReturnValue(true);
    mocks.isDockerDesktopWslRuntime.mockReturnValue(false);
    mocks.enforceDockerGpuPatchPreserveNetwork.mockResolvedValue(false);
    mocks.preflightRebuildCredentials.mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
  });

  async function runPreflight(target: RebuildTargetConfig = WEB_SEARCH_TARGET): Promise<{
    result: unknown;
    log: ReturnType<typeof vi.fn>;
    bail: ReturnType<typeof vi.fn>;
  }> {
    const log = vi.fn();
    const bail = vi.fn();
    const result = await preflightRebuildTargetRuntime(
      target,
      WEB_SEARCH_ENTRY,
      RECREATE_OPTIONS,
      log,
      bail as never,
      { skipImagePreflight: true },
    );
    return { result, log, bail };
  }

  it("reuses the gateway-registered web search credential when no host key is staged (#7097)", async () => {
    mocks.readGatewayProviderMetadata.mockReturnValue(GATEWAY_BINDING_METADATA);

    const { result, log, bail } = await runPreflight();

    expect(result).toEqual({
      ok: true,
      preparedImage: null,
      requiresGatewayProviderReconfigure: false,
    });
    expect(mocks.readGatewayProviderMetadata).toHaveBeenCalledWith(
      "my-assistant-brave-search",
      mocks.runOpenshell,
      "nemoclaw",
    );
    expect(mocks.ensureValidatedWebSearchCredential).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("my-assistant-brave-search"));
    expect(bail).not.toHaveBeenCalled();
  });

  it("fails preflight when neither a host key nor a matching gateway binding exists", async () => {
    mocks.readGatewayProviderMetadata.mockReturnValue(null);
    mocks.ensureValidatedWebSearchCredential.mockRejectedValue(
      new Error("Brave Search requires BRAVE_API_KEY or a saved Brave Search credential."),
    );

    const { result, bail } = await runPreflight();

    expect(result).toEqual({ ok: false });
    expect(mocks.ensureValidatedWebSearchCredential).toHaveBeenCalledWith(
      WEB_SEARCH_TARGET.durableConfig.webSearchConfig,
      true,
    );
    expect(bail).toHaveBeenCalledWith("Brave Search credential preflight failed");
  });

  it("fails closed when the gateway binding does not match the recorded provider (#7097)", async () => {
    mocks.readGatewayProviderMetadata.mockReturnValue({
      ...GATEWAY_BINDING_METADATA,
      credentialKeys: ["TAVILY_API_KEY"],
    });
    mocks.ensureValidatedWebSearchCredential.mockRejectedValue(
      new Error("Brave Search credential is unavailable."),
    );

    const { result, bail } = await runPreflight();

    expect(result).toEqual({ ok: false });
    expect(mocks.readGatewayProviderMetadata).toHaveBeenCalledOnce();
    expect(mocks.ensureValidatedWebSearchCredential).toHaveBeenCalledOnce();
    expect(bail).toHaveBeenCalledWith("Brave Search credential preflight failed");
  });

  it("validates the staged host key instead of reusing the gateway binding", async () => {
    vi.stubEnv("BRAVE_API_KEY", "staged-key");
    mocks.ensureValidatedWebSearchCredential.mockResolvedValue("staged-key");

    const { result, bail } = await runPreflight();

    expect(result).toEqual({
      ok: true,
      preparedImage: null,
      requiresGatewayProviderReconfigure: false,
    });
    expect(mocks.readGatewayProviderMetadata).not.toHaveBeenCalled();
    expect(mocks.ensureValidatedWebSearchCredential).toHaveBeenCalledOnce();
    expect(bail).not.toHaveBeenCalled();
  });

  it("keeps the validation path for non-OpenClaw agents that never reuse the binding", async () => {
    const hermesTarget = {
      ...WEB_SEARCH_TARGET,
      durableConfig: {
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      },
      agentDefinition: {
        name: "hermes",
        webSearch: { supported: true, providers: ["tavily"] },
      },
    } as unknown as RebuildTargetConfig;
    mocks.ensureValidatedWebSearchCredential.mockResolvedValue("gateway-side-key");

    const { result } = await runPreflight(hermesTarget);

    expect(result).toEqual({
      ok: true,
      preparedImage: null,
      requiresGatewayProviderReconfigure: false,
    });
    expect(mocks.readGatewayProviderMetadata).not.toHaveBeenCalled();
    expect(mocks.ensureValidatedWebSearchCredential).toHaveBeenCalledOnce();
  });
});
