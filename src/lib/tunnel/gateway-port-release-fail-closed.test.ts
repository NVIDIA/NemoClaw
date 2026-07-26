// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

describe("releaseManagedGatewayPort fail-closed behavior (#5968)", () => {
  it("does not fall back to the default port when the persisted gateway binding is invalid", () => {
    // Source-of-truth guard: a corrupt registry entry must NOT cause
    // default-port cleanup or any stopHostGatewayProcesses invocation.
    const lsof = lsofResponder(ok("999\n"));
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();

    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps(),
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
        ...baseDeps(),
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
    // The default warning stays concise; NODE_DEBUG adds the underlying cause.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = stopSpy(emptyStopResult());

    releaseManagedGatewayPort(
      { sandboxName: "alpha" },
      {
        ...baseDeps(),
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
        ...baseDeps(),
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
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Registry lookup failed for sandbox",
    );
  });

  it("warns and refuses unsafe pid-file cleanup when lsof exits with a real failure", () => {
    // lsof status > 1 is a genuine error (not "no listeners"); surface it and
    // do not treat unverified PID-file contents as signal-safe candidates.
    const stop = stopSpy(emptyStopResult());
    const warn = vi.fn();
    const run: NonNullable<HostGatewayProcessDeps["run"]> = (command) =>
      command === "lsof" ? { status: 2, stdout: "", stderr: "lsof: boom" } : ok();

    const result = releaseManagedGatewayPort(
      {},
      {
        ...baseDeps(),
        warn,
        run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.scanned).toBe(false);
    // A genuine lsof error (vs lsof simply being absent) means we confirmed
    // nothing, so the port must not be reported as released (#5968): this is what
    // lets stopAll surface its unconfirmed-release warning.
    expect(result.released).toBe(false);
    expect(stop.lastOptions()?.pids).toEqual([]);
    expect(stop.lastOptions()?.usePidFile).toBe(false);
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
        ...baseDeps(),
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
  });

  it("skips unsafe pid-file cleanup and relies on the bind proof when lsof is absent", () => {
    const stop = stopSpy(emptyStopResult());
    const run = vi.fn(() => ok());
    const probePortFree = vi.fn(() => true);

    const result = releaseManagedGatewayPort(
      { sandboxName: "nemoclaw-5968" },
      {
        ...baseDeps(),
        commandExists: () => false,
        probePortFree,
        run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => ({ gatewayPort: DEFAULT_GATEWAY_PORT }),
      },
    );

    expect(result.scanned).toBe(false);
    expect(result.released).toBe(true);
    expect(stop.lastOptions()?.pids).toEqual([]);
    expect(stop.lastOptions()?.usePidFile).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(probePortFree).toHaveBeenCalledWith(DEFAULT_GATEWAY_PORT);
  });

  it("does not report release without lsof when an unrecorded listener still owns the port", () => {
    const stop = stopSpy(emptyStopResult({ stopped: [111] }));
    const log = vi.fn();

    const result = releaseManagedGatewayPort(
      { confirmTimeoutMs: 10 },
      {
        ...baseDeps(),
        commandExists: () => false,
        probePortFree: () => false,
        log,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.scanned).toBe(false);
    expect(result.released).toBe(false);
    expect(result.stopped).toEqual([111]);
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining(`Released NemoClaw gateway port ${DEFAULT_GATEWAY_PORT}`),
    );
  });

  it("runs one bind proof for one managed gateway release", () => {
    let clock = 0;
    const probePortFree = vi.fn(() => false);

    const result = releaseManagedGatewayPort(
      { confirmTimeoutMs: 100_000, confirmPollIntervalMs: 1 },
      {
        ...baseDeps(),
        commandExists: () => false,
        now: () => clock++,
        probePortFree,
        stopHostGatewayProcesses: stopSpy(emptyStopResult()).fn,
      },
    );

    expect(result.released).toBe(false);
    expect(probePortFree).toHaveBeenCalledTimes(1);
  });

  it("does not trust empty lsof output when a hidden listener prevents rebinding", () => {
    const stop = stopSpy(emptyStopResult());
    const probePortFree = vi.fn(() => false);
    const lsof = lsofResponder({ status: 1, stdout: "", stderr: "" });

    const result = releaseManagedGatewayPort(
      { confirmTimeoutMs: 10 },
      {
        ...baseDeps(),
        probePortFree,
        run: lsof.run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.scanned).toBe(true);
    expect(result.released).toBe(false);
    expect(probePortFree).toHaveBeenCalledWith(DEFAULT_GATEWAY_PORT);
  });

  it("never reports release when a matched gateway could not be stopped", () => {
    const stop = stopSpy(emptyStopResult({ failed: [777] }));
    const probePortFree = vi.fn(() => true);

    const result = releaseManagedGatewayPort(
      {},
      {
        ...baseDeps(),
        probePortFree,
        run: lsofResponder({ status: 1, stdout: "", stderr: "" }).run,
        stopHostGatewayProcesses: stop.fn,
        getSandbox: () => null,
      },
    );

    expect(result.released).toBe(false);
    expect(result.remaining).toEqual([777]);
    expect(probePortFree).not.toHaveBeenCalled();
  });
});
