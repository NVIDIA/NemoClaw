// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  patchContainerRestart,
  patchGatewayProxyShutdown,
  patchHostSafeRestart,
  patchOpenClawContainerRestart,
} from "../../../scripts/lib/patch-openclaw-container-restart.mts";

const nativeRestart = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures/gateway-container-restart.js.txt"),
  "utf8",
);
const nativeSafeRestart = `async function runSafeGatewayRestart(opts, target) {
\tconst params = { target, skipDeferral: opts.skipDeferral };
\tconst result = await callGatewayCli({
\t\tmethod: "gateway.restart.request",
\t\tparams,
\t\ttimeoutMs: 1e4
\t});
\treturn result;
}`;
function restartHarness(
  options: {
    sandbox?: boolean;
    container?: boolean;
    platform?: string;
    supervisor?: string;
    disabled?: boolean;
    execve?: (...args: unknown[]) => never;
  } = {},
) {
  const execve =
    options.execve ??
    vi.fn(() => {
      throw new Error("replaced");
    });
  const processStub = {
    platform: options.platform ?? "linux",
    execPath: "/usr/bin/node",
    execArgv: ["--import", "/trusted/preload.mjs"],
    argv: ["/usr/bin/node", "/trusted/openclaw.mjs", "gateway", "run"],
    env: {
      OPENSHELL_SANDBOX: options.sandbox === false ? "0" : "1",
      OPENCLAW_NO_RESPAWN: options.disabled ? "1" : "0",
      TEST_PRIVATE_VALUE: "not-printed",
    },
    execve,
  };
  const context = vm.createContext({
    process: processStub,
    isTruthyEnvValue: (value: string) => value === "1",
    detectGatewayRespawnSupervisor: () => options.supervisor ?? null,
    isContainerEnvironment: () => options.container !== false,
  });
  const restart = vm.runInContext(
    `${patchContainerRestart(nativeRestart)}; restartGatewayProcessWithFreshPid`,
    context,
  );
  return { restart, execve, processStub };
}

describe("OpenClaw sandbox restart patch", () => {
  it.each([
    [{ OPENSHELL_SANDBOX: "1", NEMOCLAW_OPENCLAW_HOST_RESTART: "1" }, true],
    [{ OPENSHELL_SANDBOX: "1" }, false],
    [{ NEMOCLAW_OPENCLAW_HOST_RESTART: "1" }, false],
  ] as const)(
    "limits backend authentication to an explicit sandbox host restart: %j",
    async (env, hostRestart) => {
      const restart = vm.runInNewContext(
        `${patchHostSafeRestart(nativeSafeRestart)}; runSafeGatewayRestart`,
        {
          process: { env },
          callGatewayCli: async (opts: unknown) => opts,
        },
      );
      const target = { pid: 123, ownerId: "native-owner", port: 18791 };
      expect(await restart({ skipDeferral: true }, target)).toEqual({
        method: "gateway.restart.request",
        params: { target, skipDeferral: true },
        timeoutMs: 10000,
        ...(hostRestart
          ? {
              clientName: "gateway-client",
              mode: "backend",
              requireLocalBackendSharedAuth: true,
              sharedStateMode: "read-only",
            }
          : {}),
      });
    },
  );
  it("audits the host restart adaptation and rejects native drift", () => {
    const patched = patchHostSafeRestart(nativeSafeRestart);
    expect(patchHostSafeRestart(patched)).toBe(patched);
    expect(() =>
      patchHostSafeRestart(
        patched.replace(
          "requireLocalBackendSharedAuth: true",
          "requireLocalBackendSharedAuth: false",
        ),
      ),
    ).toThrow("Incomplete");
    expect(() =>
      patchHostSafeRestart(
        nativeSafeRestart.replace('"gateway.restart.request"', '"different.method"'),
      ),
    ).toThrow("Unrecognized");
    expect(() => patchHostSafeRestart(nativeSafeRestart + nativeSafeRestart)).toThrow(
      "Expected one",
    );
  });
  it.each([true, false])(
    "replaces the OpenShell process when generic container detection is %s",
    (container) => {
      const { restart, execve, processStub } = restartHarness({ container });
      expect(() => restart({ env: { RESTART_TRACE: "trace-id" } })).toThrow("replaced");
      expect(execve).toHaveBeenCalledExactlyOnceWith(processStub.execPath, processStub.argv, {
        ...processStub.env,
        RESTART_TRACE: "trace-id",
      });
    },
  );

  it.each([
    { sandbox: false },
    { sandbox: false, container: false },
    { platform: "darwin" },
    { platform: "win32" },
    { disabled: true },
  ])("preserves native in-process behavior outside the supported boundary: %j", (options) => {
    const { restart, execve } = restartHarness(options);
    expect(restart().mode).toBe("disabled");
    expect(execve).not.toHaveBeenCalled();
  });

  it.each(["systemd", "external"])("leaves %s restarts with their native owner", (supervisor) => {
    const { restart, execve } = restartHarness({ supervisor });
    expect(restart().mode).toBe("supervised");
    expect(execve).not.toHaveBeenCalled();
  });

  it("propagates replacement failure instead of reusing stale plugin state", () => {
    const { restart } = restartHarness({
      execve: () => {
        throw new Error("EACCES");
      },
    });
    expect(() => restart()).toThrow("EACCES");
  });

  it("refuses missing or ineffective process replacement", () => {
    const missing = restartHarness();
    Reflect.deleteProperty(missing.processStub, "execve");
    expect(() => missing.restart()).toThrow("requires process.execve");
    const ineffective = restartHarness();
    Object.assign(ineffective.processStub, { execve: vi.fn() });
    expect(() => ineffective.restart()).toThrow("unexpectedly returned");
  });

  it("rejects partial patches and changed native function shapes", () => {
    const patched = patchContainerRestart(nativeRestart);
    expect(patchContainerRestart(patched)).toBe(patched);
    expect(() =>
      patchContainerRestart(
        patched.replace("process.execve(process.execPath", "missing(process.execPath"),
      ),
    ).toThrow("Incomplete");
    expect(() =>
      patchContainerRestart(
        nativeRestart.replace("isContainerEnvironment()", "differentBoundary()"),
      ),
    ).toThrow("Unrecognized");
    expect(() => patchContainerRestart(nativeRestart + nativeRestart)).toThrow("Expected one");
  });

  it.each(["2026.3.11", "2026.4.24"])("leaves legacy fixture %s unchanged", (version) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-legacy-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
      const dist = path.join(root, "dist");
      expect(() => patchOpenClawContainerRestart(dist)).not.toThrow();
      expect(() => patchOpenClawContainerRestart(dist, true)).not.toThrow();
      expect(fs.readdirSync(root)).toEqual(["package.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits the pinned installed package and rejects version drift before writing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-patch-"));
    try {
      const dist = path.join(root, "dist");
      fs.mkdirSync(path.join(dist, "cli"), { recursive: true });
      const target = path.join(dist, "cli/gateway-lifecycle.runtime.js");
      fs.writeFileSync(target, nativeRestart);
      fs.writeFileSync(path.join(dist, "lifecycle-fixture.js"), nativeSafeRestart);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "unknown" }));
      expect(() => patchOpenClawContainerRestart(dist)).toThrow("Unsupported");
      expect(fs.readFileSync(target, "utf8")).toBe(nativeRestart);
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
      expect(() => patchOpenClawContainerRestart(dist, true)).toThrow("missing");
      patchOpenClawContainerRestart(dist);
      expect(() => patchOpenClawContainerRestart(dist, true)).not.toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe(patchContainerRestart(nativeRestart));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "reloads changed ESM dependencies without replaying one-shot Node bootstrap arguments",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-esm-"));
      try {
        const preloadMarker = path.join(root, "preload-used");
        const oneShotPreload = path.join(root, "one-shot-preload.cjs");
        fs.writeFileSync(
          oneShotPreload,
          `const fs = require("node:fs");
const marker = ${JSON.stringify(preloadMarker)};
if (fs.existsSync(marker)) process.exit(97);
fs.writeFileSync(marker, "used");
`,
        );
        fs.writeFileSync(path.join(root, "version.mjs"), 'export const version = "v1";');
        fs.writeFileSync(path.join(root, "plugin.mjs"), 'export { version } from "./version.mjs";');
        const child = path.join(root, "gateway.mjs");
        fs.writeFileSync(
          child,
          `
import fs from "node:fs";
import vm from "node:vm";
const {version} = await import("./plugin.mjs");
console.log(JSON.stringify({version, pid: process.pid}));
if (process.env.RESTARTED !== "1") {
  fs.writeFileSync(new URL("./version.mjs", import.meta.url), 'export const version = "v2";');
  const processView = {platform: "linux", env: {...process.env, OPENSHELL_SANDBOX: "1"}, execPath: process.execPath, execArgv: process.execArgv, argv: process.argv, execve: process.execve.bind(process)};
  const context = vm.createContext({process: processView, isTruthyEnvValue: value => value === "1", detectGatewayRespawnSupervisor: () => null, isContainerEnvironment: () => false});
  const restart = vm.runInContext(${JSON.stringify(patchContainerRestart(nativeRestart) + "; restartGatewayProcessWithFreshPid")}, context);
  restart({env: {RESTARTED: "1"}});
}
`,
        );
        const result = spawnSync(process.execPath, ["--require", oneShotPreload, child], {
          encoding: "utf8",
          env: { PATH: process.env.PATH },
          timeout: 30_000,
        });
        expect(result.status, result.stderr).toBe(0);
        const observations = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(observations).toEqual([
          { version: "v1", pid: expect.any(Number) },
          { version: "v2", pid: observations[0].pid },
        ]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

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
