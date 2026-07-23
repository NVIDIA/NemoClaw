// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  startTestProgress,
  type TestProgressOptions,
  validateE2EPhasePlan,
} from "../fixtures/progress.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installSandbox } from "../live/agent-turn-latency-helpers.ts";

function progressHarness() {
  const state = {
    clearCalls: 0,
    clockMs: 1_000,
    lines: [] as string[],
    scheduledDelays: [] as number[],
    timerCallback: null as (() => void) | null,
  };
  const options: TestProgressOptions = {
    stallThresholdMs: 5 * 60_000,
    stallReminderIntervalMs: 10 * 60_000,
    now: () => state.clockMs,
    setTimer: (callback, delayMs) => {
      state.timerCallback = callback;
      state.scheduledDelays.push(delayMs);
      return { unref() {} };
    },
    clearTimer: () => {
      state.clearCalls += 1;
    },
    logLine: (line) => state.lines.push(line),
    sampleResources: () => ({
      freeMemoryBytes: 8 * 1024 ** 3,
      processRssBytes: 0.5 * 1024 ** 3,
      totalMemoryBytes: 16 * 1024 ** 3,
      workspaceFreeBytes: 6 * 1024 ** 3,
      loadAverage1m: 2.5,
    }),
  };
  return { options, state };
}

function successfulProbe(): ShellProbeResult {
  return {
    command: ["bash", "install.sh"],
    durationMs: 10,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
  };
}

function failedProbe(stderr: string): ShellProbeResult {
  return {
    ...successfulProbe(),
    exitCode: 1,
    stderr,
  };
}

describe("live test progress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports semantic transitions and adds command-safe evidence only after a stall", () => {
    const { options, state } = progressHarness();
    const progress = startTestProgress(
      "agent-turn-latency",
      ["install OpenClaw sandbox", "install Hermes sandbox"],
      options,
    );

    progress.onOutput({ stream: "stderr", atMs: 61_000 });
    state.clockMs = 250_000;
    const finishCommand = progress.activity("command: install-openclaw");
    state.clockMs = 301_000;
    state.timerCallback?.();
    finishCommand();
    state.clockMs = 361_000;
    progress.phase("install Hermes sandbox");
    progress.stop();

    expect(state.clearCalls).toBe(2);
    expect(state.scheduledDelays).toEqual([300_000, 600_000, 300_000]);
    expect(state.lines).toEqual([
      "[e2e phase 1/2] install OpenClaw sandbox",
      "[e2e phase 1/2] still running: install OpenClaw sandbox (phase 5m; child output 4m ago; activity command: install-openclaw; rss 0.5 GiB; memory free 8.0 GiB/16.0 GiB; disk free 6.0 GiB; load 2.50)",
      "[e2e phase 1/2] install OpenClaw sandbox — passed in 6m; next 2/2: install Hermes sandbox",
      "[e2e phase 2/2] install Hermes sandbox — passed in 0s",
    ]);
    expect(progress.summary()).toEqual({
      version: 1,
      scenario: "agent-turn-latency",
      startedAtMs: 1_000,
      finishedAtMs: 361_000,
      durationMs: 360_000,
      phases: [
        {
          label: "install OpenClaw sandbox",
          outcome: "passed",
          startedAtMs: 1_000,
          finishedAtMs: 361_000,
          durationMs: 360_000,
          outputEvents: 1,
          lastOutputAtMs: 61_000,
        },
        {
          label: "install Hermes sandbox",
          outcome: "passed",
          startedAtMs: 361_000,
          finishedAtMs: 361_000,
          durationMs: 0,
          outputEvents: 0,
          lastOutputAtMs: null,
        },
      ],
    });
  });

  it("records the final phase duration and failure outcome without repeating test identity", () => {
    const { options, state } = progressHarness();
    const progress = startTestProgress(
      "identity-that-must-stay-out-of-live-lines",
      ["prepare hosted inference", "send OpenClaw agent turn"],
      options,
    );

    state.clockMs = 61_000;
    progress.stop("failed");

    expect(state.lines).toEqual([
      "[e2e phase 1/2] prepare hosted inference",
      "[e2e phase 1/2] prepare hosted inference — failed in 1m",
    ]);
    expect(state.lines.join("\n")).not.toContain("identity-that-must-stay-out-of-live-lines");
    expect(progress.summary().phases).toEqual([
      expect.objectContaining({
        label: "prepare hosted inference",
        outcome: "failed",
        durationMs: 60_000,
      }),
    ]);
  });

  it("rejects generic plans and undeclared or backward transitions", () => {
    expect(() => validateE2EPhasePlan(["setup", "validate inference response"])).toThrow(
      "phase label must describe test behavior",
    );
    expect(() =>
      validateE2EPhasePlan(["prepare inference endpoint", "prepare inference endpoint"]),
    ).toThrow("duplicate live E2E phase label");

    const { options } = progressHarness();
    const progress = startTestProgress(
      "phase-contract",
      ["prepare inference endpoint", "onboard OpenClaw sandbox", "validate agent turn"],
      options,
    );
    progress.phase("validate agent turn");

    expect(() => progress.phase("undeclared phase")).toThrow("undeclared live E2E phase");
    expect(() => progress.phase("prepare inference endpoint")).toThrow(
      "live E2E phase moved backwards",
    );
    expect(progress.summary().phases).toEqual([
      expect.objectContaining({ label: "prepare inference endpoint", outcome: "passed" }),
      expect.objectContaining({ label: "onboard OpenClaw sandbox", outcome: "skipped" }),
    ]);
    progress.stop();
  });

  it("connects install output to the timestamp-only observer", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () => successfulProbe());
    const host = { command } as unknown as HostCliClient;
    const progress = { onOutput: vi.fn() };

    await installSandbox(
      host,
      "e2e-openclaw-turn-latency",
      "openclaw",
      "secret-api-key",
      undefined,
      progress,
    );

    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[2]).toMatchObject({
      artifactName: "openclaw-install-attempt-1",
      onOutput: progress.onOutput,
      redactionValues: ["secret-api-key"],
    });
  });

  it("retries transient install failures with cleanup and backoff", async () => {
    vi.useFakeTimers();
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(
        failedProbe("Chat Completions API validation failed: request timed out"),
      )
      .mockResolvedValueOnce(successfulProbe());
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const progress = { onOutput: vi.fn() };
    const host = { command } as unknown as HostCliClient;

    const resultPromise = installSandbox(
      host,
      "e2e-openclaw-turn-latency",
      "openclaw",
      "secret-api-key",
      cleanupBeforeRetry,
      progress,
    );
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 });
    expect(cleanupBeforeRetry).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledTimes(2);
    expect(command.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({
        artifactName: "openclaw-install-attempt-1",
        onOutput: progress.onOutput,
      }),
      expect.objectContaining({
        artifactName: "openclaw-install-attempt-2",
        onOutput: progress.onOutput,
      }),
    ]);
  });

  it("does not report retry phases for a non-transient install failure", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () =>
      failedProbe("endpoint validation failed: invalid NVIDIA_INFERENCE_API_KEY credential"),
    );
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const progress = { onOutput: vi.fn() };
    const host = { command } as unknown as HostCliClient;

    await expect(
      installSandbox(
        host,
        "e2e-openclaw-turn-latency",
        "openclaw",
        "secret-api-key",
        cleanupBeforeRetry,
        progress,
      ),
    ).resolves.toMatchObject({ exitCode: 1 });

    expect(command).toHaveBeenCalledOnce();
    expect(cleanupBeforeRetry).not.toHaveBeenCalled();
  });
});
