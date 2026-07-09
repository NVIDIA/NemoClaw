// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { streamSandboxCreate } from "./create-stream";
import { dockerEnv, FakeChild, makePollingOptions, vmEnv } from "./create-stream-test-fixtures";
import {
  getReadyCheckOutputPatterns,
  getReadyCheckOutputPatternsForAgent,
} from "./create-stream-ready-gate";

describe("sandbox-create-stream ready gate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["explicit empty gate on VM", vmEnv, []],
    ["explicit empty gate on Docker", dockerEnv, []],
    ["default Docker gate", dockerEnv, undefined],
  ])("detaches immediately for %s", async (_label, env, readyCheckOutputPatterns) => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const logLine = vi.fn();
    const promise = streamSandboxCreate(
      "echo create",
      env,
      makePollingOptions(child, {
        readyCheck: () => true,
        readyCheckOutputPatterns,
        logLine,
      }),
    );

    child.stdout.emit("data", Buffer.from("Created sandbox: demo\n"));
    await vi.advanceTimersByTimeAsync(6);

    expect(logLine).not.toHaveBeenCalledWith(
      "  Sandbox reported Ready; waiting for startup command output before detaching.",
    );
    await expect(promise).resolves.toMatchObject({
      status: 0,
      forcedReady: true,
      output: expect.stringContaining("Sandbox reported Ready before create stream exited"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    ["non-terminal Docker", false, dockerEnv],
    ["non-terminal VM", false, vmEnv],
    ["terminal Docker", true, dockerEnv],
    ["terminal VM", true, vmEnv],
  ])("keeps agent and env ready gates equivalent for %s", (_label, isTerminalAgent, env) => {
    const explicitPatterns = getReadyCheckOutputPatternsForAgent(isTerminalAgent, env);
    expect(getReadyCheckOutputPatterns(env, explicitPatterns)).toEqual(explicitPatterns);
  });

  it("ignores process env driver overrides when explicit env is supplied", () => {
    vi.stubEnv("OPENSHELL_DRIVERS", "vm");
    expect(getReadyCheckOutputPatterns(dockerEnv, undefined)).toEqual([]);
  });

  it("waits for startup output before detaching with the default VM gate", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const logLine = vi.fn();
    let resolved = false;
    const promise = streamSandboxCreate(
      "echo create",
      vmEnv,
      makePollingOptions(child, { readyCheck: () => true, logLine }),
    ).then((result) => {
      resolved = true;
      return result;
    });

    child.stdout.emit("data", Buffer.from("Created sandbox: demo\n"));
    await vi.advanceTimersByTimeAsync(6);

    expect(resolved).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(logLine).toHaveBeenCalledWith(
      "  Sandbox reported Ready; waiting for startup command output before detaching.",
    );

    child.stderr.emit("data", Buffer.from("Setting up NemoClaw (Hermes)...\n"));
    await vi.advanceTimersByTimeAsync(6);

    await expect(promise).resolves.toMatchObject({
      status: 0,
      forcedReady: true,
      output: expect.stringContaining("Sandbox reported Ready before create stream exited"),
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects poll side effects without a terminal failure check", () => {
    expect(() =>
      streamSandboxCreate(
        "echo create",
        dockerEnv,
        makePollingOptions(new FakeChild(), { readyCheck: () => false, onPoll: () => {} }),
      ),
    ).toThrow(
      "streamSandboxCreate onPoll requires failureCheck (e.g., dockerGpuCreatePatch.createFailureMessage)",
    );
  });

  it("runs poll side effects only after a not-ready poll", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const onPoll = vi.fn();
    let ready = false;
    const promise = streamSandboxCreate(
      "echo create",
      dockerEnv,
      makePollingOptions(child, { readyCheck: () => ready, onPoll, failureCheck: () => null }),
    );

    await vi.advanceTimersByTimeAsync(6);
    expect(onPoll).toHaveBeenCalledTimes(1);

    ready = true;
    await vi.advanceTimersByTimeAsync(6);
    await expect(promise).resolves.toMatchObject({ status: 0, forcedReady: true });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("aborts poll side-effect errors with a generic redacted failure", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const traceEvent = vi.fn();
    const logLine = vi.fn();
    const onPoll = vi.fn(() => {
      throw new Error("Authorization: Bearer secret-token");
    });
    const promise = streamSandboxCreate(
      "echo create",
      dockerEnv,
      makePollingOptions(child, {
        readyCheck: () => false,
        onPoll,
        failureCheck: () => null,
        traceEvent,
        logLine,
      }),
    );

    await vi.advanceTimersByTimeAsync(6);

    await expect(promise).resolves.toMatchObject({
      status: 1,
      output: expect.stringContaining("Sandbox create poll side effect failed."),
    });
    expect(traceEvent).toHaveBeenCalledWith("sandbox_create_poll_error", {
      message: "Authorization: Bearer secr********",
    });
    expect(logLine).toHaveBeenCalledWith("  Sandbox create poll side effect failed.");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("checks failure after a poll side-effect error in the same tick", async () => {
    vi.useFakeTimers();

    const child = new FakeChild();
    const traceEvent = vi.fn();
    const logLine = vi.fn();
    const promise = streamSandboxCreate(
      "echo create",
      dockerEnv,
      makePollingOptions(child, {
        readyCheck: () => false,
        onPoll: () => {
          throw new Error("Authorization: Bearer secret-token");
        },
        failureCheck: () => "Docker GPU patch failed",
        traceEvent,
        logLine,
      }),
    );

    await vi.advanceTimersByTimeAsync(6);

    await expect(promise).resolves.toMatchObject({
      status: 1,
      output: expect.stringContaining("Docker GPU patch failed"),
    });
    expect(traceEvent).toHaveBeenCalledWith("sandbox_create_poll_error", {
      message: "Authorization: Bearer secr********",
    });
    expect(logLine).toHaveBeenCalledWith("  Docker GPU patch failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.unref).toHaveBeenCalled();
  });
});
