// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";

import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_CATALOG_LABEL,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL,
  HOST_LOCAL_VLLM_PRESET_LABEL,
  HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL,
  HOST_LOCAL_VLLM_RECIPE_LABEL,
  persistHostLocalVllmRuntimeReceipt,
  type RecoverHostLocalManagedVllmOptions,
  recoverHostLocalManagedVllmEndpoint,
} from "./vllm-host-local-lifecycle";

const networkMocks = vi.hoisted(() => ({
  resolveBridgeHost: vi.fn(
    (
      _capture: NonNullable<RecoverHostLocalManagedVllmOptions["dockerCapture"]>,
      _dockerEnv?: Record<string, string>,
    ) => "172.18.0.1",
  ),
}));

vi.mock("./vllm-host-local-network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vllm-host-local-network")>()),
  resolveManagedVllmBridgeHost: networkMocks.resolveBridgeHost,
}));

const API_KEY = "b".repeat(64);
const IDENTITY = {
  catalogDigest: `sha256:${"1".repeat(64)}`,
  presetId: "vllm.dgx-spark-gb10.single.example",
  presetDigest: `sha256:${"2".repeat(64)}`,
  recipeId: "vllm.dgx-spark-gb10.single.example",
  recipeDigest: `sha256:${"3".repeat(64)}`,
} as const;
const PROFILE_LABELS = {
  [HOST_LOCAL_VLLM_CATALOG_LABEL]: IDENTITY.catalogDigest,
  [HOST_LOCAL_VLLM_PRESET_LABEL]: IDENTITY.presetId,
  [HOST_LOCAL_VLLM_PRESET_DIGEST_LABEL]: IDENTITY.presetDigest,
  [HOST_LOCAL_VLLM_RECIPE_LABEL]: IDENTITY.recipeId,
  [HOST_LOCAL_VLLM_RECIPE_DIGEST_LABEL]: IDENTITY.recipeDigest,
};
const temporaryDirectories: string[] = [];

function stateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  networkMocks.resolveBridgeHost.mockClear();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function inspect(
  key = API_KEY,
  fingerprint = runtimeAuthFingerprint(key),
  labels: Record<string, string> = {},
  bridgeHost = "172.18.0.1",
  hostPort = "8000",
) {
  return JSON.stringify([
    {
      Id: "a".repeat(64),
      Name: "/nemoclaw-vllm",
      State: { Running: true },
      Config: {
        Env: [`VLLM_API_KEY=${key}`],
        Labels: {
          [HOST_LOCAL_VLLM_MANAGED_LABEL]: "true",
          [HOST_LOCAL_VLLM_AUTH_LABEL]: fingerprint,
          ...labels,
        },
      },
      NetworkSettings: {
        Ports: {
          "8000/tcp": [
            { HostIp: "127.0.0.1", HostPort: hostPort },
            { HostIp: bridgeHost, HostPort: hostPort },
          ],
        },
      },
    },
  ]);
}

describe("host-local managed vLLM recovery", () => {
  it("pins inspection and bridge discovery to the physical default Docker daemon", () => {
    vi.stubEnv("DOCKER_CONTEXT", "remote-context");
    vi.stubEnv("DOCKER_HOST", "tcp://remote.example:2376");
    vi.stubEnv("DOCKER_CONFIG", "/tmp/remote-docker-config");
    const capture = vi.fn(
      (..._args: Parameters<NonNullable<RecoverHostLocalManagedVllmOptions["dockerCapture"]>>) =>
        inspect(),
    );

    expect(
      recoverHostLocalManagedVllmEndpoint({
        dockerCapture: capture,
        loadApiKey: () => API_KEY,
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8000", apiKey: API_KEY });

    expect(capture).toHaveBeenCalledOnce();
    const dockerOptions = capture.mock.calls[0]?.[1];
    expect(dockerOptions?.env).toMatchObject({ DOCKER_CONTEXT: "default" });
    expect(dockerOptions?.env).not.toHaveProperty("DOCKER_HOST");
    expect(dockerOptions?.env).not.toHaveProperty("DOCKER_CONFIG");
    expect(networkMocks.resolveBridgeHost).toHaveBeenCalledWith(capture, dockerOptions?.env);
    expect(networkMocks.resolveBridgeHost.mock.calls[0]?.[1]).toBe(dockerOptions?.env);
  });

  it("recovers one owned endpoint with loopback and current OpenShell bridge bindings", () => {
    const observed = vi.fn();
    expect(
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(),
        loadApiKey: () => API_KEY,
        onManagedContainerObserved: observed,
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8000", apiKey: API_KEY });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("recovers the exact configured host port from the bounded Docker bindings", () => {
    expect(
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(API_KEY, runtimeAuthFingerprint(API_KEY), {}, "172.18.0.1", "19000"),
        loadApiKey: () => API_KEY,
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:19000", apiKey: API_KEY });
  });

  it.each(["80", "1e4", "019000", "65536"])(
    "rejects a non-canonical or unsafe recovered host port %s",
    (hostPort) => {
      expect(() =>
        recoverHostLocalManagedVllmEndpoint({
          dockerInspect: () =>
            inspect(API_KEY, runtimeAuthFingerprint(API_KEY), {}, "172.18.0.1", hostPort),
          loadApiKey: () => API_KEY,
        }),
      ).toThrow("unsafe or incomplete");
    },
  );

  it("fails closed when the persisted key differs from the running service", () => {
    expect(() =>
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(),
        loadApiKey: () => "c".repeat(64),
      }),
    ).toThrow("missing or mismatched");
  });

  it("rejects a private binding that is not the current OpenShell bridge (#8379)", () => {
    expect(() =>
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(API_KEY, runtimeAuthFingerprint(API_KEY), {}, "172.19.0.1"),
        loadApiKey: () => API_KEY,
      }),
    ).toThrow("unsafe or incomplete");
  });

  it("recovers a profile-labeled runtime only with an exact ownership receipt", () => {
    const directory = stateDir();
    persistHostLocalVllmRuntimeReceipt(
      {
        containerId: "a".repeat(64),
        authFingerprint: runtimeAuthFingerprint(API_KEY),
        serving: IDENTITY,
      },
      directory,
    );

    expect(
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(API_KEY, runtimeAuthFingerprint(API_KEY), PROFILE_LABELS),
        loadApiKey: () => API_KEY,
        stateDir: directory,
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:8000", apiKey: API_KEY });
  });

  it("rejects a profile-labeled runtime when its ownership receipt is missing", () => {
    expect(() =>
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(API_KEY, runtimeAuthFingerprint(API_KEY), PROFILE_LABELS),
        loadApiKey: () => API_KEY,
        stateDir: stateDir(),
      }),
    ).toThrow("does not match its ownership receipt");
  });

  it("rejects a profile-labeled runtime when its receipt identifies another container", () => {
    const directory = stateDir();
    persistHostLocalVllmRuntimeReceipt(
      {
        containerId: "f".repeat(64),
        authFingerprint: runtimeAuthFingerprint(API_KEY),
        serving: IDENTITY,
      },
      directory,
    );

    expect(() =>
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(API_KEY, runtimeAuthFingerprint(API_KEY), PROFILE_LABELS),
        loadApiKey: () => API_KEY,
        stateDir: directory,
      }),
    ).toThrow("does not match its ownership receipt");
  });

  it("does not adopt a dual-Station container when every host-local marker also matches", () => {
    const observed = vi.fn();
    expect(
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () =>
          inspect(API_KEY, runtimeAuthFingerprint(API_KEY), {
            "com.nvidia.nemoclaw.vllm-role": "head",
          }),
        loadApiKey: () => API_KEY,
        onManagedContainerObserved: observed,
      }),
    ).toBeNull();
    expect(observed).not.toHaveBeenCalled();
  });
});
