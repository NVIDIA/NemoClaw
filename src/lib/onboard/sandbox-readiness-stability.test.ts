// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  namedOpenShellGateway,
  type OpenShellSandboxObserver,
  type OpenShellSandboxReadiness,
} from "../adapters/openshell/sandbox-observer";
import { waitForCreatedSandboxReadyWithTrace } from "./sandbox-readiness-tracing";

const NAME = "my-sandbox";
const TARGET = namedOpenShellGateway("nemoclaw");
const READY_PHASES = new Set(["Ready", "Running"]);
const TERMINAL_PHASES = new Set(["Error", "Failed", "CrashLoopBackOff"]);

function readinessForPhase(phase: string): OpenShellSandboxReadiness {
  return READY_PHASES.has(phase)
    ? "ready"
    : TERMINAL_PHASES.has(phase)
      ? "terminal"
      : "not_ready";
}

function replay(phases: readonly string[]) {
  let index = 0;
  const listSandboxes = vi.fn<OpenShellSandboxObserver["listSandboxes"]>(async () => {
    const phase = phases[Math.min(index++, phases.length - 1)] ?? "Provisioning";
    return {
      ok: true,
      value: { sandboxes: [{ name: NAME, phase, readiness: readinessForPhase(phase) }] },
    };
  });
  return { observer: { listSandboxes }, listSandboxes, sleep: vi.fn() };
}

describe("created sandbox Ready stability", () => {
  it("preserves single-poll Ready acceptance by default", async () => {
    const { observer, listSandboxes, sleep } = replay(["Ready"]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a stale Ready row until compatibility recreation reaches stable Ready", async () => {
    // Exact fallback-run ordering from 28817562371: after a successful
    // supervisor exec, sandbox-list first retained the old container's Ready
    // row, then published the recreated supervisor's Error -> Ready sequence.
    const { observer, listSandboxes, sleep } = replay(["Ready", "Error", "Ready", "Ready"]);

    const ready = await waitForCreatedSandboxReadyWithTrace({
      sandboxName: NAME,
      timeoutSecs: 600,
      observer,
      target: TARGET,
      stableReadyPolls: 2,
      sleep,
    });

    expect(ready).toEqual({ ready: true, reason: "ready", failurePhase: null });
    expect(listSandboxes).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2);
  });
});
