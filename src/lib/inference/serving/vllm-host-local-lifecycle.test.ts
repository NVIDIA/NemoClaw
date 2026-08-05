// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";

import {
  HOST_LOCAL_VLLM_AUTH_LABEL,
  HOST_LOCAL_VLLM_MANAGED_LABEL,
  recoverHostLocalManagedVllmEndpoint,
} from "./vllm-host-local-lifecycle";

const API_KEY = "b".repeat(64);

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
