// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createProbeTimingRecorder } from "./timing";

describe("probe timing recorder", () => {
  it("emits one stable bounded success line with every stage and action", async () => {
    let clock = 0;
    const lines: string[] = [];
    const recorder = createProbeTimingRecorder({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    expect(
      recorder.measure("readiness", () => {
        clock = 5;
        return "ready";
      }),
    ).toBe("ready");
    await expect(
      recorder.measureAsync("gateway", async () => {
        clock = 17;
        return "healthy";
      }),
    ).resolves.toBe("healthy");
    recorder.setLifecycleAction("reused");
    recorder.setForwardAction("restored");
    recorder.recordReadinessObservation("sandbox-identity", 1.4);
    recorder.recordReadinessObservation("policy-get", 2.6);
    recorder.recordReadinessDecision("accepted");
    clock = 20;
    recorder.finish("ready");
    recorder.finishOnExit("failed", "publication");

    expect(lines).toEqual([
      "  Probe timing: readiness=5ms authority=0ms lifecycle=0ms gateway=12ms processes=0ms forward=0ms inference=0ms pairing=0ms publication=0ms readiness.sandbox-identity=1ms readiness.sandbox-identity.attempts=1 readiness.policy-get=3ms readiness.policy-get.attempts=1 readiness.inference-get=0ms readiness.inference-get.attempts=0 readiness.gateway-health=0ms readiness.gateway-health.attempts=0 readiness.forward-health=0ms readiness.forward-health.attempts=0 readiness.inference-route=0ms readiness.inference-route.attempts=0 readiness.firstFailedObservation=none readiness.firstDecision=accepted readiness.firstFallbackDecision=none total=20ms lifecycleAction=reused forwardAction=restored result=ready",
    ]);
  });

  it("retains the first fallback observation and counts later successful reinspection", () => {
    const lines: string[] = [];
    const recorder = createProbeTimingRecorder({
      now: () => 10,
      write: (line) => lines.push(line),
    });

    recorder.recordReadinessObservation("sandbox-identity", 1);
    recorder.recordReadinessObservation("policy-get", 1);
    recorder.recordReadinessObservation("inference-get", 1);
    recorder.recordReadinessObservation("inference-route", 5);
    recorder.recordReadinessObservationFailure("inference-route");
    recorder.recordReadinessDecision("health");
    recorder.recordReadinessObservation("inference-route", 2);
    recorder.recordReadinessDecision("accepted");
    recorder.finish("ready");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("readiness.inference-route=7ms");
    expect(lines[0]).toContain("readiness.inference-route.attempts=2");
    expect(lines[0]).toContain("readiness.firstFailedObservation=inference-route");
    expect(lines[0]).toContain("readiness.firstDecision=health");
    expect(lines[0]).toContain("readiness.firstFallbackDecision=health");
  });

  it("records aggregate fallback without inventing an observation failure", () => {
    const lines: string[] = [];
    const recorder = createProbeTimingRecorder({
      now: () => 1,
      write: (line) => lines.push(line),
    });

    recorder.recordReadinessDecision("config");
    recorder.finish("ready");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("readiness.firstFailedObservation=none");
    expect(lines[0]).toContain("readiness.firstDecision=config");
    expect(lines[0]).toContain("readiness.firstFallbackDecision=config");
  });

  it("records the first failing stage without leaking the thrown error", () => {
    let clock = 0;
    const lines: string[] = [];
    const recorder = createProbeTimingRecorder({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    expect(() =>
      recorder.measure("forward", () => {
        clock = 9;
        throw new Error("secret-token-value");
      }),
    ).toThrow("secret-token-value");
    recorder.markFailureStage("publication");
    clock = 11;
    recorder.finish("failed");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("forward=9ms");
    expect(lines[0]).toContain("result=failed failedStage=forward");
    expect(lines[0]).not.toContain("secret-token-value");
  });

  it("emits one failed line when exit completion runs before normal completion", () => {
    let clock = 0;
    const lines: string[] = [];
    const recorder = createProbeTimingRecorder({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    clock = 7;
    recorder.finishOnExit("failed", "forward");
    recorder.finish("ready");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("total=7ms");
    expect(lines[0]).toContain("result=failed failedStage=forward");
  });

  it("never changes the measured operation when its clock or writer fails", async () => {
    const writer = vi.fn(() => {
      throw new Error("writer failed");
    });
    const recorder = createProbeTimingRecorder({
      now: () => {
        throw new Error("clock failed");
      },
      write: writer,
    });

    expect(recorder.measure("authority", () => 42)).toBe(42);
    await expect(recorder.measureAsync("inference", async () => "ok")).resolves.toBe("ok");
    expect(() => recorder.finish("ready")).not.toThrow();
    expect(writer).toHaveBeenCalledOnce();
  });
});
