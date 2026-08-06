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
  recoverHostLocalManagedVllmEndpoint,
} from "./vllm-host-local-lifecycle";

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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function inspect(
  key = API_KEY,
  fingerprint = runtimeAuthFingerprint(key),
  labels: Record<string, string> = {},
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
      NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8000" }] } },
    },
  ]);
}

describe("host-local managed vLLM recovery", () => {
  it("recovers one owned loopback endpoint with the matching key", () => {
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

  it("fails closed when the persisted key differs from the running service", () => {
    expect(() =>
      recoverHostLocalManagedVllmEndpoint({
        dockerInspect: () => inspect(),
        loadApiKey: () => "c".repeat(64),
      }),
    ).toThrow("missing or mismatched");
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
