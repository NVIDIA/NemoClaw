// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";

const prepareSandboxWorkloadSource = vi.hoisted(() => vi.fn());

vi.mock("../workload/preparation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workload/preparation")>()),
  prepareSandboxWorkloadSource,
}));

vi.mock("../../core/version", () => ({ getVersion: () => "v0.0.0" }));

import {
  createManagedHermesStateVolumeOnboardLifecycle,
  createManagedWorkloadOnboardRuntime,
  prepareHermesPortableSandboxWorkloadForLifecycle,
  prepareOnboardSandboxWorkloadLaunch,
  shouldActivateStockManagedRuntime,
} from "./onboard-orchestration";

function createFreshOnboardingRuntime(environment: Readonly<Record<string, string>>) {
  const prepared = {
    source: {
      kind: "legacy-dockerfile",
      dockerfilePath: "agents/openclaw/Dockerfile",
      reason: "managed-image-unavailable",
    },
    release: "v0.0.0",
    fallbackDiagnostic: null,
  };
  prepareSandboxWorkloadSource.mockClear();
  prepareSandboxWorkloadSource.mockResolvedValueOnce(prepared);

  const runtime = createManagedWorkloadOnboardRuntime(
    {
      computePlan: { driverName: "docker" },
      managedWorkloadRebuild: null,
      tempManagedRuntime: false,
      tempManagedRuntimeCatalog: null,
      agentName: "openclaw",
      legacyDockerfilePath: "agents/openclaw/Dockerfile",
      customDockerfilePath: null,
      rootDir: "/tmp/nemoclaw",
      model: "model",
      provider: "provider",
      preferredInferenceApi: null,
      endpointUrl: null,
      startupProfile: { environment },
      note: vi.fn(),
      fallbackBuildEstimate: () => null,
    } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
    {
      resolveAgentInferenceApi: vi.fn(),
      getSandboxInferenceConfig: vi.fn(),
    },
  );

  return { prepared, runtime };
}

async function expectUnsupportedHermesPortableSources(
  runtime: Parameters<typeof prepareHermesPortableSandboxWorkloadForLifecycle>[0],
  prepared: {
    source: {
      kind: "legacy-dockerfile";
      dockerfilePath: string;
      reason: "runtime-unsupported";
    };
    release: string;
    fallbackDiagnostic: null;
  },
  expectedDockerfilePath: string,
): Promise<void> {
  await Promise.all(
    [
      { ...prepared.source, reason: "custom-dockerfile" as const },
      { ...prepared.source, dockerfilePath: "/workspace/replacement/Dockerfile" },
    ].map((source) =>
      expect(
        prepareHermesPortableSandboxWorkloadForLifecycle(
          { ...runtime, ensurePreparedWorkload: vi.fn(async () => ({ ...prepared, source })) },
          expectedDockerfilePath,
        ),
      ).rejects.toThrow("requires the shipped Hermes Dockerfile source"),
    ),
  );
}

describe("managed workload onboard orchestration", () => {
  it("activates stock managed images only for shipped agents outside Portable", () => {
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "openclaw",
      }),
    ).toBe(true);
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "hermes",
      }),
    ).toBe(true);
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "langchain-deepagents-code",
      }),
    ).toBe(true);
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: true,
        hermesPortableLifecycle: false,
        agentName: "openclaw",
      }),
    ).toBe(false);
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "nemocua",
      }),
    ).toBe(false);
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: false,
        agentName: "pi",
      }),
    ).toBe(false);
  });

  it("does not activate stock managed images for Hermes Portable (#9634)", () => {
    expect(
      shouldActivateStockManagedRuntime({
        portableLifecycle: false,
        hermesPortableLifecycle: true,
        agentName: "hermes",
      }),
    ).toBe(false);
  });

  it("selects only the shipped Hermes Dockerfile fallback without profile or prebuild work", async () => {
    const expectedDockerfilePath = "/workspace/agents/hermes/Dockerfile";
    const ensurePreparedProfile = vi.fn(() => null);
    const prepared = {
      source: {
        kind: "legacy-dockerfile" as const,
        dockerfilePath: expectedDockerfilePath,
        reason: "runtime-unsupported" as const,
      },
      release: "v0.0.0",
      fallbackDiagnostic: null,
    };
    const runtime = {
      runtimeProvider: null,
      ensurePreparedWorkload: vi.fn(async () => prepared),
      ensurePreparedProfile,
    };

    await expect(
      prepareHermesPortableSandboxWorkloadForLifecycle(runtime, expectedDockerfilePath),
    ).resolves.toBe(prepared);
    expect(ensurePreparedProfile).not.toHaveBeenCalled();

    await expectUnsupportedHermesPortableSources(runtime, prepared, expectedDockerfilePath);
  });

  it("keeps failure cleanup armed until the caller commits registration", () => {
    const docker = createHermesStateVolumeDockerHarness();
    let exitCleanup: (() => void) | null = null;

    const lifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      {
        runDocker: docker.runDocker as never,
        registerExitCleanup: (cleanup) => {
          exitCleanup = cleanup;
          return vi.fn();
        },
      },
    );

    lifecycle.materializeSandboxCreatePlan({} as never, (input) => {
      expect(input.managedStateMount).toMatchObject({ target: "/sandbox/.hermes" });
      return {} as never;
    });
    exitCleanup!();

    expect(docker.volume).toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
  });

  it("retains the live qualification catalog revision during fresh onboarding (#9385)", async () => {
    const catalogRevision = "a".repeat(40);
    const { prepared, runtime } = createFreshOnboardingRuntime({
      GITHUB_ACTIONS: "true",
      E2E_MANAGED_IMAGE_REVISION: catalogRevision,
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ catalogRevision }),
    );
  });

  it("binds fresh onboarding to the exact PR catalog (#9464)", async () => {
    const catalogRevision = "b".repeat(40);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    try {
      const { prepared, runtime } = createFreshOnboardingRuntime({
        GITHUB_ACTIONS: "true",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_E2E_EXPECTED_SHA: catalogRevision,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
      });

      await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
      expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          catalogPath,
          expectedCatalogRevision: catalogRevision,
        }),
      );
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("omits the qualification catalog revision outside GitHub Actions (#9385)", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledOnce();
    expect(prepareSandboxWorkloadSource.mock.calls[0]?.[0]).not.toHaveProperty("catalogRevision");
  });

  it("resolves final-image patch metadata after managed build-context staging", async () => {
    const resolutionMetadata = { key: "published-dcode-base" };
    let staged = false;
    const resolvePatchInput = vi.fn(() => {
      expect(staged).toBe(true);
      return { preResolvedBaseImageMetadata: resolutionMetadata } as never;
    });
    const resolveSandboxBuildPatch = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.preResolvedBaseImageMetadata).toBe(resolutionMetadata);
      expect(input.stagedDockerfile).toBe("/tmp/nemoclaw-staged-context/Dockerfile");
      return { buildId: "dcode-build", dashboardRemoteBindPrepared: false };
    });
    const materializeSandboxCreatePlan = vi.fn(() => ({
      activeMessagingChannels: [],
      compatibilityPolicyPath: null,
      createArgs: [
        "--from",
        "/tmp/nemoclaw-staged-context/Dockerfile",
        "--name",
        "dcode",
        "--policy",
        "/tmp/nemoclaw-policy.yaml",
      ],
      gpuRoutePlan: "none",
      initialSandboxPolicy: {
        appliedPresets: [],
        policyPath: "/tmp/nemoclaw-policy.yaml",
      },
      messagingProviders: [],
      policyTier: null,
      sandboxGpuLogMessage: null,
    }));

    await prepareOnboardSandboxWorkloadLaunch({
      runtime: {
        runtimeProvider: null,
        ensurePreparedWorkload: vi.fn(),
        ensurePreparedProfile: vi.fn(),
      },
      workload: {
        source: {
          kind: "legacy-dockerfile",
          dockerfilePath: "agents/langchain-deepagents-code/Dockerfile",
          reason: "runtime-unsupported",
        },
        release: "v0.0.0",
        fallbackDiagnostic: null,
      },
      legacy: {
        preparedBuildContext: null,
        agent: {
          name: "langchain-deepagents-code",
          displayName: "LangChain Deep Agents Code",
        },
        fromDockerfile: null,
        createAgentSandbox: () => {
          staged = true;
          return {
            buildCtx: "/tmp/nemoclaw-staged-context",
            stagedDockerfile: "/tmp/nemoclaw-staged-context/Dockerfile",
            baseImageResolutionMetadata: resolutionMetadata,
          };
        },
        resolvePatchInput,
      },
      plan: {
        intent: {},
        rebindMessagingTokenDefs: async () => [],
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(() => "unused"),
        discloseInitialSandboxPolicy: vi.fn(),
      },
      launchInput: {
        agent: null,
        chatUiUrl: "http://127.0.0.1:18789",
        sandboxName: "dcode",
        env: { NEMOCLAW_SANDBOX_PREBUILD: "0" },
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => "0",
        hermesDashboardState: {},
        manageDashboard: false,
        openshellShellCommand: () => "openshell sandbox create",
      },
      plannedMessagingPlan: null,
      gpu: {
        provider: "compatible-endpoint",
        config: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        dockerDriverGateway: false,
        gatewayPort: 8080,
      },
      dependencies: {
        materializeSandboxCreatePlan,
        prepareSandboxBuildPatchConfig: vi.fn(() => ({
          messagingChannelConfig: null,
        })),
        resolveSandboxBuildPatch,
      },
    } as unknown as Parameters<typeof prepareOnboardSandboxWorkloadLaunch>[0]);

    expect(resolvePatchInput).toHaveBeenCalledOnce();
    expect(resolveSandboxBuildPatch).toHaveBeenCalledOnce();
  });
});
