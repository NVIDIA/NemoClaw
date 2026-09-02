// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import {
  managedStartupStateRoots,
  managedStartupWorkspaceRoot,
} from "../managed-startup/state-roots";

describe("managed workspace-root declarations", () => {
  it("preserves the DCode sticky root-owned login-profile boundary generically", () => {
    expect(
      managedStartupWorkspaceRoot({
        agent: "langchain-deepagents-code",
        agentIdentity: { uid: 999, gid: 999 },
      }),
    ).toEqual({ uid: 0, gid: 999, mode: 0o1775 });
    expect(
      managedStartupWorkspaceRoot({
        agent: "openclaw",
        agentIdentity: { uid: 998, gid: 998 },
      }),
    ).toEqual({ uid: 998, gid: 998, mode: 0o755 });
  });
});

const preparationState = vi.hoisted(() => ({
  prepared: undefined as unknown,
  useUnavailableCatalog: false,
}));
const prepareSandboxWorkloadSource = vi.hoisted(() => vi.fn());
const INSTALLED_REVISION = vi.hoisted(() => "d".repeat(40));
const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-root-"));
fs.writeFileSync(path.join(releaseRoot, ".version"), "0.0.0\n");

vi.mock("../workload/preparation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workload/preparation")>();
  const { ManagedImageCatalogUnavailableError } = await import("../managed-image/catalog");
  prepareSandboxWorkloadSource.mockImplementation((input) =>
    preparationState.useUnavailableCatalog
      ? original.prepareSandboxWorkloadSource(input, {
          resolveCatalog: async () => {
            throw new ManagedImageCatalogUnavailableError("registry offline");
          },
        })
      : Promise.resolve(preparationState.prepared),
  );
  return { ...original, prepareSandboxWorkloadSource };
});

vi.mock("../../core/version", () => ({
  getBuildIdentity: () => ({ nemoclawVersion: "0.0.0", sourceRevision: INSTALLED_REVISION }),
  getVersion: () => "v0.0.0",
}));

import { mapManagedStartupProfileToAgentEnvironment } from "../managed-startup/agent-environment";
import {
  createManagedStateVolumeOnboardLifecycle,
  createManagedWorkloadOnboardRuntime,
  prepareHermesPortableSandboxWorkloadForLifecycle,
  prepareOnboardSandboxWorkloadLaunch,
  shouldActivateStockManagedRuntime,
} from "./onboard-orchestration";

function createFreshOnboardingRuntime(
  environment: Readonly<Record<string, string>>,
  options: {
    readonly stockManagedRuntime?: boolean;
    readonly tempManagedRuntime?: boolean;
    readonly tempManagedRuntimeCatalog?: string | null;
    readonly unavailableCatalog?: boolean;
  } = {},
) {
  const prepared = {
    source: {
      kind: "legacy-dockerfile",
      dockerfilePath: "agents/openclaw/Dockerfile",
      reason: "contract-unavailable",
    },
    release: "v0.0.0",
    fallbackDiagnostic: null,
  };
  preparationState.prepared = prepared;
  preparationState.useUnavailableCatalog = options.unavailableCatalog ?? false;
  prepareSandboxWorkloadSource.mockClear();

  const runtime = createManagedWorkloadOnboardRuntime(
    {
      computePlan: { driverName: "docker" },
      managedWorkloadRebuild: null,
      tempManagedRuntime: options.tempManagedRuntime ?? false,
      stockManagedRuntime: options.stockManagedRuntime ?? false,
      tempManagedRuntimeCatalog: options.tempManagedRuntimeCatalog ?? null,
      agentName: "openclaw",
      legacyDockerfilePath: "agents/openclaw/Dockerfile",
      customDockerfilePath: null,
      rootDir: releaseRoot,
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
  afterAll(() => {
    fs.rmSync(releaseRoot, { force: true, recursive: true });
  });

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

  it("keeps the Hermes browser URL separate from its loopback managed forward", () => {
    const runtime = createManagedWorkloadOnboardRuntime(
      {
        computePlan: { driverName: "docker" },
        managedWorkloadRebuild: null,
        tempManagedRuntime: false,
        stockManagedRuntime: true,
        tempManagedRuntimeCatalog: null,
        agentName: "hermes",
        legacyDockerfilePath: "agents/hermes/Dockerfile",
        customDockerfilePath: null,
        rootDir: releaseRoot,
        model: "moonshotai/kimi-k2.6",
        provider: "nvidia",
        preferredInferenceApi: null,
        endpointUrl: null,
        startupProfile: {
          chatUiUrl: "https://hermes.example.test:19189",
          effectiveDashboardPort: 19_189,
          manageDashboard: true,
          dashboardBindAddress: undefined,
          wslExposure: false,
          hermesDashboardState: {
            config: {
              enabled: true,
              port: 19_189,
              internalPort: 29_189,
              tuiEnabled: false,
            },
            enabled: true,
          },
          webSearch: null,
          toolDisclosure: "progressive",
          hermesToolGateways: [],
          messagingPlan: null,
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
          environment: {},
        },
        note: vi.fn(),
        fallbackBuildEstimate: () => null,
      } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
      {
        resolveAgentInferenceApi: vi.fn(() => "openai-completions"),
        getSandboxInferenceConfig: vi.fn(() => ({
          providerKey: "inference",
          inferenceBaseUrl: "https://inference.local/v1",
          inferenceApi: "openai-completions",
          primaryModelRef: "inference/moonshotai/kimi-k2.6",
          inferenceCompat: {},
        })),
      },
    );

    const built = runtime.ensurePreparedProfile({
      source: { kind: "managed-image" },
    } as never);

    expect(built?.profile.dashboard).toEqual({
      agent: "hermes",
      mode: "loopback-forwarded",
      url: "http://127.0.0.1:19189",
      browserUrl: "https://hermes.example.test:19189",
      publicPort: 19_189,
      internalPort: 29_189,
      tuiEnabled: false,
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(built!.profile).runtimeEnvironment.CHAT_UI_URL,
    ).toBe("https://hermes.example.test:19189");
  });

  it("uses the Dockerfile when the stock managed-image catalog is unavailable", async () => {
    const { runtime } = createFreshOnboardingRuntime(
      {},
      { stockManagedRuntime: true, unavailableCatalog: true },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toMatchObject({
      source: { kind: "legacy-dockerfile" },
    });
  });

  it("rejects an unavailable catalog for explicit temporary managed-image onboarding", async () => {
    const { runtime } = createFreshOnboardingRuntime(
      {},
      { stockManagedRuntime: true, tempManagedRuntime: true, unavailableCatalog: true },
    );

    await expect(runtime.ensurePreparedWorkload()).rejects.toThrow("registry offline");
  });

  it("treats an explicit temporary catalog as strict managed-image selection", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {},
      { tempManagedRuntimeCatalog: "/tmp/pi-candidate-catalog.json" },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        catalogPath: "/tmp/pi-candidate-catalog.json",
        runtime: expect.objectContaining({
          driverName: "docker",
          managedImages: expect.objectContaining({
            exactDigestReferences: true,
          }),
        }),
      }),
    );
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

    const lifecycle = createManagedStateVolumeOnboardLifecycle(
      {
        roots: managedStartupStateRoots({
          agent: "hermes",
          sandboxName: "alpha",
          agentIdentity: { uid: 1000, gid: 1000 },
        }),
        runtimeProvider: {
          identity: { id: "docker" },
          workload: { managedStateMountDriverId: "docker" },
          containerEngine: {
            supported: true,
            identities: [
              { operation: "sandbox-lifecycle", engineId: "docker", displayName: "Docker" },
            ],
          },
        } as never,
      },
      {
        runContainerEngine: docker.runDocker as never,
        registerExitCleanup: (cleanup) => {
          exitCleanup = cleanup;
          return vi.fn();
        },
      },
    );

    lifecycle.materializeSandboxCreatePlan({} as never, (input) => {
      expect(input.managedStateMounts).toEqual([
        expect.objectContaining({ target: "/sandbox/.hermes" }),
      ]);
      expect(input.managedStateMountDriverId).toBe("docker");
      return {} as never;
    });
    exitCleanup!();

    expect(docker.volume).toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
  });

  it("retains the live qualification catalog revision during fresh onboarding (#9385)", async () => {
    const catalogRevision = "a".repeat(40);
    const { prepared, runtime } = createFreshOnboardingRuntime(
      {
        GITHUB_ACTIONS: "true",
        E2E_MANAGED_IMAGE_REVISION: catalogRevision,
      },
      { stockManagedRuntime: true },
    );

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ catalogRevision }),
    );
  });

  it("does not apply the stock cohort revision outside stock onboarding", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      GITHUB_ACTIONS: "true",
      E2E_MANAGED_IMAGE_REVISION: "a".repeat(40),
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledOnce();
    expect(prepareSandboxWorkloadSource.mock.calls[0]?.[0]).not.toHaveProperty("catalogRevision");
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

  it("retains reused managed-image publication identity for live PR onboarding", async () => {
    const candidateRevision = "b".repeat(40);
    const publicationRevision = "a".repeat(40);
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    try {
      const { prepared, runtime } = createFreshOnboardingRuntime({
        GITHUB_ACTIONS: "true",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_E2E_EXPECTED_SHA: candidateRevision,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
        NEMOCLAW_E2E_MANAGED_IMAGE_REVISION: publicationRevision,
      });

      await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
      expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          catalogPath,
          expectedCatalogRevision: publicationRevision,
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

  it("retains an exact installed revision outside GitHub Actions", async () => {
    const { prepared, runtime } = createFreshOnboardingRuntime({
      NEMOCLAW_INSTALL_REF: INSTALLED_REVISION,
    });

    await expect(runtime.ensurePreparedWorkload()).resolves.toBe(prepared);
    expect(prepareSandboxWorkloadSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ catalogRevision: INSTALLED_REVISION }),
    );
  });

  it("resolves final-image patch metadata after managed build-context staging", async () => {
    const resolutionMetadata = { key: "published-dcode-base" };
    const trustedDockerfile = path.join(
      process.cwd(),
      "agents",
      "langchain-deepagents-code",
      "Dockerfile",
    );
    let staged = false;
    const resolvePatchInput = vi.fn(() => {
      expect(staged).toBe(true);
      return {
        fromDockerfile: trustedDockerfile,
        preResolvedBaseImageMetadata: resolutionMetadata,
      } as never;
    });
    const resolveSandboxBuildPatch = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.fromDockerfile).toBeNull();
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
          dockerfilePath: trustedDockerfile,
        },
        fromDockerfile: trustedDockerfile,
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
