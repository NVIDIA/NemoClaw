// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { nativeProviderRebuildScenario } from "./rebuild-flow-test-fixtures";
import { blockRebuildOnLegacySharedLocalRoute } from "./rebuild-preflight-phase";

import { restoreEnvBulk } from "../../../../test/helpers/env-test-helpers";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import { rebuildOnboardDependencies } from "../../../../test/helpers/rebuild-flow-harness";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { makeMessagingPlan } from "../../../../test/helpers/messaging-plan-fixtures";
import type {
  ProviderRecoveryReceipt,
  RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import {
  pinRebuildTargetGatewayForReadiness,
  runRebuildGatewayRecoveryAfterReadiness,
  stageRebuildBaseImageResolutionHandoff,
  stageRegistryProviderRecoveryReceipt,
} from "./rebuild-preflight-target-phase";

const originalOpenShellEnv = {
  OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY,
  OPENSHELL_GATEWAY_ENDPOINT: process.env.OPENSHELL_GATEWAY_ENDPOINT,
  OPENSHELL_LOCAL_TLS_DIR: process.env.OPENSHELL_LOCAL_TLS_DIR,
  OPENSHELL_TOKEN: process.env.OPENSHELL_TOKEN,
  OPENSHELL_WORKSPACE: process.env.OPENSHELL_WORKSPACE,
};

describe("rebuild inference route timeout", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });
  afterEach(() => vi.unstubAllEnvs());

  function createCompatibleRebuild(messaging: boolean, routeReady = true) {
    const plan = makeMessagingPlan({
      sandboxName: "alpha",
      channels: messaging ? ["telegram"] : [],
    });
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "test/model",
        endpointUrl: "http://localhost:11434/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      buildMessagingRebuildPlan: () => plan,
    });
    vi.spyOn(rebuildOnboardDependencies, "isInferenceRouteReady").mockReturnValue(routeReady);
    return harness;
  }

  it.each([
    { timeout: "0", messaging: true, routeReady: true },
    { timeout: "3601", messaging: true, routeReady: true },
    { timeout: "3601", messaging: false, routeReady: false },
  ])(
    "rejects $timeout before deletion (messaging=$messaging, ready=$routeReady) (#13931)",
    async ({ timeout, messaging, routeReady }) => {
      vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", timeout);
      const harness = createCompatibleRebuild(messaging, routeReady);

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT must be from 1 to 3600 seconds");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["messaging refresh at 3600", "3600", () => createCompatibleRebuild(true)],
    ["route reuse at 7200", "7200", () => createCompatibleRebuild(false)],
    [
      "unused provider timeout",
      "7200",
      () => createRebuildFlowHarness({ sandboxEntry: { provider: "build" } }),
    ],
    [
      "native hosted timeout",
      "7200",
      () =>
        createRebuildFlowHarness(nativeProviderRebuildScenario(false, "openrouter-api").overrides),
    ],
  ] as const)("allows %s (#13931)", async (_scenario, timeout, createHarness) => {
    vi.stubEnv("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", timeout);
    const harness = createHarness();
    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  restoreEnvBulk(originalOpenShellEnv);
});

describe("rebuild readiness gateway pin", () => {
  it("pins the recorded target without selecting or recovering a gateway (#7411)", () => {
    const log = vi.fn();
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";
    const runtimeSelection = { gatewayName: "nemoclaw-9443", workspace: "default" };

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        log,
        runtimeSelection,
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("default");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBeUndefined();
    expect(process.env.OPENSHELL_TOKEN).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "Pinned rebuild readiness probes for 'alpha' to target gateway 'nemoclaw-9443'",
    );
  });

  it("keeps non-MCP ambient selectors while pinning the recorded gateway (#10514)", () => {
    process.env.OPENSHELL_GATEWAY = "hostile-gateway";
    process.env.OPENSHELL_GATEWAY_ENDPOINT = "https://hostile.invalid";
    process.env.OPENSHELL_LOCAL_TLS_DIR = "/hostile/tls";
    process.env.OPENSHELL_TOKEN = "hostile-token";
    process.env.OPENSHELL_WORKSPACE = "hostile-workspace";

    expect(
      pinRebuildTargetGatewayForReadiness(
        "alpha",
        { gatewayName: "nemoclaw-9443", gatewayPort: 9443 } as never,
        vi.fn(),
      ),
    ).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY).toBe("nemoclaw-9443");
    expect(process.env.OPENSHELL_GATEWAY_ENDPOINT).toBe("https://hostile.invalid");
    expect(process.env.OPENSHELL_LOCAL_TLS_DIR).toBe("/hostile/tls");
    expect(process.env.OPENSHELL_TOKEN).toBe("hostile-token");
    expect(process.env.OPENSHELL_WORKSPACE).toBe("hostile-workspace");
  });

  it("does not select or recover the gateway when readiness rejects (#7411)", async () => {
    const afterReadiness = vi.fn();
    const recoverGateway = vi.fn(async () => true);

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => false,
        afterReadiness,
        recoverGateway,
      }),
    ).resolves.toBe(false);
    expect(afterReadiness).not.toHaveBeenCalled();
    expect(recoverGateway).not.toHaveBeenCalled();
  });

  it("recovers the gateway only after readiness and post-admission staging (#7411)", async () => {
    const calls: string[] = [];

    await expect(
      runRebuildGatewayRecoveryAfterReadiness({
        assertReadiness: async () => {
          calls.push("readiness");
          return true;
        },
        afterReadiness: () => calls.push("stage-receipt"),
        recoverGateway: async () => {
          calls.push("recover-gateway");
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["readiness", "stage-receipt", "recover-gateway"]);
  });
});

const target = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "nvidia/model",
};

const registryRoute: RegistryInferenceRoute = {
  provider: target.provider,
  model: target.model,
  endpointUrl: "https://inference.example.test/v1",
  endpointSource: null,
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

describe("stageRegistryProviderRecoveryReceipt", () => {
  it("leaves recovery authority absent without a registry-derived route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, null, {
      nonce: "nonce-without-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions).not.toHaveProperty("providerRecoveryReceipt");
  });

  it("binds recovery authority to the captured registry route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, registryRoute, {
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions.providerRecoveryReceipt).toEqual({
      ...target,
      route: registryRoute,
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
      sessionId: null,
    });
  });
});

describe("stageRebuildBaseImageResolutionHandoff", () => {
  it("binds outer resolver provenance to its immutable local handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to a temporary immutable rebuild handoff (#7144)", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const current = { key: "current", imageId } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"b".repeat(16)}-image-${"a".repeat(64)}`,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("binds provenance to the exact immutable remote rebuild handoff (#7144)", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const imageRef = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${digest}`;
    const current = {
      key: "current",
      imageName: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
      imageId: `sha256:${"b".repeat(64)}`,
      ref: imageRef,
      digest,
      source: "pinned",
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    stageRebuildBaseImageResolutionHandoff(recreateOptions, {
      ok: true,
      imageRef,
      overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
      resolutionMetadata: current,
    });

    expect(recreateOptions.preResolvedBaseImageMetadata).toBe(current);
  });

  it("rejects provenance that is not bound to the immutable local handoff", () => {
    const current = {
      key: "current",
      imageId: `sha256:${"a".repeat(64)}`,
    } as SandboxBaseImageResolutionMetadata;
    const recreateOptions: { preResolvedBaseImageMetadata?: SandboxBaseImageResolutionMetadata } =
      {};

    expect(() =>
      stageRebuildBaseImageResolutionHandoff(recreateOptions, {
        ok: true,
        imageRef: `nemoclaw-hermes-sandbox-base-local:image-${"b".repeat(64)}`,
        overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
        resolutionMetadata: current,
      }),
    ).toThrow("provenance did not match its immutable handoff");
  });
});

describe("rebuild legacy local route preflight", () => {
  it.each([
    { agent: "hermes", provider: "ollama-local", createdAt: "2026-09-01T00:00:00Z" },
    {
      agent: "hermes",
      provider: "compatible-endpoint",
      endpointUrl: "http://localhost:8000/v1",
      createdAt: "2026-09-01T00:00:00Z",
    },
    { agent: "pi", provider: "ollama-local", createdAt: undefined },
    {
      agent: "pi",
      provider: "ollama-local",
      createdAt: "2026-09-01T00:00:00Z",
      pendingRouteReservation: true,
    },
    {
      agent: "langchain-deepagents-code",
      provider: "ollama-local",
      createdAt: "2026-09-01T00:00:00Z",
    },
    {
      agent: "langchain-deepagents-code",
      provider: "vllm-local",
      createdAt: "2026-09-01T00:00:00Z",
    },
    { agent: "langchain-deepagents-code", provider: "ollama-local", createdAt: undefined },
    { agent: "langchain-deepagents-code", provider: "vllm-local", createdAt: undefined },
    { agent: "openclaw", provider: "ollama-local", createdAt: undefined },
    { agent: "openclaw", provider: "vllm-local", createdAt: undefined },
    { agent: "openclaw", provider: "llama-cpp-local", createdAt: undefined },
    {
      agent: "langchain-deepagents-code",
      provider: "ollama-local",
      createdAt: "2026-09-01T00:00:00Z",
      pendingRouteReservation: true,
    },
  ])(
    "blocks legacy $agent $provider rebuild with createdAt=$createdAt",
    ({ agent, provider, createdAt, ...state }) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const bail = vi.fn((message: string): never => {
        throw new Error(message);
      });
      const entry = {
        name: "alpha",
        createdAt,
        agent,
        provider,
        model: "local-model",
        ...state,
      } as RebuildSandboxEntry;

      expect(() => blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toThrow(
        "Legacy shared local inference cannot be rebuilt safely",
      );
      expect(error.mock.calls.flat().join("\n")).toContain("Back up the sandbox");
      expect(bail).toHaveBeenCalledOnce();
    },
  );

  it("leaves Local NIM on its existing shared rebuild path", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const entry = {
      name: "alpha",
      agent: "openclaw",
      provider: "vllm-local",
      model: "nim-model",
      nimContainer: "nim-alpha",
    } as RebuildSandboxEntry;
    expect(blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });

  it("leaves attached selections on their existing preflight path", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const entry = {
      name: "alpha",
      createdAt: "2026-09-01T00:00:00Z",
      agent: "langchain-deepagents-code",
      provider: "ollama-local",
      model: "local-model",
      nativeLocalProviderAttachment: {},
    } as RebuildSandboxEntry;
    expect(blockRebuildOnLegacySharedLocalRoute("alpha", entry, bail)).toBe(false);
    expect(
      blockRebuildOnLegacySharedLocalRoute(
        "alpha",
        { ...entry, pendingRouteReservation: true },
        bail,
      ),
    ).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });
});

describe("Pi shared local rebuild compatibility", () => {
  it("keeps a published Pi shared route eligible for rebuild (#12975)", () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    expect(
      blockRebuildOnLegacySharedLocalRoute(
        "alpha",
        {
          name: "alpha",
          createdAt: "2026-09-01T00:00:00Z",
          agent: "pi",
          provider: "ollama-local",
          model: "local-model",
        },
        bail,
      ),
    ).toBe(false);
    expect(bail).not.toHaveBeenCalled();
  });
});
