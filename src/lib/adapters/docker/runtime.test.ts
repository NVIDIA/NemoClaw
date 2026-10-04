// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../runner", () => ({
  ROOT: "/repo/root",
  run: vi.fn(),
  runCapture: vi.fn(),
}));

import {
  DOCKER_INFO_RUNTIME_PROBE_ATTEMPTS,
  DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS,
  DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS,
  detectContainerRuntimeFromDockerInfo,
} from "./runtime";

describe("docker runtime detection", () => {
  it("retries indeterminate docker info output before returning a runtime", () => {
    const calls: unknown[] = [];
    const outputs = ["", "", "Operating System: Docker Desktop"];

    const sleep = vi.fn();
    const runtime = detectContainerRuntimeFromDockerInfo({
      dockerInfoImpl: (opts) => {
        calls.push(opts);
        return outputs.shift() ?? "";
      },
      sleep,
    });

    expect(runtime).toBe("docker-desktop");
    expect(calls).toHaveLength(DOCKER_INFO_RUNTIME_PROBE_ATTEMPTS);
    expect(calls).toEqual(
      Array.from({ length: DOCKER_INFO_RUNTIME_PROBE_ATTEMPTS }, () => ({
        ignoreError: true,
        timeout: DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS,
      })),
    );

    expect(sleep.mock.calls).toEqual([
      [DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS],
      [DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS],
    ]);
  });

  it("returns unknown after all attempts are indeterminate", () => {
    const calls: unknown[] = [];

    const sleep = vi.fn();
    const runtime = detectContainerRuntimeFromDockerInfo({
      attempts: 2,
      dockerInfoImpl: (opts) => {
        calls.push(opts);
        return "";
      },
      timeoutMs: 1234,
      sleep,
    });

    expect(runtime).toBe("unknown");
    expect(calls).toEqual([
      { ignoreError: true, timeout: 1234 },
      { ignoreError: true, timeout: 1234 },
    ]);

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(DOCKER_INFO_RUNTIME_PROBE_RETRY_DELAY_MS);
  });
});
