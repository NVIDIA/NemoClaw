// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createPortableLifecycleTimingRecorder } from "./portable-demo-lifecycle-timing";

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

    expect(lines).toEqual([
      "  Portable lifecycle timing: authority=7ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=20ms containerAction=started gatewayAction=started ollamaAction=started ollamaAttempts=2 execAttempts=4 execNotReady=1 execTimeouts=1 execErrors=1 gatewayAttempts=4 gatewayNotReady=1 gatewayTimeouts=1 gatewayErrors=1 result=recovered",
    ]);
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

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("gatewayReady=13000ms");
    expect(lines[0]).toContain("result=failed failedStage=gatewayReady");
    expect(lines[0]).not.toContain("secret endpoint");
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
    expect(writer).toHaveBeenCalledOnce();
  });
});
