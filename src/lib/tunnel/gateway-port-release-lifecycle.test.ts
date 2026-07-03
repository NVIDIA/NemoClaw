// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import type { HostGatewayProcessDeps } from "../onboard/host-gateway-process";
import { releaseManagedGatewayPort } from "./gateway-port-release";
import {
  baseDeps,
  emptyStopResult,
  lsofResponder,
  ok,
  stopSpy,
} from "./gateway-port-release-test-helpers";

describe("releaseManagedGatewayPort lifecycle (#5968)", () => {
  it("stops lsof-discovered gateways, then reports the port released", () => {
    const lsof = lsofResponder(ok("111\n222\n"), ok(""));
    const stop = stopSpy(emptyStopResult({ stopped: [111, 222] }));

    const log = vi.fn();
    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968", confirmTimeoutMs: 1000 },
      {
        ...baseDeps(),
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
    expect(stopOptions?.usePidFile).toBe(false);
    expect(stopOptions?.stateDir).toBe(
      path.join("/home/tester", ".local", "state", "nemoclaw", "openshell-docker-gateway"),
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
        ...baseDeps(),
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
        ...baseDeps(),
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
        ...baseDeps(),
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

  it("does not trust a per-port pid file as proof that its process owns the port", () => {
    const lsof = lsofResponder(ok("222\n"), ok(""));
    const stop = stopSpy(emptyStopResult({ stopped: [222] }));

    releaseManagedGatewayPort(
      { sandboxName: "alpha" },
      {
        ...baseDeps(),
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: 8090 }),
      },
    );

    expect(stop.lastOptions()?.pids).toEqual([222]);
    expect(stop.lastOptions()?.usePidFile).toBe(false);
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
        ...baseDeps(),
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
    expect(result.remaining).toEqual([333]);
    expect(warn.mock.calls.map((c) => c[0]).join("\n")).toContain("sudo kill -9 333");
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
        ...baseDeps(),
        warn,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
