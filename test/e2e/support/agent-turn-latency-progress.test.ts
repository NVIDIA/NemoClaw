// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  startTestProgress,
  type TestProgressOptions,
  validateE2EPhasePlan,
} from "../fixtures/progress.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  bestEffortPreclean,
  cleanupTurnSandboxes,
  installSandbox,
} from "../live/agent-turn-latency-helpers.ts";

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

function failedProbe(stderr: string, timedOut = false): ShellProbeResult {
  return {
    ...successfulProbe(),
    exitCode: 1,
    stderr,
    timedOut,
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
      '[e2e target="unassigned" scenario="agent-turn-latency"] [phase 1/2] started: install OpenClaw sandbox (total 0s; phase 0s)',
      '[e2e target="unassigned" scenario="agent-turn-latency"] [phase 1/2] still running: install OpenClaw sandbox (total 5m; phase 5m; child output 4m ago; activity command: install-openclaw; rss 0.5 GiB; memory free 8.0 GiB/16.0 GiB; disk free 6.0 GiB; load 2.50)',
      '[e2e target="unassigned" scenario="agent-turn-latency"] [phase 1/2] completed: install OpenClaw sandbox — passed in 6m (total 6m)',
      '[e2e target="unassigned" scenario="agent-turn-latency"] [phase 2/2] started: install Hermes sandbox (total 6m; phase 0s)',
      '[e2e target="unassigned" scenario="agent-turn-latency"] [phase 2/2] completed: install Hermes sandbox — passed in 0s (total 6m)',
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

  it("records test identity, duration, and the final phase failure outcome", () => {
    const { options, state } = progressHarness();
    const progress = startTestProgress(
      "visible-agent-turn-scenario",
      ["prepare hosted inference", "send OpenClaw agent turn"],
      options,
    );

    state.clockMs = 61_000;
    progress.stop("failed");

    expect(state.lines).toEqual([
      '[e2e target="unassigned" scenario="visible-agent-turn-scenario"] [phase 1/2] started: prepare hosted inference (total 0s; phase 0s)',
      '[e2e target="unassigned" scenario="visible-agent-turn-scenario"] [phase 1/2] completed: prepare hosted inference — failed in 1m (total 1m)',
    ]);
    expect(state.lines.join("\n")).toContain("visible-agent-turn-scenario");
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
    expect(() =>
      validateE2EPhasePlan(["prepare inference endpoint\n::error::forged", "validate response"]),
    ).toThrow("invalid live E2E phase label");
    expect(() => validateE2EPhasePlan(["p".repeat(161), "validate response"])).toThrow(
      "invalid live E2E phase label",
    );

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
    const finishActivity = vi.fn();
    const progress = {
      activity: vi.fn(() => finishActivity),
      event: vi.fn(),
      onOutput: vi.fn(),
    };

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
    expect(progress.event.mock.calls).toEqual([
      ["openclaw install attempt 1/2 started"],
      ["openclaw install attempt 1/2 passed"],
    ]);
    expect(progress.activity).toHaveBeenCalledWith("command: openclaw-install-attempt-1");
    expect(finishActivity).toHaveBeenCalledOnce();
  });

  it("reports timeout, cleanup, and backoff before retrying a transient install", async () => {
    vi.useFakeTimers();
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(
        failedProbe("Chat Completions API validation failed: request timed out", true),
      )
      .mockResolvedValueOnce(successfulProbe());
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const finishActivity = vi.fn();
    const progress = {
      activity: vi.fn(() => finishActivity),
      event: vi.fn(),
      onOutput: vi.fn(),
    };
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
    expect(progress.event.mock.calls).toEqual([
      ["openclaw install attempt 1/2 started"],
      ["openclaw install attempt 1/2 timeout fired at the 30-minute limit"],
      ["openclaw install attempt 1/2 starting cleanup before retry"],
      ["openclaw install attempt 1/2 cleanup before retry passed"],
      ["openclaw install attempt 1/2 waiting 10s before retry"],
      ["openclaw install attempt 2/2 started"],
      ["openclaw install attempt 2/2 passed"],
    ]);
    expect(progress.activity.mock.calls).toEqual([
      ["command: openclaw-install-attempt-1"],
      ["cleanup: openclaw-install-attempt-1-retry"],
      ["command: openclaw-install-attempt-2"],
    ]);
    expect(finishActivity).toHaveBeenCalledTimes(3);
  });

  it("does not report retry phases for a non-transient install failure", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () =>
      failedProbe("endpoint validation failed: invalid NVIDIA_INFERENCE_API_KEY credential"),
    );
    const cleanupBeforeRetry = vi.fn(async () => undefined);
    const finishActivity = vi.fn();
    const progress = {
      activity: vi.fn(() => finishActivity),
      event: vi.fn(),
      onOutput: vi.fn(),
    };
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
    expect(progress.event.mock.calls).toEqual([
      ["openclaw install attempt 1/2 started"],
      ["openclaw install attempt 1/2 failed"],
    ]);
    expect(finishActivity).toHaveBeenCalledOnce();
  });

  it("reports each pre-clean boundary and closes its heartbeat activity", async () => {
    const command = vi.fn<HostCliClient["command"]>(async () => successfulProbe());
    const openshell = vi.fn<SandboxClient["openshell"]>(async () => successfulProbe());
    const host = { command } as unknown as HostCliClient;
    const sandbox = { openshell } as unknown as SandboxClient;
    const activityFinishes: ReturnType<typeof vi.fn>[] = [];
    const progress = {
      activity: vi.fn(() => {
        const finish = vi.fn();
        activityFinishes.push(finish);
        return finish;
      }),
      event: vi.fn(),
      onOutput: vi.fn(),
    };

    await cleanupTurnSandboxes(host, sandbox, progress);

    expect(command).toHaveBeenCalledTimes(2);
    expect(openshell).toHaveBeenCalledTimes(4);
    expect(progress.activity.mock.calls).toEqual([
      ["cleanup: destroy openclaw sandbox"],
      ["cleanup: delete openclaw sandbox"],
      ["cleanup: destroy hermes sandbox"],
      ["cleanup: delete hermes sandbox"],
      ["cleanup: stop Hermes API forward"],
      ["cleanup: destroy OpenShell gateway"],
    ]);
    expect(progress.event.mock.calls).toEqual([
      ["destroy openclaw sandbox started"],
      ["destroy openclaw sandbox passed"],
      ["delete openclaw sandbox started"],
      ["delete openclaw sandbox passed"],
      ["destroy hermes sandbox started"],
      ["destroy hermes sandbox passed"],
      ["delete hermes sandbox started"],
      ["delete hermes sandbox passed"],
      ["stop Hermes API forward started"],
      ["stop Hermes API forward passed"],
      ["destroy OpenShell gateway started"],
      ["destroy OpenShell gateway passed"],
    ]);
    expect(activityFinishes).toHaveLength(6);
    for (const finish of activityFinishes) expect(finish).toHaveBeenCalledOnce();
  });

  it("keeps cleanup exception payloads out of live console diagnostics", async () => {
    const secret = "opaque-cleanup-exception-secret";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        bestEffortPreclean("destroy OpenClaw sandbox", async () => {
          throw new Error(secret);
        }),
      ).resolves.toBe(false);
      expect(warning).toHaveBeenCalledWith(
        "best-effort cleanup failed (destroy OpenClaw sandbox); see redacted command artifacts",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    } finally {
      warning.mockRestore();
    }
  });
});
