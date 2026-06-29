// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import type {
  HostGatewayProcessDeps,
  RunResult,
  StopHostGatewayOptions,
  StopHostGatewayResult,
} from "../onboard/host-gateway-process";
import { releaseManagedGatewayPort, resolveStopGatewayPort } from "./gateway-port-release";

function emptyStopResult(overrides: Partial<StopHostGatewayResult> = {}): StopHostGatewayResult {
  return {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
    ...overrides,
  };
}

function ok(stdout = ""): RunResult {
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
function stopSpy(result: StopHostGatewayResult): {
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
function lsofResponder(...responses: RunResult[]): {
  run: NonNullable<HostGatewayProcessDeps["run"]>;
  calls: number;
} {
  const state = { calls: 0 };
  const run: NonNullable<HostGatewayProcessDeps["run"]> = (command) => {
    if (command !== "lsof") return ok();
    const idx = Math.min(state.calls, responses.length - 1);
    state.calls += 1;
    return responses[idx] ?? ok();
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

const baseDeps = {
  env: { HOME: "/home/tester" } as NodeJS.ProcessEnv,
  homeDir: "/home/tester",
  commandExists: () => true,
  kill: () => true,
  now: clock(),
  sleep: () => {},
  log: () => {},
  warn: () => {},
};

describe("resolveStopGatewayPort (#5968)", () => {
  it("prefers an explicit port override", () => {
    expect(resolveStopGatewayPort({ port: 9090 }, () => null)).toBe(9090);
  });

  it("derives the port from the sandbox's persisted gateway binding", () => {
    const port = resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({ gatewayPort: 8090 }));
    expect(port).toBe(8090);
  });

  it("falls back to the default gateway port when no binding is found", () => {
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => null)).toBe(DEFAULT_GATEWAY_PORT);
  });
});

describe("releaseManagedGatewayPort (#5968)", () => {
  it("stops the recorded gateway and lsof-discovered duplicate, then reports the port released", () => {
    const lsof = lsofResponder(ok("111\n222\n"), ok(""));
    const stop = stopSpy(emptyStopResult({ stopped: [111, 222] }));

    const log = vi.fn();
    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968", confirmTimeoutMs: 1000 },
      {
        ...baseDeps,
        log,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: DEFAULT_GATEWAY_PORT }),
      },
    );

    expect(result.released).toBe(true);
    expect(result.port).toBe(DEFAULT_GATEWAY_PORT);
    expect(result.stopped).toEqual([111, 222]);

    expect(stop.fn).toHaveBeenCalledTimes(1);
    const stopOptions = stop.lastOptions();
    expect(stopOptions?.pids).toEqual([111, 222]);
    expect(stopOptions?.usePgrepFallback).toBe(false);
    expect(stopOptions?.pidFile).toBe(
      path.join(
        "/home/tester",
        ".local",
        "state",
        "nemoclaw",
        "openshell-docker-gateway",
        "openshell-gateway.pid",
      ),
    );
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain(
      `Released NemoClaw gateway port ${DEFAULT_GATEWAY_PORT}`,
    );
  });

  it("targets the per-port state dir for a non-default gateway port", () => {
    const lsof = lsofResponder(ok(""));
    const stop = stopSpy(emptyStopResult());

    releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: 8090 }),
      },
    );

    expect(stop.lastOptions()?.stateDir).toBe(
      path.join("/home/tester", ".local", "state", "nemoclaw", "openshell-docker-gateway-8090"),
    );
  });

  it("is a quiet no-op when nothing is bound to the gateway port", () => {
    const lsof = lsofResponder(ok(""));
    const stop = stopSpy(emptyStopResult());
    const log = vi.fn();
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      {},
      {
        ...baseDeps,
        log,
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with sudo remediation when the port stays bound after stop", () => {
    // lsof keeps reporting a listener even after the stop attempt — the orphan
    // could not be reaped (e.g. a privileged process).
    const lsof = lsofResponder(ok("333\n"));
    const stop = stopSpy(emptyStopResult({ failed: [333] }));
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      { confirmTimeoutMs: 10 },
      {
        ...baseDeps,
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
    expect(result.remaining).toEqual([333]);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "sudo pkill -f openshell-gateway",
    );
  });

  it("skips the lsof sweep but still delegates to the pid-file stopper when lsof is absent", () => {
    const stop = stopSpy(emptyStopResult());
    const run = vi.fn(() => ok());

    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps,
        commandExists: () => false,
        run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: DEFAULT_GATEWAY_PORT }),
      },
    );

    expect(result.scanned).toBe(false);
    expect(result.released).toBe(true);
    expect(stop.lastOptions()?.pids).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
