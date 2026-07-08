// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as curlArgs from "../adapters/http/curl-args";
import {
  sleepMs,
  sleepMsAsync,
  sleepSeconds,
  waitForHttp,
  waitForPort,
  waitUntil,
  waitUntilAsync,
} from "./wait";

function spawnResult(
  status: number | null,
  error?: Error,
  signal: NodeJS.Signals | null = null,
): ReturnType<typeof childProcess.spawnSync> {
  return {
    error,
    output: [],
    pid: 1,
    signal,
    status,
    stderr: "",
    stdout: "",
  } as ReturnType<typeof childProcess.spawnSync>;
}

function expireAfterOneAttempt(): void {
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sleep primitives", () => {
  it("blocks for a finite positive millisecond duration", () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    sleepMs(25);

    expect(waitSpy).toHaveBeenCalledOnce();
    expect(waitSpy.mock.calls[0]?.slice(1)).toEqual([0, 0, 25]);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("does not block for an invalid millisecond duration (%s)", (duration) => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    sleepMs(duration);

    expect(waitSpy).not.toHaveBeenCalled();
  });

  it("converts seconds to milliseconds before blocking", () => {
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    sleepSeconds(0.25);

    expect(waitSpy.mock.calls[0]?.[3]).toBe(250);
  });

  it("resolves an asynchronous sleep after its timer elapses", async () => {
    vi.useFakeTimers();

    const sleeping = sleepMsAsync(25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(sleeping).resolves.toBeUndefined();
  });
});

describe("waitUntil", () => {
  it("returns immediately when the condition is already true", () => {
    const condition = vi.fn(() => true);
    const sleep = vi.fn();

    const result = waitUntil(condition, { deadlineMs: 100, now: () => 0, sleep });

    expect(result).toBe(true);
    expect(condition).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("backs off between attempts until the condition becomes true", () => {
    let now = 0;
    const condition = vi.fn(() => condition.mock.calls.length >= 4);
    const sleep = vi.fn((duration: number) => {
      now += duration;
    });

    const result = waitUntil(condition, {
      backoffFactor: 2,
      deadlineMs: 1_000,
      initialIntervalMs: 10,
      maxIntervalMs: 30,
      now: () => now,
      sleep,
    });

    expect(result).toBe(true);
    expect(condition).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([duration]) => duration)).toEqual([10, 20, 30]);
  });

  it("stops at the configured attempt cap", () => {
    const condition = vi.fn(() => false);
    const sleep = vi.fn();

    const result = waitUntil(condition, {
      maxAttempts: 3,
      now: () => 0,
      sleep,
    });

    expect(result).toBe(false);
    expect(condition).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("requires a deadline or attempt cap for injected options", () => {
    expect(() => waitUntil(() => true, {})).toThrow("waitUntil requires deadlineMs or maxAttempts");
  });

  it("stops before evaluating the condition when the clock is not finite", () => {
    const condition = vi.fn(() => true);
    const sleep = vi.fn();

    const result = waitUntil(condition, { deadlineMs: 100, now: () => Number.NaN, sleep });

    expect(result).toBe(false);
    expect(condition).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("waitUntilAsync", () => {
  it("awaits the condition and injected sleeper between attempts", async () => {
    let now = 0;
    const condition = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async (duration: number) => {
      now += duration;
    });

    const result = await waitUntilAsync(condition, {
      deadlineMs: 100,
      initialIntervalMs: 5,
      maxIntervalMs: 5,
      now: () => now,
      sleep,
    });

    expect(result).toBe(true);
    expect(condition).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("propagates a rejected condition without sleeping", async () => {
    const sleep = vi.fn();

    const waiting = waitUntilAsync(
      async () => {
        throw new Error("condition failed");
      },
      { deadlineMs: 100, now: () => 0, sleep },
    );

    await expect(waiting).rejects.toThrow("condition failed");
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("waitForPort", () => {
  it("returns true when netcat reaches the port", () => {
    const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(spawnResult(0));

    expect(waitForPort(8_080, 1)).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith("nc", ["-z", "127.0.0.1", "8080"], {
      stdio: "ignore",
    });
  });

  it("uses the Node TCP probe when netcat is unavailable", () => {
    const spawnSync = vi
      .spyOn(childProcess, "spawnSync")
      .mockReturnValueOnce(spawnResult(null, new Error("spawnSync nc ENOENT")))
      .mockReturnValueOnce(spawnResult(0));

    expect(waitForPort(8_080, 1)).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]?.[0]).toBe(process.execPath);
    const fallbackArgs = spawnSync.mock.calls[1]?.[1];
    expect(fallbackArgs?.[0]).toBe("-e");
    expect(fallbackArgs?.[1]).toContain("const p=Number(process.argv[1])");
    expect(fallbackArgs?.[1]).not.toContain("8080");
    expect(fallbackArgs?.at(-1)).toBe("8080");
  });

  it("returns false when the Node TCP probe times out", () => {
    expireAfterOneAttempt();
    const spawnSync = vi
      .spyOn(childProcess, "spawnSync")
      .mockReturnValueOnce(spawnResult(null, new Error("spawnSync nc ENOENT")))
      .mockReturnValueOnce(spawnResult(null, undefined, "SIGTERM"));

    expect(waitForPort(8_080, 1)).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]?.[2]).toMatchObject({ timeout: 2_000 });
  });

  it("returns false after an unsuccessful probe reaches its deadline", () => {
    expireAfterOneAttempt();
    const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(spawnResult(1));

    expect(waitForPort(9_999, 1)).toBe(false);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("returns false when the port probe throws", () => {
    expireAfterOneAttempt();
    vi.spyOn(childProcess, "spawnSync").mockImplementation(() => {
      throw new Error("probe failed");
    });

    expect(waitForPort(8_080, 1)).toBe(false);
  });
});

describe("waitForHttp", () => {
  it("returns true when curl reaches the endpoint", () => {
    const buildValidatedCurlCommandArgs = curlArgs.buildValidatedCurlCommandArgs;
    const buildArgs = vi
      .spyOn(curlArgs, "buildValidatedCurlCommandArgs")
      .mockImplementation(buildValidatedCurlCommandArgs);
    const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(spawnResult(0));
    const url = "http://127.0.0.1:8080/health";
    const rawArgs = ["-sf", "--connect-timeout", "1", "--max-time", "1", url];

    expect(waitForHttp(url, 1)).toBe(true);
    expect(buildArgs).toHaveBeenCalledWith(rawArgs);
    expect(spawnSync.mock.calls[0]?.[0]).toBe("curl");
    expect(spawnSync.mock.calls[0]?.[1]).toBe(buildArgs.mock.results[0]?.value);
  });

  it("keeps redirects denied for the HTTP wait probe argument pattern", () => {
    const url = "http://127.0.0.1:8080/health";

    expect(() =>
      curlArgs.buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "1",
        "--max-time",
        "1",
        "--location",
        url,
      ]),
    ).toThrow(/allowRedirects/);
  });

  it("returns false after an unsuccessful request reaches its deadline", () => {
    expireAfterOneAttempt();
    const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue(spawnResult(1));

    expect(waitForHttp("http://127.0.0.1:9999/health", 1)).toBe(false);
    expect(spawnSync).toHaveBeenCalledOnce();
  });

  it("returns false when curl throws", () => {
    expireAfterOneAttempt();
    vi.spyOn(childProcess, "spawnSync").mockImplementation(() => {
      throw new Error("curl failed");
    });

    expect(waitForHttp("http://127.0.0.1:8080/health", 1)).toBe(false);
  });
});
