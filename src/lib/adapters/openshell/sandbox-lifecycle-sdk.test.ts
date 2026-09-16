// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSdkOpenShellSandboxStateLifecycle } from "./sandbox-lifecycle-sdk";

const target = { kind: "named" as const, gatewayName: "nemoclaw" };

function harness() {
  const startSandbox = vi.fn(async () => ({}));
  const stopSandbox = vi.fn(async () => ({}));
  const connect = vi.fn(async () => ({ raw: { startSandbox, stopSandbox } }));
  const lifecycle = createSdkOpenShellSandboxStateLifecycle({ connect });
  return { connect, lifecycle, startSandbox, stopSandbox };
}

describe("OpenShell SDK sandbox lifecycle", () => {
  it("starts and stops the named sandbox through typed SDK RPCs", async () => {
    const { connect, lifecycle, startSandbox, stopSandbox } = harness();

    await expect(lifecycle.startSandbox({ sandboxName: "alpha", target })).resolves.toEqual({
      kind: "accepted",
    });
    await expect(lifecycle.stopSandbox({ sandboxName: "alpha", target })).resolves.toEqual({
      kind: "accepted",
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(startSandbox).toHaveBeenCalledWith(
      { name: "alpha", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
    expect(stopSandbox).toHaveBeenCalledWith(
      { name: "alpha", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("rejects an invalid name before it connects", async () => {
    const { connect, lifecycle } = harness();

    await expect(lifecycle.startSandbox({ sandboxName: "../alpha", target })).resolves.toEqual({
      kind: "failed",
      error: { kind: "schema", message: "Invalid sandbox request." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("classifies an SDK authorization denial without exposing its detail", async () => {
    const denied = Object.assign(new Error("token=secret"), { code: "auth" });
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: async () => Promise.reject(denied),
          stopSandbox: async () => ({}),
        },
      }),
    });

    await expect(lifecycle.startSandbox({ sandboxName: "alpha", target })).resolves.toEqual({
      kind: "failed",
      error: { kind: "authentication", message: "OpenShell denied access." },
    });
  });

  it("falls back only when the reviewed SDK package is unavailable", async () => {
    const fallback = {
      startSandbox: vi.fn(async () => ({ kind: "accepted" as const })),
      stopSandbox: vi.fn(async () => ({ kind: "accepted" as const })),
    };
    const missing = Object.assign(new Error("missing reviewed SDK"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => Promise.reject(missing),
      fallback,
    });

    await expect(lifecycle.stopSandbox({ sandboxName: "alpha", target })).resolves.toEqual({
      kind: "accepted",
    });
    expect(fallback.stopSandbox).toHaveBeenCalledWith({ sandboxName: "alpha", target });
    expect(fallback.startSandbox).not.toHaveBeenCalled();
  });
});
