// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test helpers used across multiple test files.
 */

import { vi } from "vitest";
import type { PluginLogger } from "./index.js";

/** Create a logger that captures all info() calls into an array. */
export function captureLogger(): { lines: string[]; logger: PluginLogger } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (msg: string) => lines.push(msg),
      warn: (msg: string) => lines.push(`WARN: ${msg}`),
      error: (msg: string) => lines.push(`ERROR: ${msg}`),
      debug: (_msg: string) => {},
    },
  };
}

/**
 * Create a mock child process that emits close/error events asynchronously.
 * Requires `spawn` to be mocked via `vi.mock("node:child_process")`.
 */
export function mockSpawnProc(
  spawnMock: ReturnType<typeof vi.fn>,
  exitCode: number | null = 0,
  error?: Error,
) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return proc;
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };

  spawnMock.mockReturnValue(proc as never);

  // Schedule events asynchronously so the caller's promise can attach listeners
  setTimeout(() => {
    if (error) {
      proc.emit("error", error);
    } else {
      proc.emit("close", exitCode);
    }
  }, 0);

  return proc;
}
