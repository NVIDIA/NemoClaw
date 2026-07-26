// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import net from "node:net";

import { beforeEach, expect, vi } from "vitest";

import { test as it } from "./helpers/owned-test-resources";

const ownerMocks = vi.hoisted(() => ({
  ownChildProcess: vi.fn(),
}));

vi.mock("./helpers/child-process-lifecycle.ts", () => ({
  ownChildProcess: ownerMocks.ownChildProcess,
}));

import { forceKill, freePort, startProxy, terminate } from "./ollama-auth-proxy-handler-helpers.ts";

const TOKEN = "unit-test-secret-token";

beforeEach(() => {
  ownerMocks.ownChildProcess.mockReset();
});

it("preserves the readiness failure and allows cleanup to be retried", async ({
  onTestFinished,
  resources,
}) => {
  const failedTermination = vi.fn().mockRejectedValue(new Error("cleanup failed"));
  const retryTermination = vi.fn().mockResolvedValue(undefined);
  ownerMocks.ownChildProcess
    .mockImplementationOnce((child: ChildProcess) => ({
      child,
      closed: Promise.resolve(),
      terminate: failedTermination,
    }))
    .mockImplementationOnce((child: ChildProcess) => ({
      child,
      closed: Promise.resolve(),
      terminate: retryTermination,
    }));

  const readinessRejector = resources.ownServer(net.createServer((socket) => socket.destroy()));
  await new Promise<void>((resolve, reject) => {
    readinessRejector.once("error", reject);
    readinessRejector.listen(0, "127.0.0.1", resolve);
  });
  const readinessPort = (readinessRejector.address() as AddressInfo).port;
  const proxyPort = await freePort();
  let spawned: ChildProcess | undefined;
  onTestFinished(() => forceKill(spawned));

  await expect(
    startProxy(proxyPort, 1, TOKEN, {
      onSpawn: (child) => {
        spawned = child;
      },
      readinessPort,
      readinessTimeoutMs: 100,
    }),
  ).rejects.toThrow("proxy did not start in time");

  await expect(terminate(spawned)).resolves.toBeUndefined();
  expect(failedTermination).toHaveBeenCalledOnce();
  expect(retryTermination).toHaveBeenCalledOnce();
});

it("removes a failed termination owner so cleanup can be retried", async ({ onTestFinished }) => {
  const failedTermination = vi.fn().mockRejectedValue(new Error("cleanup failed"));
  const retryTermination = vi.fn().mockResolvedValue(undefined);
  ownerMocks.ownChildProcess
    .mockImplementationOnce((child: ChildProcess) => ({
      child,
      closed: Promise.resolve(),
      terminate: failedTermination,
    }))
    .mockImplementationOnce((child: ChildProcess) => ({
      child,
      closed: Promise.resolve(),
      terminate: retryTermination,
    }));
  let spawned: ChildProcess | undefined;
  onTestFinished(() => forceKill(spawned));
  const proxy = await startProxy(await freePort(), 1, TOKEN, {
    onSpawn: (child) => {
      spawned = child;
    },
  });

  await expect(terminate(proxy)).rejects.toThrow("cleanup failed");
  await expect(terminate(proxy)).resolves.toBeUndefined();
  expect(failedTermination).toHaveBeenCalledOnce();
  expect(retryTermination).toHaveBeenCalledOnce();
});
