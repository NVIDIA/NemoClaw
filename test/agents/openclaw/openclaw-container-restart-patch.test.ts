// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

import {
  patchContainerRestart,
  patchOpenClawContainerRestart,
} from "../../../scripts/lib/patch-openclaw-container-restart.mts";

const nativeRestart = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures/gateway-container-restart.js.txt"),
  "utf8",
);
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
