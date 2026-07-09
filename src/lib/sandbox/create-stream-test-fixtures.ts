// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { vi } from "vitest";

import type {
  StreamSandboxCreateOptions,
  StreamableChildProcess,
  StreamableReadable,
} from "./create-stream";

export class FakeReadable extends EventEmitter implements StreamableReadable {
  destroy(): void {}
}

export class FakeChild extends EventEmitter implements StreamableChildProcess {
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  kill = vi.fn();
  unref = vi.fn();
}

export const dockerEnv = { ...process.env, OPENSHELL_DRIVERS: "docker" };
export const vmEnv = { ...process.env, OPENSHELL_DRIVERS: "vm" };

export function makeSpawnImpl(child: StreamableChildProcess = new FakeChild()) {
  return () => child;
}

export function makeDefaultStreamOptions(
  child: StreamableChildProcess = new FakeChild(),
  overrides: StreamSandboxCreateOptions = {},
): StreamSandboxCreateOptions {
  return {
    spawnImpl: makeSpawnImpl(child),
    heartbeatIntervalMs: 1_000,
    silentPhaseMs: 10_000,
    logLine: vi.fn(),
    ...overrides,
  };
}

export function makePollingOptions(
  child: StreamableChildProcess = new FakeChild(),
  overrides: StreamSandboxCreateOptions = {},
): StreamSandboxCreateOptions {
  return makeDefaultStreamOptions(child, {
    pollIntervalMs: 5,
    ...overrides,
  });
}
