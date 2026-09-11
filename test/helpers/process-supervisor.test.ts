// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused unit tests for shared process-group cleanup and
 * SIGTERM -> SIGKILL escalation.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { superviseChild } from "./process-supervisor.ts";

describe("helpers/process-supervisor", () => {
  it("returns exitCode 0 when the child exits cleanly", async () => {
    const child = spawn("bash", ["-c", "exit 0"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await superviseChild(child, { timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false });
    expect(result.spawnError).toBeUndefined();
  });

  it("returns the child's non-zero exit code verbatim", async () => {
    const child = spawn("bash", ["-c", "exit 7"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await superviseChild(child, { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("captures stdout and stderr via the chunk callbacks", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const child = spawn("bash", ["-c", "echo to-stdout; echo to-stderr >&2"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await superviseChild(child, {
      timeoutMs: 5_000,
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(out.join("")).toMatch(/to-stdout/);
    expect(err.join("")).toMatch(/to-stderr/);
  });

  it("flags timedOut and kills the process group when the child ignores SIGTERM", async () => {
    // The trap installs an empty SIGTERM handler, so a plain
    // child.kill(SIGTERM) on the leader would never terminate the
    // group. Without the supervisor's SIGKILL escalation the test
    // would hang up to its outer timeout instead of resolving.
    const script = 'trap "" TERM; sleep 30 & wait';
    const child = spawn("bash", ["-c", script], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const result = await superviseChild(child, { timeoutMs: 200, killGraceMs: 200 });
    const elapsed = Date.now() - startedAt;
    expect(result.timedOut).toBe(true);
    // killGraceMs + a small scheduling margin; if escalation never
    // ran this would take ~30 seconds.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("honors an AbortSignal without flagging the run as a timeout", async () => {
    const controller = new AbortController();
    const child = spawn("bash", ["-c", "sleep 10"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    setTimeout(() => controller.abort(), 50).unref();
    const result = await superviseChild(child, {
      timeoutMs: 10_000,
      killGraceMs: 200,
      signal: controller.signal,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it("disarms the wall timer on abort so an external cancel cannot retroactively flip timedOut=true", async () => {
    // timeoutMs is set just past the abort delay so a stale wall
    // timer (if not cleared on abort) would fire before the child
    // dies on SIGKILL and flip timedOut to true. The fix in
    // onAbort() clears the wall timeout before terminate().
    const controller = new AbortController();
    const child = spawn("bash", ["-c", 'trap "" TERM; sleep 30 & wait'], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    setTimeout(() => controller.abort(), 50).unref();
    const result = await superviseChild(child, {
      timeoutMs: 100,
      killGraceMs: 200,
      signal: controller.signal,
    });
    expect(result.timedOut).toBe(false);
  });

  it("surfaces spawn errors via spawnError instead of a numeric exit", async () => {
    const child = spawn("definitely-not-a-real-binary-xyz", [], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await superviseChild(child, { timeoutMs: 5_000 });
    expect(result.spawnError).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it("feeds stdin to the child when stdio[0] is piped", async () => {
    const out: string[] = [];
    const child = spawn("bash", ["-c", "cat"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const result = await superviseChild(child, {
      timeoutMs: 5_000,
      stdin: "supervised-stdin-payload",
      onStdout: (chunk) => out.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(out.join("")).toMatch(/supervised-stdin-payload/);
  });
});
