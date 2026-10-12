// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for routed (Model Router) provider endpoint normalization and
// upsert. See: https://github.com/NVIDIA/NemoClaw/issues/4564

import { describe, expect, it, vi } from "vitest";

// Mock the heavy transitive imports so this test does not load runner.ts /
// the compiled ./platform artifact.
vi.mock("../inference/local", () => ({
  HOST_GATEWAY_URL: "http://host.openshell.internal",
}));
vi.mock("./model-router", () => ({
  DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV: "NVIDIA_INFERENCE_API_KEY",
  loadBlueprintProfile: vi.fn(() => ({ endpoint: "http://localhost:4000/v1" })),
}));

import {
  normalizeRoutedEndpointUrl,
  resolveRoutedCredentialEnv,
  upsertRoutedProvider,
} from "./routed-inference";
import { setupRoutedInference } from "./inference-providers/routed";
import type { RoutedDeps } from "./inference-providers/types";

describe("normalizeRoutedEndpointUrl (#4564)", () => {
  it("rewrites localhost to the sandbox-facing host alias", async () => {
    expect(normalizeRoutedEndpointUrl("http://localhost:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("rewrites 127.0.0.1 to the host alias", async () => {
    expect(normalizeRoutedEndpointUrl("http://127.0.0.1:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("omits the colon when the endpoint has no explicit port and preserves query/hash", async () => {
    expect(normalizeRoutedEndpointUrl("http://localhost/v1?x=1#frag")).toBe(
      "http://host.openshell.internal/v1?x=1#frag",
    );
  });

  it("leaves an already-aliased endpoint untouched", async () => {
    expect(normalizeRoutedEndpointUrl("http://host.openshell.internal:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("falls back to the blueprint endpoint when none is recorded, then normalizes it", async () => {
    // The mocked loadBlueprintProfile returns http://localhost:4000/v1.
    expect(normalizeRoutedEndpointUrl(null)).toBe("http://host.openshell.internal:4000/v1");
    expect(normalizeRoutedEndpointUrl("")).toBe("http://host.openshell.internal:4000/v1");
  });
});

describe("resolveRoutedCredentialEnv (#4564)", () => {
  it("prefers an explicitly recorded credential env", async () => {
    const loadProfile = vi.fn(() => ({ credential_env: "CUSTOM_KEY" })) as never;
    expect(resolveRoutedCredentialEnv("SESSION_KEY", loadProfile)).toBe("SESSION_KEY");
  });

  it("falls back to the routed profile credential env before the NVIDIA default", async () => {
    const loadProfile = vi.fn(() => ({
      credential_env: "CUSTOM_KEY",
      router: { credential_env: "ROUTER_KEY" },
    })) as never;
    // router.credential_env wins (mirrors reconcileModelRouter resolution).
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("ROUTER_KEY");
  });

  it("falls back to the profile-level credential env when the router has none", async () => {
    const loadProfile = vi.fn(() => ({ credential_env: "CUSTOM_KEY" })) as never;
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("CUSTOM_KEY");
  });

  it("uses the NVIDIA default when no profile credential env is set", async () => {
    const loadProfile = vi.fn(() => ({ endpoint: "http://localhost:4000/v1" })) as never;
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("NVIDIA_INFERENCE_API_KEY");
  });
});

describe("upsertRoutedProvider (#4564)", () => {
  it("upserts the provider with the normalized host alias base URL", async () => {
    const upsertProvider = vi.fn(async () => ({ ok: true }));
    const hydrateCredentialEnv = vi.fn(() => "nvapi-secret");

    const result = await upsertRoutedProvider(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      {
        upsertProvider,
        hydrateCredentialEnv,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.endpointUrl).toBe("http://host.openshell.internal:4000/v1");
    expect(result.resolvedCredentialEnv).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(upsertProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "http://host.openshell.internal:4000/v1",
      { NVIDIA_INFERENCE_API_KEY: "nvapi-secret" },
    );
  });

  it("defaults the credential env and omits an empty credential from the env block", async () => {
    const upsertProvider = vi.fn(async () => ({ ok: true }));
    const hydrateCredentialEnv = vi.fn(() => undefined);

    const result = await upsertRoutedProvider("nvidia-router", "http://localhost:4000/v1", null, {
      upsertProvider,
      hydrateCredentialEnv,
    });

    expect(result.resolvedCredentialEnv).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(upsertProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "http://host.openshell.internal:4000/v1",
      {},
    );
  });

  it("propagates a failed upsert result", async () => {
    const upsertProvider = vi.fn(async () => ({ ok: false, message: "boom", status: 3 }));
    const hydrateCredentialEnv = vi.fn(() => "nvapi-secret");

    const result = await upsertRoutedProvider(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      {
        upsertProvider,
        hydrateCredentialEnv,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.result.message).toBe("boom");
    expect(result.result.status).toBe(3);
  });

  it("waits for provider registration before resolving", async () => {
    let release: ((value: { ok: true }) => void) | undefined;
    const upsertProvider = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const resultPromise = upsertRoutedProvider(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      { upsertProvider, hydrateCredentialEnv: () => "nvapi-secret" },
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release?.({ ok: true });
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });
});

function makeRoutedSetupDeps(
  setInferenceRoute: RoutedDeps["inferenceRouteMutator"]["setInferenceRoute"] = vi.fn(async () => ({
    ok: true as const,
  })),
) {
  return {
    runOpenshell: vi.fn(),
    inferenceRouteMutator: { setInferenceRoute },
    gatewayName: "nemoclaw-8091",
    upsertProvider: vi.fn(async () => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => true),
    registry: { updateSandbox: vi.fn() },
    exitProcess: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    error: vi.fn(),
    log: vi.fn(),
    reconcileModelRouter: vi.fn(async () => undefined),
    routedInference: {
      upsertRoutedProvider: vi.fn(async () => ({ ok: true, result: { ok: true } })),
    },
    hydrateCredentialEnv: vi.fn(() => "nvapi-secret"),
    redact: vi.fn((value: string) => value),
    compactText: vi.fn((value: string) => value),
  };
}

describe("setupRoutedInference route mutation", () => {
  const args = {
    model: "nemotron-test",
    provider: "nvidia-router",
    endpointUrl: "http://localhost:4000/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  };

  it("sends the exact route to the named gateway", async () => {
    const deps = makeRoutedSetupDeps();

    await expect(setupRoutedInference(args, deps as unknown as RoutedDeps)).resolves.toEqual({
      done: false,
    });

    expect(deps.inferenceRouteMutator.setInferenceRoute).toHaveBeenCalledOnce();
    expect(deps.inferenceRouteMutator.setInferenceRoute).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      route: { provider: "nvidia-router", model: "nemotron-test" },
      verification: "skip",
    });
  });

  it("exits before the caller can publish success after an ambiguous mutation", async () => {
    const setInferenceRoute = vi.fn(async () => ({
      ok: false as const,
      ambiguous: true,
      error: {
        kind: "timeout" as const,
        message: "OpenShell inference route update ended without a confirmed result.",
      },
    }));
    const deps = makeRoutedSetupDeps(setInferenceRoute);
    const publishSuccess = vi.fn();
    const setup = async () => {
      const result = await setupRoutedInference(args, deps as unknown as RoutedDeps);
      publishSuccess();
      return result;
    };

    await expect(setup()).rejects.toThrow("exit 1");

    expect(setInferenceRoute).toHaveBeenCalledOnce();
    expect(publishSuccess).not.toHaveBeenCalled();
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
    expect(deps.error).toHaveBeenCalledWith(
      "  The route update result is unknown. Inspect gateway 'nemoclaw-8091' before retrying onboarding.",
    );
  });
});
