// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DUAL_STATION_VLLM_RUNTIME } from "./vllm-station-cluster";

interface ManagedBaseUrlOverrides {
  loadApiKey?: () => string | null;
  onManagedHeadObserved?: () => void;
}

const lifecycle = vi.hoisted(() => ({
  baseUrl: vi.fn<(overrides?: ManagedBaseUrlOverrides) => string | null>(),
}));

vi.mock("./vllm-station-cluster-lifecycle", () => ({
  getDualStationManagedVllmBaseUrl: lifecycle.baseUrl,
}));

import {
  CONTAINER_REACHABILITY_IMAGE,
  getLocalProviderBaseUrl,
  getLocalProviderContainerReachabilityCheck,
  getLocalProviderHealthCheck,
  getLocalProviderHealthEndpoint,
  getManagedDualStationVllmProviderBinding,
  getManagedDualStationVllmProviderState,
  LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV,
  probeLocalProviderHealth,
  probeVllmModels,
  validateLocalProvider,
} from "./local";

const BASE_URL = "http://10.40.0.1:8000";
const API_KEY = "e".repeat(64);
const OTHER_API_KEY = "f".repeat(64);
const MANAGED_BASE_URL_BY_API_KEY = new Map<string | null | undefined, string | null>([
  [undefined, BASE_URL],
  [API_KEY, BASE_URL],
  [null, null],
]);

let actualLifecycle: typeof import("./vllm-station-cluster-lifecycle");

beforeAll(async () => {
  actualLifecycle = await vi.importActual("./vllm-station-cluster-lifecycle");
});

function productionManagedBaseUrlResolver(
  expectedApiKey = API_KEY,
  apiKeyFingerprint = actualLifecycle.dualStationVllmApiKeyFingerprint(expectedApiKey),
) {
  const row = [
    "a".repeat(64),
    actualLifecycle.DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
    "running",
    DUAL_STATION_VLLM_RUNTIME.image,
    "true",
    "head",
    BASE_URL,
    "b".repeat(64),
    "GPU-12345678",
    "2",
    "c".repeat(64),
    apiKeyFingerprint,
    "d".repeat(32),
  ].join("\t");

  return (overrides: ManagedBaseUrlOverrides = {}): string | null =>
    actualLifecycle.getDualStationManagedVllmBaseUrl({
      dockerCapture: () => row,
      buildLocalDockerEnv: () => ({}),
      loadApiKey: overrides.loadApiKey ?? (() => null),
      onManagedHeadObserved: overrides.onManagedHeadObserved ?? (() => undefined),
      localInterfaceAddresses: () => ["10.40.0.1"],
    });
}

beforeEach(() => {
  vi.stubEnv(LOCAL_INFERENCE_SANDBOX_HOST_URL_ENV, undefined);
  lifecycle.baseUrl.mockReset();
  lifecycle.baseUrl.mockImplementation(
    (overrides) => MANAGED_BASE_URL_BY_API_KEY.get(overrides?.loadApiKey?.()) ?? null,
  );
});

afterEach(() => vi.unstubAllEnvs());

describe("managed dual-Station vLLM authentication", () => {
  it("keeps an explicit sandbox host override ahead of managed endpoint recovery", () => {
    const loadApiKeyImpl = vi.fn(() => API_KEY);
    expect(getLocalProviderBaseUrl("vllm-local", { hostUrl: "http://explicit-host" })).toBe(
      "http://explicit-host:8000/v1",
    );
    expect(
      getManagedDualStationVllmProviderBinding({
        hostUrl: "http://explicit-host",
        loadApiKeyImpl,
      }),
    ).toBeNull();
    expect(loadApiKeyImpl).not.toHaveBeenCalled();
  });

  it("does not load a stale or unsafe key without a recovered managed endpoint", () => {
    const loadApiKeyImpl = vi.fn(() => {
      throw new Error(`unsafe ${API_KEY}`);
    });
    lifecycle.baseUrl.mockReturnValue(null);

    expect(getManagedDualStationVllmProviderBinding({ loadApiKeyImpl })).toBeNull();
    expect(loadApiKeyImpl).not.toHaveBeenCalled();
  });

  it("keeps legacy health unauthenticated even when stale key loading would fail", () => {
    const loadVllmApiKeyImpl = vi.fn(() => {
      throw new Error(`unsafe ${API_KEY}`);
    });
    const runCurlProbeImpl = vi.fn(() => ({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: '{"data":[{"id":"served/model"}]}',
      stderr: "",
      message: "HTTP 200",
    }));
    lifecycle.baseUrl.mockReturnValue(null);

    const result = probeLocalProviderHealth("vllm-local", {
      model: "served/model",
      loadVllmApiKeyImpl,
      runCurlProbeImpl,
    });

    expect(result?.ok).toBe(true);
    expect(loadVllmApiKeyImpl).not.toHaveBeenCalled();
    expect(runCurlProbeImpl).toHaveBeenCalledWith([
      "-sS",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      "http://127.0.0.1:8000/v1/models",
    ]);
  });

  it("returns one atomic provider endpoint and credential binding", () => {
    expect(getManagedDualStationVllmProviderBinding({ loadApiKeyImpl: () => API_KEY })).toEqual({
      baseUrl: `${BASE_URL}/v1`,
      apiKey: API_KEY,
    });
    expect(getManagedDualStationVllmProviderState({ loadApiKeyImpl: () => API_KEY })).toEqual({
      kind: "ready",
      baseUrl: `${BASE_URL}/v1`,
      apiKey: API_KEY,
    });
  });

  it("uses /health only for unauthenticated availability checks", () => {
    expect(getLocalProviderHealthEndpoint("vllm-local")).toBe(`${BASE_URL}/v1/models`);
    expect(getLocalProviderHealthCheck("vllm-local")).toEqual([
      "curl",
      "-sf",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      "--noproxy",
      "*",
      "--write-out",
      "%{http_code}",
      `${BASE_URL}/health`,
    ]);
    expect(getLocalProviderContainerReachabilityCheck("vllm-local")).toEqual([
      "docker",
      "--context",
      "default",
      "run",
      "--rm",
      "--add-host",
      "host.openshell.internal:host-gateway",
      CONTAINER_REACHABILITY_IMAGE,
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "--noproxy",
      "*",
      "-sf",
      "-w",
      "%{http_code}",
      `${BASE_URL}/health`,
    ]);
  });

  it("pins reachability and diagnostics to the local daemon despite a persisted remote context", () => {
    const capture = vi.fn((argv: readonly string[]) => (argv[0] === "curl" ? "200" : ""));

    const result = validateLocalProvider("vllm-local", capture, () => undefined);
    const dockerCommands = capture.mock.calls
      .map(([argv]) => argv)
      .filter((argv) => argv[0] === "docker");

    expect(result.ok).toBe(false);
    expect(dockerCommands).toHaveLength(5);
    expect(
      dockerCommands.every((argv) => argv.slice(0, 3).join(" ") === "docker --context default"),
    ).toBe(true);
  });

  it("passes bearer auth through a private curl config and cleans it up", () => {
    let configPath = "";
    const result = probeVllmModels(`${BASE_URL}/v1`, API_KEY, {
      runCurlProbeImpl: (argv, options) => {
        expect(argv).not.toContain(API_KEY);
        expect(argv.at(-1)).toBe(`${BASE_URL}/v1/models`);
        const configIndex = argv.indexOf("--config");
        configPath = argv[configIndex + 1] ?? "";
        expect(options?.trustedConfigFiles).toEqual([configPath]);
        expect(options?.pinnedAddresses).toEqual([]);
        expect(fs.readFileSync(configPath, "utf8")).toContain(`Authorization: Bearer ${API_KEY}`);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: '{"data":[{"id":"served/model"}]}',
          stderr: "",
          message: "HTTP 200",
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(configPath).not.toBe("");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("keeps authenticated model inventory authoritative for configured-model health", () => {
    const runCurlProbeImpl = vi.fn((argv: string[]) => ({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: '{"data":[{"id":"different/model"}]}',
      stderr: "",
      message: "HTTP 200",
    }));
    const result = probeLocalProviderHealth("vllm-local", {
      model: "required/model",
      loadVllmApiKeyImpl: () => API_KEY,
      runCurlProbeImpl,
    });

    expect(runCurlProbeImpl).toHaveBeenCalledOnce();
    const probeArgv = runCurlProbeImpl.mock.calls[0]?.[0] ?? [];
    expect(probeArgv).not.toContain(API_KEY);
    expect(result?.ok).toBe(false);
    expect(result?.failureLabel).toBe("unhealthy");
    expect(result?.detail).toContain("required/model");
    expect(result?.detail).toContain("different/model");
  });

  it("fails closed through production lifecycle recovery when the managed key is absent", () => {
    const runCurlProbeImpl = vi.fn();
    const result = probeLocalProviderHealth("vllm-local", {
      getManagedVllmBaseUrlImpl: productionManagedBaseUrlResolver(),
      model: "required/model",
      loadVllmApiKeyImpl: () => null,
      runCurlProbeImpl,
    });

    expect(runCurlProbeImpl).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
    expect(result?.failureLabel).toBe("unauthorized");
    expect(result?.detail).not.toContain(API_KEY);
  });

  it("fails closed through production lifecycle recovery when managed key state is unsafe", () => {
    const runCurlProbeImpl = vi.fn();
    const result = probeLocalProviderHealth("vllm-local", {
      getManagedVllmBaseUrlImpl: productionManagedBaseUrlResolver(),
      model: "required/model",
      loadVllmApiKeyImpl: () => {
        throw new Error(`unsafe ${API_KEY}`);
      },
      runCurlProbeImpl,
    });

    expect(runCurlProbeImpl).not.toHaveBeenCalled();
    expect(result?.ok).toBe(false);
    expect(result?.failureLabel).toBe("unhealthy");
    expect(result?.detail).not.toContain(API_KEY);
  });

  it("returns invalid-auth when the private key does not match the managed lifecycle", () => {
    expect(
      getManagedDualStationVllmProviderState({
        getManagedBaseUrlImpl: productionManagedBaseUrlResolver(OTHER_API_KEY),
        loadApiKeyImpl: () => API_KEY,
      }),
    ).toEqual({ kind: "invalid-auth", reason: "mismatched" });
  });

  it("fails closed when an owned managed head has invalid auth fingerprint metadata", () => {
    const runCurlProbeImpl = vi.fn();
    const result = probeLocalProviderHealth("vllm-local", {
      getManagedVllmBaseUrlImpl: productionManagedBaseUrlResolver(API_KEY, ""),
      loadVllmApiKeyImpl: () => API_KEY,
      runCurlProbeImpl,
    });

    expect(runCurlProbeImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      endpoint: "managed dual-Station vLLM",
      failureLabel: "unhealthy",
    });
  });
});
