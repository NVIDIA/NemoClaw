// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireMxcWindowsOpenShellPins } from "./mxc-windows-openshell-executor";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

function pinChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    exitCode: null,
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  return child;
}

describe("Windows MXC file pin protocol", () => {
  it("reports the existing 60-second acquisition deadline without retrying", async () => {
    vi.useFakeTimers();
    const child = pinChild();
    const result = acquireMxcWindowsOpenShellPins({ directories: [], files: [] }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      mutationState: "not-started",
      verification: { stage: "pin-acquire", errorClass: "timeout" },
    });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "secret arbitrary native error\n",
    "NEMOCLAW_MXC_PIN_ERROR:file:boundary-error:65536\n",
    "NEMOCLAW_MXC_PIN_ERROR:secret:boundary-error:32\n",
    "NEMOCLAW_MXC_PIN_ERROR:file:secret:32\n",
    "x".repeat(129),
  ])("rejects unrecognized or unbounded native output %#", async (output) => {
    const child = pinChild();
    const result = acquireMxcWindowsOpenShellPins({ directories: [], files: [] }).catch(
      (error: unknown) => error,
    );
    child.stdout.write(output);
    const error = await result;
    expect(error).toMatchObject({
      mutationState: "not-started",
      verification: { stage: "pin-protocol", errorClass: "invalid-output" },
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("keeps release timeout ambiguous after the unchanged ready handshake", async () => {
    vi.useFakeTimers();
    const child = pinChild();
    const pending = acquireMxcWindowsOpenShellPins({ directories: [], files: [] });
    child.stdout.write("NEMOCLAW_MXC_PIN_READY\n");
    const lease = await pending;
    expect(lease.isActive()).toBe(true);
    const released = lease.release().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await released).toMatchObject({
      mutationState: "unknown",
      verification: { stage: "pin-release", errorClass: "timeout" },
    });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
