// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectGpu: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  ensureValidatedWebSearchCredential: vi.fn(),
  isDockerDesktopWslRuntime: vi.fn(),
  isLinuxDockerDriverGatewayEnabled: vi.fn(),
  preflightRebuildCredentials: vi.fn(),
  readGatewayProviderMetadata: vi.fn(),
  runOpenshell: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../inference/nim", () => ({
  detectGpu: mocks.detectGpu,
}));

vi.mock("../../onboard/gateway-provider-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../onboard/gateway-provider-metadata")>();
  return { ...actual, readGatewayProviderMetadata: mocks.readGatewayProviderMetadata };
});

vi.mock("./rebuild-onboard-dependencies", () => ({
  rebuildOnboardDependencies: {
    ensureValidatedWebSearchCredential: mocks.ensureValidatedWebSearchCredential,
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
import type { RebuildTargetConfig } from "./rebuild-target-config";
import { preflightRebuildTargetRuntime } from "./rebuild-target-runtime";

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
const ENTRY = { mcp: null } as unknown as RebuildSandboxEntry;
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

  it.each([
    { control: "auto", selectedRoute: "native" },
    { control: "fallback", selectedRoute: "native" },
    { control: "1", selectedRoute: "compatibility" },
  ] as const)("passes the $selectedRoute rebuild GPU route into network preflight (#6110)", async ({
    control,
    selectedRoute,
  }) => {
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
      },
    );
    expect(bail).not.toHaveBeenCalled();
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
      .mockResolvedValue({ ok: true, imageTag: "preflight:test", prepared: null } as never);
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
});

describe("preflightRebuildTargetRuntime web search credential", () => {
  const WEB_SEARCH_TARGET = {
    ...TARGET,
    durableConfig: { webSearchConfig: { fetchEnabled: true, provider: "brave" } },
  } as unknown as RebuildTargetConfig;
  const WEB_SEARCH_ENTRY = { name: "my-assistant", mcp: null } as unknown as RebuildSandboxEntry;
  const GATEWAY_BINDING_METADATA = {
    name: "my-assistant-brave-search",
    type: "brave",
    credentialKeys: ["BRAVE_API_KEY"],
    configKeys: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
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

  async function runPreflight(
    target: RebuildTargetConfig = WEB_SEARCH_TARGET,
  ): Promise<{ result: unknown; log: ReturnType<typeof vi.fn>; bail: ReturnType<typeof vi.fn> }> {
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
      durableConfig: { webSearchConfig: { fetchEnabled: true, provider: "tavily" } },
      agentDefinition: { name: "hermes", webSearch: { supported: true, providers: ["tavily"] } },
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
