// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./create-stream";
import { dockerEnv, FakeChild, makePollingOptions, vmEnv } from "./create-stream-test-fixtures";

describe("sandbox-create-stream ready gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["explicit empty gate on VM", vmEnv, [], false],
    ["explicit empty gate on Docker", dockerEnv, [], false],
    ["default Docker gate", dockerEnv, undefined, false],
    ["default VM gate", vmEnv, undefined, true],
  ])(
    "handles %s",
    async (_label, env, readyCheckOutputPatterns, shouldWaitForStartupOutput) => {
      vi.useFakeTimers();

      const child = new FakeChild();
      const logLine = vi.fn();
      let resolved = false;
      const promise = streamSandboxCreate(
        "echo create",
        env,
        makePollingOptions(child, {
          readyCheck: () => true,
          readyCheckOutputPatterns,
          logLine,
        }),
      ).then((result) => {
        resolved = true;
        return result;
      });

      child.stdout.emit("data", Buffer.from("Created sandbox: demo\n"));
      await vi.advanceTimersByTimeAsync(6);

      const waitMessage =
        "  Sandbox reported Ready; waiting for startup command output before detaching.";
      if (shouldWaitForStartupOutput) {
        expect(resolved).toBe(false);
        expect(child.kill).not.toHaveBeenCalled();
        expect(logLine).toHaveBeenCalledWith(waitMessage);
        child.stderr.emit("data", Buffer.from("Setting up NemoClaw (Hermes)...\n"));
        await vi.advanceTimersByTimeAsync(6);
      } else {
        expect(logLine).not.toHaveBeenCalledWith(waitMessage);
      }

      await expect(promise).resolves.toMatchObject({
        status: 0,
        forcedReady: true,
        output: expect.stringContaining("Sandbox reported Ready before create stream exited"),
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("runs poll side effects only after a not-ready poll", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const onPoll = vi.fn();
    let ready = false;
    const promise = streamSandboxCreate(
      "echo create",
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => ready, onPoll }),
    );

    await vi.advanceTimersByTimeAsync(6);
    expect(onPoll).toHaveBeenCalledTimes(1);

    ready = true;
    await vi.advanceTimersByTimeAsync(6);
    await expect(promise).resolves.toMatchObject({ status: 0, forcedReady: true });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("traces redacted poll side-effect errors and keeps polling", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const traceEvent = vi.fn();
    const onPoll = vi.fn(() => {
      throw new Error("Authorization: Bearer secret-token");
    });
    let ready = false;
    const promise = streamSandboxCreate(
      "echo create",
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => ready, onPoll, traceEvent }),
    );

    await vi.advanceTimersByTimeAsync(6);
    expect(traceEvent).toHaveBeenCalledWith("sandbox_create_poll_error", {
      message: "Authorization: Bearer secr********",
    });

    ready = true;
    await vi.advanceTimersByTimeAsync(6);
    await expect(promise).resolves.toMatchObject({ status: 0, forcedReady: true });
  });
});
