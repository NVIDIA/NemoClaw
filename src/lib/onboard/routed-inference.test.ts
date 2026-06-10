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
  DEFAULT_MODEL_ROUTER_CREDENTIAL_ENV: "NVIDIA_API_KEY",
  loadBlueprintProfile: vi.fn(() => ({ endpoint: "http://localhost:4000/v1" })),
}));

import {
  normalizeRoutedEndpointUrl,
  resolveRoutedCredentialEnv,
  upsertRoutedProvider,
} from "./routed-inference";

describe("normalizeRoutedEndpointUrl (#4564)", () => {
  it("rewrites localhost to the sandbox-facing host alias", () => {
    expect(normalizeRoutedEndpointUrl("http://localhost:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("rewrites 127.0.0.1 to the host alias", () => {
    expect(normalizeRoutedEndpointUrl("http://127.0.0.1:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("omits the colon when the endpoint has no explicit port and preserves query/hash", () => {
    expect(normalizeRoutedEndpointUrl("http://localhost/v1?x=1#frag")).toBe(
      "http://host.openshell.internal/v1?x=1#frag",
    );
  });

  it("leaves an already-aliased endpoint untouched", () => {
    expect(normalizeRoutedEndpointUrl("http://host.openshell.internal:4000/v1")).toBe(
      "http://host.openshell.internal:4000/v1",
    );
  });

  it("falls back to the blueprint endpoint when none is recorded, then normalizes it", () => {
    // The mocked loadBlueprintProfile returns http://localhost:4000/v1.
    expect(normalizeRoutedEndpointUrl(null)).toBe("http://host.openshell.internal:4000/v1");
    expect(normalizeRoutedEndpointUrl("")).toBe("http://host.openshell.internal:4000/v1");
  });
});

describe("resolveRoutedCredentialEnv (#4564)", () => {
  it("prefers an explicitly recorded credential env", () => {
    const loadProfile = vi.fn(() => ({ credential_env: "CUSTOM_KEY" })) as never;
    expect(resolveRoutedCredentialEnv("SESSION_KEY", loadProfile)).toBe("SESSION_KEY");
  });

  it("falls back to the routed profile credential env before the NVIDIA default", () => {
    const loadProfile = vi.fn(() => ({
      credential_env: "CUSTOM_KEY",
      router: { credential_env: "ROUTER_KEY" },
    })) as never;
    // router.credential_env wins (mirrors reconcileModelRouter resolution).
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("ROUTER_KEY");
  });

  it("falls back to the profile-level credential env when the router has none", () => {
    const loadProfile = vi.fn(() => ({ credential_env: "CUSTOM_KEY" })) as never;
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("CUSTOM_KEY");
  });

  it("uses the NVIDIA default when no profile credential env is set", () => {
    const loadProfile = vi.fn(() => ({ endpoint: "http://localhost:4000/v1" })) as never;
    expect(resolveRoutedCredentialEnv(null, loadProfile)).toBe("NVIDIA_API_KEY");
  });
});

describe("upsertRoutedProvider (#4564)", () => {
  it("upserts the provider with the normalized host alias base URL", () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const hydrateCredentialEnv = vi.fn(() => "nvapi-secret");

    const result = upsertRoutedProvider(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_API_KEY",
      {
        upsertProvider,
        hydrateCredentialEnv,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.endpointUrl).toBe("http://host.openshell.internal:4000/v1");
    expect(result.resolvedCredentialEnv).toBe("NVIDIA_API_KEY");
    expect(upsertProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "openai",
      "NVIDIA_API_KEY",
      "http://host.openshell.internal:4000/v1",
      { NVIDIA_API_KEY: "nvapi-secret" },
    );
  });

  it("defaults the credential env and omits an empty credential from the env block", () => {
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const hydrateCredentialEnv = vi.fn(() => undefined);

    const result = upsertRoutedProvider("nvidia-router", "http://localhost:4000/v1", null, {
      upsertProvider,
      hydrateCredentialEnv,
    });

    expect(result.resolvedCredentialEnv).toBe("NVIDIA_API_KEY");
    expect(upsertProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "openai",
      "NVIDIA_API_KEY",
      "http://host.openshell.internal:4000/v1",
      {},
    );
  });

  it("propagates a failed upsert result", () => {
    const upsertProvider = vi.fn(() => ({ ok: false, message: "boom", status: 3 }));
    const hydrateCredentialEnv = vi.fn(() => "nvapi-secret");

    const result = upsertRoutedProvider(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_API_KEY",
      {
        upsertProvider,
        hydrateCredentialEnv,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.result.message).toBe("boom");
    expect(result.result.status).toBe(3);
  });
});
