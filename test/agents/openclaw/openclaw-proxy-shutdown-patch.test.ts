// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  patchGatewayProxyShutdown,
  patchOpenClawContainerRestart,
} from "../../../scripts/lib/patch-openclaw-container-restart.mts";

// Exact signal installer from the pinned OpenClaw 2026.9.5 CLI runtime.
const nativeSignals = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures/gateway-proxy-signal-handlers.js.txt"),
  "utf8",
);

function signalHarness(gateway: boolean, proxy = true) {
  const events = new EventEmitter();
  const exit = vi.fn((code: number) => events.emit("exit", code));
  const processView = Object.assign(events, { exit });
  const stopProxy = vi.fn(async () => {});
  const killProxy = vi.fn();
  const barriers: (() => Promise<void>)[] = [];
  let draining: Promise<void> | undefined;
  const context = vm.createContext({
    process$1: processView,
    isGatewayRunInvocation: gateway,
    proxyHandle: proxy ? {} : null,
    onSigterm: null,
    onSigint: null,
    onExit: null,
    unregisterProxySignalExitBarrier: null,
    registerSignalExitBarrier: (barrier: () => Promise<void>) => {
      barriers.push(barrier);
      return () => {};
    },
    stopStartedProxy: stopProxy,
    killStartedProxy: killProxy,
    waitForSignalExitBarriers: () => {
      draining = Promise.all(barriers.map((barrier) => barrier())).then(() => {});
      return draining;
    },
  });
  const install = vm.runInContext(
    `${patchGatewayProxyShutdown(nativeSignals)}; installProxySignalHandlers`,
    context,
  ) as () => void;
  return { events, exit, stopProxy, killProxy, barriers, install, drain: () => draining };
}

describe("OpenClaw gateway proxy shutdown ownership", () => {
  it.each(["SIGTERM", "SIGINT"])(
    "lets the gateway release its lease before proxy cleanup on %s",
    async (signal) => {
      const runtime = signalHarness(true);
      let finishServerClose!: () => void;
      const serverClosed = new Promise<void>((resolve) => {
        finishServerClose = resolve;
      });
      let leaseReleased = false;
      const stopped = serverClosed.then(() => {
        leaseReleased = true;
        runtime.exit(0);
      });
      runtime.events.on(signal, () => {});
      runtime.killProxy.mockImplementation(() => expect(leaseReleased).toBe(true));
      runtime.install();
      runtime.install();

      runtime.events.emit(signal);
      await Promise.resolve();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.stopProxy).not.toHaveBeenCalled();
      expect(runtime.killProxy).not.toHaveBeenCalled();
      expect(runtime.events.listenerCount(signal)).toBe(1);
      expect(runtime.barriers).toHaveLength(1);
      finishServerClose();
      await stopped;
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(runtime.killProxy).toHaveBeenCalledTimes(1);
      expect(runtime.events.listenerCount("exit")).toBe(0);
    },
  );

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("retains ordinary CLI cleanup and exit status for %s", async (signal, code) => {
    const runtime = signalHarness(false);
    runtime.install();
    runtime.install();
    runtime.events.emit(signal);
    await runtime.drain();
    expect(runtime.stopProxy).toHaveBeenCalledTimes(1);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(code);
    expect(runtime.killProxy).toHaveBeenCalledTimes(1);
    expect(runtime.barriers).toHaveLength(1);
  });

  it("does not register shutdown work when there is no proxy", () => {
    const runtime = signalHarness(true, false);
    runtime.install();
    expect(runtime.barriers).toHaveLength(0);
    expect(runtime.events.eventNames()).toEqual([]);
  });

  it("rejects native drift and incomplete or duplicated patches", () => {
    const patched = patchGatewayProxyShutdown(nativeSignals);
    expect(patchGatewayProxyShutdown(patched)).toBe(patched);
    expect(() => patchGatewayProxyShutdown(nativeSignals + nativeSignals)).toThrow("Expected one");
    expect(() =>
      patchGatewayProxyShutdown(nativeSignals.replace("stopStartedProxy);", "otherCleanup);")),
    ).toThrow("Unrecognized");
    expect(() =>
      patchGatewayProxyShutdown(patched.replace("if (isGatewayRunInvocation)", "if (false)")),
    ).toThrow("Incomplete");
  });

  it("patches and audits the installed 9.5 package without partial writes on drift", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-shutdown-"));
    try {
      const dist = path.join(root, "dist");
      fs.mkdirSync(path.join(dist, "cli"), { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.5" }));
      const restart = fs.readFileSync(
        path.join(import.meta.dirname, "fixtures/gateway-container-restart.js.txt"),
        "utf8",
      );
      const restartPath = path.join(dist, "cli/gateway-lifecycle.runtime.js");
      fs.writeFileSync(restartPath, restart);
      fs.writeFileSync(
        path.join(dist, "lifecycle-fixture.mjs"),
        'async function runSafeGatewayRestart(opts) {\n\tconst result = await callGatewayCli({\n\t\tmethod: "gateway.restart.request",\n\t\tparams,\n\t});\n}',
      );
      const signalsPath = path.join(dist, "cli/run-main.js");
      fs.writeFileSync(signalsPath, "native drift");
      expect(() => patchOpenClawContainerRestart(dist)).toThrow("Expected one");
      expect(fs.readFileSync(restartPath, "utf8")).toBe(restart);
      fs.writeFileSync(signalsPath, nativeSignals);
      expect(() => patchOpenClawContainerRestart(dist, true)).toThrow("missing");
      patchOpenClawContainerRestart(dist);
      expect(() => patchOpenClawContainerRestart(dist, true)).not.toThrow();
      expect(fs.readFileSync(signalsPath, "utf8")).toBe(patchGatewayProxyShutdown(nativeSignals));
      fs.writeFileSync(signalsPath, nativeSignals);
      expect(() => patchOpenClawContainerRestart(dist, true)).toThrow("missing");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
