// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import { waitForCreatedSandboxReadyWithTrace } from "./sandbox-readiness-tracing";

const NAME = "my-sandbox";

function replay(outputs: readonly string[]) {
  let index = 0;
  const runCaptureOpenshell = vi.fn(() => outputs[Math.min(index++, outputs.length - 1)] ?? "");
  return { runCaptureOpenshell, sleep: vi.fn() };
}

describe("created sandbox Ready stability", () => {
  it("preserves single-poll Ready acceptance by default", () => {
    const { runCaptureOpenshell, sleep } = replay([`${NAME}   Ready   1s ago`]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(runCaptureOpenshell).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a stale Ready row until compatibility recreation reaches stable Ready", () => {
    // Exact fallback-run ordering from 28817562371: after a successful
    // supervisor exec, sandbox-list first retained the old container's Ready
    // row, then published the recreated supervisor's Error -> Ready sequence.
    const { runCaptureOpenshell, sleep } = replay([
      `${NAME}   Ready   old-container`,
      `${NAME}   Error   replacement-registering`,
      `${NAME}   Ready   replacement-connected`,
      `${NAME}   Ready   replacement-stable`,
    ]);

    const ready = waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      stableReadyPolls: 2,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
