// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { vi } from "vitest";

import type { StreamableChildProcess, StreamableReadable } from "./create-stream";

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
