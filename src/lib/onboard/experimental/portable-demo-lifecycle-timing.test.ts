// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createPortableLifecycleTimingRecorder,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECONCILIATION_TOLERANCE_MS,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MAX_BYTES,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_MAX_LINE_LENGTH,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX,
} from "./portable-demo-lifecycle-timing";

const EPOCH_BASE_MS = 1_700_000_000_000;

function epochSeconds(offsetMs: number): string {
  return ((EPOCH_BASE_MS + offsetMs) / 1_000).toFixed(6);
}

function startupRecord(overrides: Partial<Record<string, number>> = {}): string {
  const offsets = {
    entry: 10,
    configStart: 20,
    configEnd: 35,
    providerEnd: 46,
    tokenEnd: 59,
    messagingEnd: 80,
    workspaceEnd: 100,
    spawnEnd: 110,
    ...overrides,
  };
  return `schema=1 entry=${epochSeconds(offsets.entry)} configStart=${epochSeconds(offsets.configStart)} configEnd=${epochSeconds(offsets.configEnd)} providerEnd=${epochSeconds(offsets.providerEnd)} tokenEnd=${epochSeconds(offsets.tokenEnd)} messagingEnd=${epochSeconds(offsets.messagingEnd)} workspaceEnd=${epochSeconds(offsets.workspaceEnd)} spawnEnd=${epochSeconds(offsets.spawnEnd)}\n`;
}

function gatewayTimingLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith(PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX));
}

function timingMilliseconds(line: string, field: string): number {
  const match = new RegExp(`(?:^| )${field}=(\\d+)ms(?: |$)`, "u").exec(line);
  expect(match, `Missing timing field: ${field}`).not.toBeNull();
  return Number(match?.[1]);
}

describe("portable lifecycle timing recorder", () => {
  it("emits one stable credential-free success line", () => {
    let clock = 0;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    expect(
      recorder.measure("authority", () => {
        clock = 7;
        return "ok";
      }),
    ).toBe("ok");
    recorder.setContainerAction("started");
    recorder.recordExecAttempt("not-ready");
    recorder.recordExecAttempt("timeout");
    recorder.recordExecAttempt("error");
    recorder.recordExecAttempt("ready");
    recorder.setGatewayAction("started");
    recorder.recordGatewayAttempt("not-ready");
    recorder.recordGatewayAttempt("timeout");
    recorder.recordGatewayAttempt("error");
    recorder.recordGatewayAttempt("ready");
    recorder.setOllamaAction("started");
    recorder.incrementOllamaAttempts();
    recorder.incrementOllamaAttempts();
    clock = 20;
    recorder.finish("recovered");
    recorder.finish("failed");

    expect(lines[0]).toBe(
      "  Portable lifecycle timing: authority=7ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=20ms containerAction=started gatewayAction=started ollamaAction=started ollamaAttempts=2 execAttempts=4 execNotReady=1 execTimeouts=1 execErrors=1 gatewayAttempts=4 gatewayNotReady=1 gatewayTimeouts=1 gatewayErrors=1 result=recovered",
    );
    expect(lines[1]).toBe(
      "  Portable OpenClaw gateway startup timing: launchToEntry=0ms entrySetup=0ms configIntegrity=0ms providerModelCors=0ms tokenPlaceholderHash=0ms messagingChannelsPreloadsScan=0ms workspaceAuthTemp=0ms gatewaySpawn=0ms spawnToFirstHealth=0ms launchToFirstHealth=0ms probe=0ms sleep=0ms firstReadyAttempt=0 lastFailure=none diagnosticRead=0ms diagnosticReadOutcome=not-applicable",
    );
  });

  it("emits direct OpenClaw startup phase durations after correlated health", () => {
    let diagnosticClock = 0;
    let epochClock = EPOCH_BASE_MS;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => diagnosticClock,
      epochNow: () => epochClock,
      write: (line) => lines.push(line),
    });

    recorder.recordGatewayAttempt("not-ready");
    recorder.beginOpenClawGatewayStartup();
    recorder.measureOpenClawGatewayProbe(() => {
      diagnosticClock += 30;
    });
    recorder.measureOpenClawGatewaySleep(() => {
      diagnosticClock += 1_000;
    });
    recorder.measureOpenClawGatewayProbe(() => {
      diagnosticClock += 30;
      epochClock = EPOCH_BASE_MS + 2_110;
      recorder.recordGatewayAttempt("ready");
    });
    recorder.readOpenClawGatewayStartupTiming(() => {
      diagnosticClock += 20;
      return { status: 0, stdout: startupRecord() };
    }, 95_000);
    recorder.finish("recovered");

    const line = gatewayTimingLines(lines)[0];
    expect(line).toBe(
      "  Portable OpenClaw gateway startup timing: launchToEntry=10ms entrySetup=10ms configIntegrity=15ms providerModelCors=11ms tokenPlaceholderHash=13ms messagingChannelsPreloadsScan=21ms workspaceAuthTemp=20ms gatewaySpawn=10ms spawnToFirstHealth=2000ms launchToFirstHealth=2110ms probe=60ms sleep=1000ms firstReadyAttempt=1 lastFailure=none diagnosticRead=20ms diagnosticReadOutcome=recorded",
    );

    const nonOverlappingPhases = [
      "launchToEntry",
      "entrySetup",
      "configIntegrity",
      "providerModelCors",
      "tokenPlaceholderHash",
      "messagingChannelsPreloadsScan",
      "workspaceAuthTemp",
      "gatewaySpawn",
      "spawnToFirstHealth",
    ];
    const phaseTotal = nonOverlappingPhases.reduce(
      (total, field) => total + timingMilliseconds(line, field),
      0,
    );
    expect(
      Math.abs(phaseTotal - timingMilliseconds(line, "launchToFirstHealth")),
    ).toBeLessThanOrEqual(PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECONCILIATION_TOLERANCE_MS);
  });

  it("preserves the established lifecycle receipt shape for twelve gateway attempts (#9200)", () => {
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => 0,
      write: (line) => lines.push(line),
    });

    recorder.setContainerAction("started");
    recorder.setGatewayAction("started");
    Array.from({ length: 11 }, () => recorder.recordGatewayAttempt("not-ready"));
    recorder.recordGatewayAttempt("ready");
    recorder.finish("recovered");

    expect(lines[0]).toBe(
      "  Portable lifecycle timing: authority=0ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=0ms containerAction=started gatewayAction=started ollamaAction=not-applicable ollamaAttempts=0 execAttempts=0 execNotReady=0 execTimeouts=0 execErrors=0 gatewayAttempts=12 gatewayNotReady=11 gatewayTimeouts=0 gatewayErrors=0 result=recovered",
    );
  });

  it.each([
    ["missing", { status: PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS }],
    ["error", { status: 1 }],
    ["malformed", { status: 0, stdout: `${startupRecord().trim()} extra=secret-value\n` }],
    ["malformed", { status: 0, stdout: startupRecord({ configStart: 40 }) }],
    [
      "malformed",
      { status: 0, stdout: "x".repeat(PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MAX_BYTES + 1) },
    ],
    [
      "timeout",
      { status: 1, error: Object.assign(new Error("secret timeout"), { code: "ETIMEDOUT" }) },
    ],
    ["error", { status: 1, error: new Error("secret transport") }],
  ] as const)("classifies a %s diagnostic read without exposing its content", (outcome, result) => {
    let epochClock = EPOCH_BASE_MS;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => 0,
      epochNow: () => epochClock,
      write: (line) => lines.push(line),
    });

    recorder.beginOpenClawGatewayStartup();
    epochClock += 1_000;
    recorder.recordGatewayAttempt("ready");
    recorder.readOpenClawGatewayStartupTiming(() => result, 95_000);
    recorder.finish("recovered");

    expect(gatewayTimingLines(lines)[0]).toContain(`diagnosticReadOutcome=${outcome}`);
    expect(gatewayTimingLines(lines)[0]).not.toContain("secret");
  });

  it("rejects a timing record from a previous gateway launch as stale", () => {
    let epochClock = EPOCH_BASE_MS + 1_000;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => 0,
      epochNow: () => epochClock,
      write: (line) => lines.push(line),
    });

    recorder.beginOpenClawGatewayStartup();
    epochClock += 1_000;
    recorder.recordGatewayAttempt("ready");
    recorder.readOpenClawGatewayStartupTiming(
      () => ({ status: 0, stdout: startupRecord() }),
      95_000,
    );
    recorder.finish("recovered");

    expect(gatewayTimingLines(lines)[0]).toContain("diagnosticReadOutcome=stale");
    expect(gatewayTimingLines(lines)[0]).toContain("launchToEntry=0ms");
  });

  it("reports a correlation clock failure without reading the startup record", () => {
    const lines: string[] = [];
    const read = vi.fn(() => ({ status: 0, stdout: startupRecord() }));
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => 0,
      epochNow: () => {
        throw new Error("clock detail");
      },
      write: (line) => lines.push(line),
    });

    recorder.beginOpenClawGatewayStartup();
    recorder.recordGatewayAttempt("ready");
    recorder.readOpenClawGatewayStartupTiming(read, 95_000);
    recorder.finish("recovered");

    expect(read).not.toHaveBeenCalled();
    expect(gatewayTimingLines(lines)[0]).toContain("diagnosticReadOutcome=clock-error");
    expect(gatewayTimingLines(lines)[0]).not.toContain("clock detail");
  });

  it("bounds the OpenClaw gateway startup timing line", () => {
    let diagnosticClock = 0;
    let epochClock = EPOCH_BASE_MS;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => diagnosticClock,
      epochNow: () => epochClock,
      write: (line) => lines.push(line),
    });

    recorder.beginOpenClawGatewayStartup();
    Array.from({ length: 10_000 }, () => recorder.recordGatewayAttempt("not-ready"));
    diagnosticClock = Number.MAX_SAFE_INTEGER;
    recorder.measureOpenClawGatewayProbe(() => {
      diagnosticClock = Number.MAX_SAFE_INTEGER;
    });
    epochClock += 2_000;
    recorder.recordGatewayAttempt("ready");
    recorder.readOpenClawGatewayStartupTiming(
      () => ({ status: 0, stdout: startupRecord() }),
      95_000,
    );
    recorder.finish("recovered");

    expect(gatewayTimingLines(lines)[0].length).toBeLessThanOrEqual(
      PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_MAX_LINE_LENGTH,
    );
  });

  it("records the first failed stage without exposing the error", () => {
    let clock = 0;
    const lines: string[] = [];
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    expect(() =>
      recorder.measure("gatewayReady", () => {
        clock = 13_000;
        throw new Error("secret endpoint");
      }),
    ).toThrow("secret endpoint");
    recorder.finish("failed");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("gatewayReady=13000ms");
    expect(lines[0]).toContain("result=failed failedStage=gatewayReady");
    expect(lines.join("\n")).not.toContain("secret endpoint");
  });

  it("never changes recovery behavior when its clock or writer fails", () => {
    const writer = vi.fn(() => {
      throw new Error("writer failed");
    });
    const recorder = createPortableLifecycleTimingRecorder({
      now: () => {
        throw new Error("clock failed");
      },
      write: writer,
    });

    expect(recorder.measure("inspect", () => 42)).toBe(42);
    expect(() => recorder.finish("already-running")).not.toThrow();
    expect(writer).toHaveBeenCalledTimes(2);
  });
});
