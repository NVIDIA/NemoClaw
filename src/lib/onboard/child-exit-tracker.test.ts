// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for trackChildExit. Co-located with the module.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3111

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { trackChildExit } from "./child-exit-tracker";

async function waitFor<T>(
  predicate: () => T | null | undefined,
  timeoutMs = 2000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = predicate();
    if (v !== null && v !== undefined && v !== (false as unknown as T)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("trackChildExit (#3111)", () => {
  it("reports exited=false while the child is running", async () => {
    const child = spawn("sleep", ["5"], { detached: true });
    const state = trackChildExit(child);
    expect(state.exited).toBe(false);
    expect(state.describeExit()).toBeNull();
    child.kill("SIGKILL");
    await waitFor(() => state.exited);
  });

  it("reports exited=true and the exit code after normal exit", async () => {
    const child = spawn("sh", ["-c", "exit 42"]);
    const state = trackChildExit(child);
    await waitFor(() => state.exited);
    expect(state.code).toBe(42);
    expect(state.signal).toBeNull();
    expect(state.describeExit()).toBe("exited with code 42");
  });

  it("reports the signal when the child is killed", async () => {
    const child = spawn("sleep", ["5"], { detached: true });
    const state = trackChildExit(child);
    child.kill("SIGKILL");
    await waitFor(() => state.exited);
    expect(state.signal).toBe("SIGKILL");
    expect(state.code).toBeNull();
    expect(state.describeExit()).toBe("killed by signal SIGKILL");
  });

  it("survives child.unref() — detached-mode-safe", async () => {
    // Regression guard for the #3111 scenario: startDockerDriverGateway
    // spawns with detached:true + unref(). The exit listener must still
    // fire after unref(), otherwise the whole point of this helper
    // (zombie detection) collapses.
    const child = spawn("sh", ["-c", "exit 7"], { detached: true });
    const state = trackChildExit(child);
    child.unref();
    await waitFor(() => state.exited);
    expect(state.code).toBe(7);
    expect(state.describeExit()).toBe("exited with code 7");
  });

  it("handles 'exited with code unknown' when both code and signal are null", async () => {
    // Contrived guard: if someone synthesises a minimal mock ChildProcess
    // that emits an exit event with (null, null), describeExit should not
    // crash or produce 'undefined' in the message.
    const fake = {
      once: (event: string, cb: (code: null, signal: null) => void) => {
        if (event === "exit") {
          queueMicrotask(() => cb(null, null));
        }
      },
      // biome-ignore lint/suspicious/noExplicitAny: narrowed mock shape
    } as any;
    const state = trackChildExit(fake);
    await waitFor(() => state.exited);
    expect(state.describeExit()).toBe("exited with code (unknown)");
  });
});
