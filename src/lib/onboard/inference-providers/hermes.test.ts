// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { setupHermesProviderInference } from "./hermes";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    upsertProvider: vi.fn(),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => false),
    registry: { updateSandbox: vi.fn() },
    hermesProviderAuth: {
      isHermesProviderRegistered: vi.fn(() => true),
      ensureHermesProviderApiKeyCredentials: vi.fn(() => ({})),
      ensureHermesProviderOAuthCredentials: vi.fn(() => ({})),
    },
    getHermesToolGatewayBroker: vi.fn(() => ({
      getHermesToolGatewayProviderName: vi.fn(() => "hermes-tool-gateway"),
    })),
    providerExistsInGateway: vi.fn(() => true),
    normalizeHermesAuthMethod: vi.fn(() => "api-key"),
    resolveHermesNousApiKey: vi.fn(() => null),
    checkHermesProviderStoreReachable: vi.fn(() => ({ ok: true })),
    hermesAuthMethodLabel: vi.fn((m: string) => m),
    hermesConstants: {
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
      HERMES_AUTH_METHOD_API_KEY: "api-key",
      HERMES_AUTH_METHOD_OAUTH: "oauth",
    },
    requireValue: vi.fn((v: unknown, _msg: string) => v),
    redact: vi.fn((s: string) => s),
    compactText: vi.fn((s: string) => s),
    ...overrides,
  };
}

function makeArgs(endpointUrl: string | null) {
  return {
    sandboxName: "alpha",
    model: "m",
    provider: "p",
    endpointUrl,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [] as string[],
  };
}

function publicLookup() {
  return vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
}

describe("setupHermesProviderInference SSRF guard (#6072)", () => {
  it("rejects loopback address", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://127.0.0.1:8080/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects cloud metadata endpoint", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://169.254.169.254/latest/meta-data/",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects private RFC-1918 range", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://10.0.0.1/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects localhost hostname", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://localhost:11434/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("rejects .internal TLD", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "http://my-service.internal/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/private or internal/);
  });

  it("throws on malformed URL without leaking the raw value", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "not-a-url",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/valid URL/);
  });

  it("rejects unsupported scheme", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "ftp://example.com/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/unsupported scheme/);
  });

  it("rejects URL with embedded credentials", async () => {
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "https://user:secret@example.com/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        makeDeps() as never,
      ),
    ).rejects.toThrow(/credentials/);
  });

  it("does not call runOpenshell when endpoint is rejected", async () => {
    const deps = makeDeps();
    await expect(
      setupHermesProviderInference(
        {
          sandboxName: "alpha",
          model: "m",
          provider: "p",
          endpointUrl: "ftp://example.com/v1",
          credentialEnv: null,
          hermesAuthMethod: null,
          hermesToolGateways: [],
        },
        deps as never,
      ),
    ).rejects.toThrow();
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a DNS-backed public HTTPS endpoint until runtime-aware pinning exists (#4684)", async () => {
    const deps = makeDeps({ lookup: publicLookup() });
    await expect(
      setupHermesProviderInference(makeArgs("https://integrate.api.nvidia.com/v1"), deps as never),
    ).rejects.toThrow(/DNS-backed HTTPS URLs are not supported/);
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("accepts a public HTTPS IP-literal endpoint (#6072)", async () => {
    const deps = makeDeps();
    await expect(
      setupHermesProviderInference(makeArgs("https://8.8.8.8/v1"), deps as never),
    ).resolves.toEqual({ ok: true });
    expect(deps.runOpenshell).toHaveBeenCalled();
  });

  it("rejects a public HTTPS hostname that resolves to a public IP until runtime-aware pinning exists (#4684)", async () => {
    const deps = makeDeps({
      lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
    });
    await expect(
      setupHermesProviderInference(makeArgs("https://api.public.example.test/v1"), deps as never),
    ).rejects.toThrow(/DNS-backed HTTPS URLs are not supported/);
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects a public hostname that resolves to a private IP (DNS rebinding) (#6073)", async () => {
    const deps = makeDeps({
      lookup: vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]),
    });
    await expect(
      setupHermesProviderInference(
        makeArgs("https://public-looking.example.test/v1"),
        deps as never,
      ),
    ).rejects.toThrow(/private or internal/);
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("skips SSRF check when endpointUrl is null (#6072)", async () => {
    const deps = makeDeps();
    await expect(setupHermesProviderInference(makeArgs(null), deps as never)).resolves.toEqual({
      ok: true,
    });
    expect(deps.runOpenshell).toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/v1",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/v1",
    "http://192.168.1.1/v1",
    "http://172.16.0.1/v1",
    "http://[::1]/v1",
    "http://[fc00::1]/v1",
    "http://localhost/v1",
    "http://foo.internal/v1",
    "http://foo.local/v1",
  ])("rejects private/reserved endpoint %s (#6073)", async (endpointUrl) => {
    const deps = makeDeps();
    await expect(
      setupHermesProviderInference(makeArgs(endpointUrl), deps as never),
    ).rejects.toThrow(/private or internal/);
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });
});
