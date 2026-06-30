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

  it("fails closed (null) for an explicit but invalid port override", () => {
    // An out-of-range override must not silently fall through to the sandbox
    // binding or the default port — it is a caller error, so skip.
    expect(resolveStopGatewayPort({ port: 70000 }, () => ({ gatewayPort: 8090 }))).toBe(null);
    expect(resolveStopGatewayPort({ port: 0, sandboxName: "alpha" }, () => null)).toBe(null);
  });

  it("derives the port from the sandbox's persisted gateway binding", () => {
    const port = resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({ gatewayPort: 8090 }));
    expect(port).toBe(8090);
  });

  it("fails closed (null) when a named sandbox has no registry entry", () => {
    // A named stop whose registry entry is absent must not fall back to
    // default-port cleanup: an unknown name could otherwise tear down a
    // different sandbox's / worktree's default gateway.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => null)).toBe(null);
  });

  it("falls back to the default gateway port for a call with no sandbox name", () => {
    // A direct "release the default gateway" request (no sandbox identity).
    expect(resolveStopGatewayPort({}, () => null)).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("falls back to the default gateway port for a legacy entry with no gateway fields", () => {
    // A real legacy entry (e.g. `{}`) maps to the base `nemoclaw` name and
    // resolves to the default port, keeping single-sandbox deployments working.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({}))).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("fails closed (null) when the persisted gateway binding is invalid", () => {
    // An out-of-range gatewayPort is a corrupt/tampered binding;
    // resolveSandboxGatewayName throws and we must not coerce to the default.
    expect(resolveStopGatewayPort({ sandboxName: "alpha" }, () => ({ gatewayPort: 70000 }))).toBe(
      null,
    );
  });

  it("fails closed (null) when the registry lookup itself throws", () => {
    // A corrupt registry that throws on read must not be treated as a clean
    // "no entry" and fall back to the default port.
    const port = resolveStopGatewayPort({ sandboxName: "alpha" }, () => {
      throw new Error("corrupt registry");
    });
    expect(port).toBe(null);
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

  it("scopes the sweep to the sandbox's own gateway port so another worktree's gateway is untouched", () => {
    // Cross-worktree isolation: a stop for sandbox A (port 8090) must only ever
    // probe :8090 and target the 8090 state dir, and must never run a host-wide
    // pgrep sweep — so sandbox B's gateway on a different port is never reaped.
    const calls: string[][] = [];
    const run: NonNullable<HostGatewayProcessDeps["run"]> = (command, args) => {
      calls.push([command, ...args]);
      return ok("8190\n");
    };
    const stop = stopSpy(emptyStopResult({ stopped: [8190] }));

    releaseManagedGatewayPort(
      { sandboxName: "alpha", confirmTimeoutMs: 5 },
      {
        ...baseDeps,
        run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: 8090 }),
      },
    );

    const lsofCalls = calls.filter((c) => c[0] === "lsof");
    expect(lsofCalls.length).toBeGreaterThan(0);
    expect(lsofCalls.every((c) => c.includes(":8090"))).toBe(true);
    expect(lsofCalls.some((c) => c.includes(":8091"))).toBe(false);
    expect(stop.lastOptions()?.usePgrepFallback).toBe(false);
    expect(stop.lastOptions()?.stateDir).toContain("openshell-docker-gateway-8090");
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

  it("does not fall back to the default port when the persisted gateway binding is invalid", () => {
    // Source-of-truth guard: a corrupt registry entry must NOT cause
    // default-port cleanup or any stopHostGatewayProcesses invocation.
    const lsof = lsofResponder(ok("999\n"));
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps,
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: 0 }),
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.released).toBe(false);
    expect(result.port).toBe(null);
    expect(stop.lastOptions()).toBeUndefined();
    expect(lsof.calls).toBe(0);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "no valid gateway binding is registered",
    );
  });

  it("skips default-port cleanup for a named sandbox whose registry entry is absent", () => {
    // A named stop with no registry entry must not scan or signal the
    // process-wide default gateway, which could belong to another worktree.
    const lsof = lsofResponder(ok("777\n"));
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      { sandboxName: "no-such-sandbox" },
      {
        ...baseDeps,
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.released).toBe(false);
    expect(result.port).toBe(null);
    expect(stop.lastOptions()).toBeUndefined();
    expect(lsof.calls).toBe(0);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "no valid gateway binding is registered",
    );
  });

  it("emits a NODE_DEBUG=nemoclaw:gateway diagnostic when the fail-closed path is taken", () => {
    // The skip is silent by default; opting into NODE_DEBUG surfaces *why*.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = stopSpy(emptyStopResult());

    releaseManagedGatewayPort(
      { sandboxName: "alpha" },
      {
        ...baseDeps,
        env: { HOME: "/home/tester", NODE_DEBUG: "nemoclaw:gateway" } as NodeJS.ProcessEnv,
        run: lsofResponder(ok("999\n")).run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => {
          throw new Error("corrupt registry");
        },
      },
    );

    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "[nemoclaw:gateway] registry lookup for sandbox",
    );
    errorSpy.mockRestore();
  });

  it("skips the destructive path when the registry lookup throws", () => {
    const lsof = lsofResponder(ok("888\n"));
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps,
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => {
          throw new Error("corrupt registry");
        },
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.released).toBe(false);
    expect(stop.lastOptions()).toBeUndefined();
    expect(lsof.calls).toBe(0);
  });

  it("leaves a non-matching listener alone without sudo pkill remediation", () => {
    // lsof reports a PID the stopper classifies as non-matching (e.g. a
    // Docker-published port held by docker-proxy). No matched gateway failed,
    // so no scary remediation hint.
    const lsof = lsofResponder(ok("444\n"), ok("444\n"));
    const stop = stopSpy(emptyStopResult({ skippedNonMatchingPids: [444] }));
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
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to pid-file cleanup when lsof exits with a real failure", () => {
    // lsof status > 1 is a genuine error (not "no listeners"); surface it and
    // skip the lsof sweep, but still delegate to the pid-file stopper.
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();
    const run: NonNullable<HostGatewayProcessDeps["run"]> = (command) =>
      command === "lsof" ? { status: 2, stdout: "", stderr: "lsof: boom" } : ok();

    const result = releaseManagedGatewayPort(
      {},
      {
        ...baseDeps,
        warn,
        run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.scanned).toBe(false);
    expect(stop.lastOptions()?.pids).toEqual([]);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("lsof failed while scanning");
  });

  it("does not report released when the confirmation probe itself fails", () => {
    // Port is bound on the initial scan (so the stop path runs), but lsof
    // errors on every confirmation probe. A failed probe is not proof the port
    // is free, so released must stay false rather than coercing null -> [].
    const lsof = lsofResponder(ok("555\n"), { status: 2, stdout: "", stderr: "boom" });
    const stop = stopSpy(emptyStopResult({ stopped: [555] }));

    const result = releaseManagedGatewayPort(
      { confirmTimeoutMs: 10 },
      {
        ...baseDeps,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
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
