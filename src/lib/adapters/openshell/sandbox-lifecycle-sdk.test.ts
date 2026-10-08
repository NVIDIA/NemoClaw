// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { fingerprintOpenShellSandboxId } from "./sandbox-identity";
import { createSdkOpenShellSandboxStateLifecycle } from "./sandbox-lifecycle-sdk";

const target = { kind: "named" as const, gatewayName: "nemoclaw" };
const sandboxId = "sandbox-alpha";
const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
const request = { sandboxName: "alpha", sandboxIdentityFingerprint, target };

function harness() {
  const response = { sandbox: { metadata: { id: sandboxId } } };
  const startSandbox = vi.fn(async () => response);
  const stopSandbox = vi.fn(async () => response);
  const get = vi.fn(async () => ({ id: sandboxId, phase: "stopped" }));
  const waitReady = vi.fn(async () => ({ id: sandboxId, phase: "ready" }));
  const connect = vi.fn(async () => ({
    raw: { startSandbox, stopSandbox },
    sandbox: { get, waitReady },
  }));
  const lifecycle = createSdkOpenShellSandboxStateLifecycle({ connect });
  return { connect, get, lifecycle, startSandbox, stopSandbox, waitReady };
}

describe("OpenShell SDK sandbox lifecycle", () => {
  it("starts and stops the named sandbox through typed SDK RPCs", async () => {
    const { connect, get, lifecycle, startSandbox, stopSandbox, waitReady } = harness();

    await expect(lifecycle.startSandbox(request)).resolves.toEqual({
      kind: "accepted",
    });
    await expect(lifecycle.stopSandbox(request)).resolves.toEqual({
      kind: "accepted",
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(3);
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

    await expect(lifecycle.startSandbox({ ...request, sandboxName: "../alpha" })).resolves.toEqual({
      kind: "failed",
      error: { kind: "schema", message: "Invalid sandbox request." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("classifies an SDK authorization denial without exposing its detail", async () => {
    const denied = Object.assign(new Error("token=secret"), { code: "auth" });
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        sandbox: {
          get: async () => ({ id: sandboxId, phase: "stopped" }),
          waitReady: async () => ({ id: sandboxId, phase: "ready" }),
        },
        raw: {
          startSandbox: async () => Promise.reject(denied),
          stopSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
        },
      }),
    });

    await expect(lifecycle.startSandbox(request)).resolves.toEqual({
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

    await expect(lifecycle.stopSandbox(request)).resolves.toEqual({
      kind: "failed",
      error: {
        kind: "transport",
        reason: "unreachable",
        message: "OpenShell is unavailable (Error, code ERR_MODULE_NOT_FOUND).",
      },
    });
  });

  it.each(["startSandbox", "stopSandbox"] as const)(
    "reports an Error-state refusal from %s without calling the gateway unavailable",
    async (operation) => {
      const test = harness();
      test.get.mockResolvedValue({ id: sandboxId, phase: "Error" });
      test[operation].mockRejectedValue(
        Object.assign(new Error("secret server detail"), { code: 9 }),
      );

      const result = await test.lifecycle[operation](request);

      expect(result).toEqual({
        kind: "failed",
        error: {
          kind: "command",
          reason: "failed",
          message: `OpenShell rejected the ${operation === "startSandbox" ? "start" : "stop"} request because the sandbox is in Error state.`,
        },
      });
      expect(test.waitReady).not.toHaveBeenCalled();
    },
  );

  it("bounds a connection that never settles", async () => {
    let connectionSignal: AbortSignal | undefined;
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: (_target, { signal }) => {
        connectionSignal = signal;
        return new Promise(() => undefined);
      },
    });

    await expect(lifecycle.startSandbox({ ...request, timeoutMs: 5 })).resolves.toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
    expect(connectionSignal?.aborted).toBe(true);
  });

  it("bounds a connected lifecycle RPC that never settles", async () => {
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: () => new Promise(() => undefined),
          stopSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
        },
        sandbox: {
          get: async () => ({ id: sandboxId, phase: "stopped" }),
          waitReady: async () => ({ id: sandboxId, phase: "ready" }),
        },
      }),
    });

    await expect(lifecycle.startSandbox({ ...request, timeoutMs: 5 })).resolves.toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
  });

  it("bounds readiness after the start mutation is accepted", async () => {
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
          stopSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
        },
        sandbox: {
          get: async () => ({ id: sandboxId, phase: "stopped" }),
          waitReady: () => new Promise(() => undefined),
        },
      }),
    });

    await expect(lifecycle.startSandbox({ ...request, timeoutMs: 5 })).resolves.toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
  });

  it("rejects a reused sandbox name before lifecycle mutation", async () => {
    const { lifecycle, startSandbox, stopSandbox } = harness();

    await expect(
      lifecycle.stopSandbox({
        ...request,
        sandboxIdentityFingerprint: fingerprintOpenShellSandboxId("replacement-id")!,
      }),
    ).resolves.toEqual({
      kind: "failed",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "OpenShell sandbox identity changed.",
      },
    });
    expect(startSandbox).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
  });

  it("rejects a lifecycle response for a same-name replacement", async () => {
    const get = vi.fn(async () => ({ id: sandboxId, phase: "stopped" }));
    const stopSandbox = vi.fn(async () => ({
      sandbox: { metadata: { id: "replacement-id" } },
    }));
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
          stopSandbox,
        },
        sandbox: {
          get,
          waitReady: async () => ({ id: sandboxId, phase: "ready" }),
        },
      }),
    });

    await expect(lifecycle.stopSandbox(request)).resolves.toEqual({
      kind: "failed",
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "OpenShell lifecycle response changed sandbox identity.",
      },
    });
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
  });

  it("waits for the same sandbox to report Stopped after the stop RPC", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: sandboxId, phase: "ready" })
      .mockResolvedValueOnce({ id: sandboxId, phase: "stopping" })
      .mockResolvedValueOnce({ id: sandboxId, phase: "Stopped" });
    const waitForStopPoll = vi.fn(async () => undefined);
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
          stopSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
        },
        sandbox: {
          get,
          waitReady: async () => ({ id: sandboxId, phase: "ready" }),
        },
      }),
      waitForStopPoll,
    });

    await expect(lifecycle.stopSandbox(request)).resolves.toEqual({ kind: "accepted" });
    expect(get).toHaveBeenCalledTimes(3);
    expect(waitForStopPoll).toHaveBeenCalledOnce();
  });

  it("fails at the shared deadline when the exact sandbox never reaches Stopped", async () => {
    const lifecycle = createSdkOpenShellSandboxStateLifecycle({
      connect: async () => ({
        raw: {
          startSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
          stopSandbox: async () => ({ sandbox: { metadata: { id: sandboxId } } }),
        },
        sandbox: {
          get: async () => ({ id: sandboxId, phase: "stopping" }),
          waitReady: async () => ({ id: sandboxId, phase: "ready" }),
        },
      }),
      waitForStopPoll: async () => await new Promise(() => undefined),
    });

    await expect(lifecycle.stopSandbox({ ...request, timeoutMs: 5 })).resolves.toEqual({
      kind: "failed",
      error: { kind: "timeout", message: "OpenShell timed out." },
    });
  });
});
