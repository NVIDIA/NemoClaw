// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach } from "vitest";
import { BROKER_SESSION_PROBE_SOURCE } from "../../../../scripts/lib/openclaw-broker-session-probe.mts";
import {
  OPENCLAW_BROKER_CLEANUP_MODULES,
  patchBrokerPrivateSessionCleanup,
} from "../../../../scripts/lib/patch-openclaw-container-restart.mts";
import {
  OPENCLAW_COMMAND_SESSION_MODULES,
  OPENCLAW_COMMAND_TERMINATION_MODULES,
} from "../../../../scripts/lib/openclaw-command-session-cleanup.mts";

export const nativeCleanup = fs.readFileSync(
  new URL("../fixtures/gateway-broker-private-session-10.5.js.txt", import.meta.url),
  "utf8",
);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function procStat(pid: number, session: number, name = "worker"): string {
  return `${pid} (${name}) S 1 ${session} ${session} ${"0 ".repeat(17)}\n`;
}

export function harness(
  options: {
    secondForkCount?: string;
    namespace?: string;
    filesystemType?: number;
    mountOptions?: string;
    now?: () => number;
    open?: (file: string) => void;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-broker-proc-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "stat"), "processes 41\n");
  fs.mkdirSync(path.join(root, "self"));
  fs.writeFileSync(path.join(root, "self/status"), options.namespace ?? "NSpid:\t42\n");
  fs.writeFileSync(
    path.join(root, "self/mountinfo"),
    `1 0 0:1 / /proc rw - proc proc rw,${options.mountOptions ?? "hidepid=0"}\n`,
  );
  const addProcess = (pid: number, session: number, name?: string) => {
    fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(root, String(pid), "stat"), procStat(pid, session, name));
  };
  addProcess(42, 42);
  let forkReads = 0;
  let signals = 0;
  const redirect = (file: fs.PathLike): string => {
    if (typeof file !== "string" || !file.startsWith("/proc"))
      throw new Error("Unexpected probe path");
    return path.join(root, file.slice("/proc".length));
  };
  const probeFs = {
    ...fs,
    openSync(file: fs.PathLike, flags: number): number {
      const target = redirect(file);
      options.open?.(String(file));
      if (file === "/proc/stat" && ++forkReads === 2 && options.secondForkCount !== undefined)
        fs.writeFileSync(target, options.secondForkCount);
      return fs.openSync(target, flags);
    },
    opendirSync(file: fs.PathLike): fs.Dir {
      return fs.opendirSync(redirect(file));
    },
    statfsSync(file: fs.PathLike) {
      if (file !== "/proc") throw new Error("Unexpected filesystem path");
      return { type: options.filesystemType ?? 0x9fa0 };
    },
  };
  const globals = {
    Buffer,
    performance: { now: options.now ?? (() => 0) },
    process: {
      pid: 42,
      platform: "linux",
      env: { OPENSHELL_SANDBOX: "1" },
      getBuiltinModule(name: string) {
        if (name !== "node:fs") throw new Error("Unexpected builtin module");
        return probeFs;
      },
      kill() {
        signals++;
        throw new Error("A session probe must not send signals");
      },
    },
  };
  const probe = vm.runInNewContext(
    `${BROKER_SESSION_PROBE_SOURCE}; nemoclawPrivateBrokerSessionGone`,
    globals,
  ) as (sessionId: number) => boolean;
  return { root, probe, addProcess, globals, signals: () => signals };
}

export function nativeCleanupHarness(options: Parameters<typeof harness>[0] = {}) {
  const subject = harness(options);
  let clock = 0;
  let timer: (() => void) | undefined;
  let timerAt = 0;
  const signals: Array<[number, string]> = [];
  const terminations: Array<{ pid: number; detached: boolean; graceMs: number }> = [];
  let forced = 0;
  const environment = {
    ...subject.globals,
    Date: { now: () => clock },
    GRACEFUL_CANCEL_TIMEOUT_MS: 5000,
    SpawnBrokerError: Error,
    isPidDefinitelyDead: (): boolean => true,
    killProcessTree(pid: number, options: { detached: boolean; graceMs: number }) {
      terminations.push({ pid, ...options });
      return {
        force: () => {
          forced++;
        },
      };
    },
    extractErrorCode: (error: { code?: string }) => error.code,
    groupGone: (): boolean => {
      throw new Error("Unexpected native group probe");
    },
    process: {
      ...subject.globals.process,
      kill(pid: number, signal: string) {
        signals.push([pid, signal]);
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    },
    setTimeout(callback: () => void, delay: number) {
      timer = callback;
      timerAt = clock + delay;
      return 1;
    },
    clearTimeout() {
      timer = undefined;
    },
    async setTimeout$1(delay: number) {
      clock += delay;
      if (timer && clock >= timerAt) {
        const callback = timer;
        timer = undefined;
        callback();
      }
    },
  };
  const cleanup = () =>
    vm.runInNewContext(
      patchBrokerPrivateSessionCleanup(nativeCleanup) + "; terminateBrokerProcessGroup(200)",
      environment,
    ) as { settled: Promise<void>; force: () => void };
  const lostCleanup = (detached: boolean) =>
    vm.runInNewContext(
      patchBrokerPrivateSessionCleanup(nativeCleanup) +
        `; terminateLostBrokerChild(200, ${detached})`,
      environment,
    ) as { settled: Promise<void>; force: () => void };
  return {
    ...subject,
    environment,
    cleanup,
    lostCleanup,
    terminations,
    forced: () => forced,
    signals,
    elapsed: () => clock,
  };
}

/** Populate the shared pinned native cleanup layout used by patch materialization tests. */
export function seedBrokerCleanupModules(dist: string, version = "2026.10.5"): void {
  if (version !== "2026.10.5") return;
  const copy = (name: string) => {
    const target = path.join(dist, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(
      new URL("../fixtures/gateway-broker-private-session-10.5.js.txt", import.meta.url),
      target,
    );
  };
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[0]);
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[1]);
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[2]);
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[3]);
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[4]);
  copy(OPENCLAW_BROKER_CLEANUP_MODULES[5]);
  const commands = fs.readFileSync(
    new URL("../fixtures/scoped-command-cleanup-10.5.js.txt", import.meta.url),
    "utf8",
  );
  for (const name of OPENCLAW_COMMAND_SESSION_MODULES) {
    const target = path.join(dist, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, commands);
  }
  const termination = fs.readFileSync(
    new URL("../fixtures/command-termination-10.5.js.txt", import.meta.url),
    "utf8",
  );
  for (const name of OPENCLAW_COMMAND_TERMINATION_MODULES) {
    const target = path.join(dist, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, termination);
  }
  fs.copyFileSync(
    new URL("../fixtures/settings-command-10.5.js.txt", import.meta.url),
    path.join(dist, "settings-manager-CKysicKB.mjs"),
  );
}

export function denyProcfsRead(expected: string): (file: string) => void {
  return (file) => {
    if (file === expected) throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
}
