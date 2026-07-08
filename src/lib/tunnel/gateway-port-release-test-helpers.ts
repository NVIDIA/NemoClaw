// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type {
  HostGatewayProcessDeps,
  RunResult,
  StopHostGatewayOptions,
  StopHostGatewayResult,
} from "../onboard/host-gateway-process";
import type { ReleaseGatewayPortDeps } from "./gateway-port-release";

export function emptyStopResult(
  overrides: Partial<StopHostGatewayResult> = {},
): StopHostGatewayResult {
  return {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
    ...overrides,
  };
}

export function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

type StopFn = (
  depsOverrides?: Partial<HostGatewayProcessDeps>,
  options?: StopHostGatewayOptions,
) => StopHostGatewayResult;

// Build a host-gateway stopper mock that records the options it was called
// with. The explicit StopFn type keeps it assignable to the real
// (optional-param) signature, and capturing in a closure avoids fragile tuple
// indexing.
export function stopSpy(result: StopHostGatewayResult): {
  fn: StopFn;
  lastOptions: () => StopHostGatewayOptions | undefined;
} {
  let captured: StopHostGatewayOptions | undefined;
  const fn: StopFn = vi.fn(
    (_deps?: Partial<HostGatewayProcessDeps>, options?: StopHostGatewayOptions) => {
      captured = options;
      return result;
    },
  );
  return { fn, lastOptions: () => captured };
}

// A queued `lsof` responder so a test can model the port being held on the
// first probe and free on the confirmation probe.
export function lsofResponder(...responses: RunResult[]): {
  run: NonNullable<HostGatewayProcessDeps["run"]>;
  calls: number;
} {
  const state = { calls: 0 };
  const run: NonNullable<HostGatewayProcessDeps["run"]> = (command) => {
    const isLsof = command === "lsof";
    const idx = Math.min(state.calls, responses.length - 1);
    const response = isLsof ? (responses[idx] ?? ok()) : ok();
    state.calls += isLsof ? 1 : 0;
    return response;
  };
  return {
    run,
    get calls() {
      return state.calls;
    },
  };
}

// Advancing fake clock so the confirmation poll's deadline is always reached —
// a constant clock would make `waitUntil` spin forever when the port never
// frees.
function clock(step = 1): () => number {
  let t = 0;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

export function baseDeps(): ReleaseGatewayPortDeps {
  return {
    env: { HOME: "/home/tester" } as NodeJS.ProcessEnv,
    homeDir: "/home/tester",
    commandExists: () => true,
    kill: () => true,
    now: clock(),
    sleep: () => {},
    probePortFree: () => true,
    log: () => {},
    warn: () => {},
  };
}
