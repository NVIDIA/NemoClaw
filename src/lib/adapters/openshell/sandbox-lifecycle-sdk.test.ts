// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSdkOpenShellSandboxStateLifecycle } from "./sandbox-lifecycle-sdk";

const target = { kind: "named" as const, gatewayName: "nemoclaw" };

function harness() {
  const startSandbox = vi.fn(async () => ({}));
  const stopSandbox = vi.fn(async () => ({}));
  const waitReady = vi.fn(async () => ({}));
  const connect = vi.fn(async () => ({
    raw: { startSandbox, stopSandbox },
    sandbox: { waitReady },
  }));
  const lifecycle = createSdkOpenShellSandboxStateLifecycle({ connect });
  return { connect, lifecycle, startSandbox, stopSandbox, waitReady };
}

describe("OpenShell SDK sandbox lifecycle", () => {
  it("starts and stops the named sandbox through typed SDK RPCs", async () => {
    const { connect, lifecycle, startSandbox, stopSandbox, waitReady } = harness();

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
    expect(waitReady).toHaveBeenCalledOnce();
    expect(waitReady).toHaveBeenCalledWith("alpha", 75, {
      signal: expect.any(AbortSignal),
    });
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
        sandbox: { waitReady: async () => ({}) },
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

  it("fails closed when the reviewed SDK package is unavailable", async () => {
    const missing = Object.assign(new Error("missing reviewed SDK"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => Promise.reject(missing),
    });

    await expect(lifecycle.stopSandbox({ sandboxName: "alpha", target })).resolves.toEqual({
      kind: "failed",
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell is unavailable (Error, code ERR_MODULE_NOT_FOUND).",
      },
    });
  });

  it("bounds a connection that never settles", async () => {
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: () => new Promise(() => undefined),
    });

    await expect(
      lifecycle.startSandbox({ sandboxName: "alpha", target, timeoutMs: 5 }),
    ).resolves.toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
  });
});
