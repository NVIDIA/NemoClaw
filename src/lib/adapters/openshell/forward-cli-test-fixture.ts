// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";

import type { OpenShellForwardIdentity } from "./forward";
import { createCliOpenShellForwardAdapter } from "./forward-cli";

export const forward: OpenShellForwardIdentity = {
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "demo",
  localHost: "127.0.0.1",
  port: 18_789,
};

export const otherForward: OpenShellForwardIdentity = {
  ...forward,
  sandboxName: "other",
  port: 19_999,
};

export const executable = "/usr/local/bin/openshell";
export const listHeader = "SANDBOX BIND PORT PID STATUS";
export const noActiveForwards = "No active forwards.";
export const legacyForwardList = [listHeader, "demo     127.0.0.1  18789  4312  running"].join(
  "\n",
);

export const errors = {
  authority: {
    kind: "authority",
    message: "NemoClaw could not prove current OpenShell forward authority.",
  },
  authentication: {
    kind: "authentication",
    message: "OpenShell authentication failed.",
  },
  cleanup: {
    kind: "cleanup",
    message: "NemoClaw could not prove OpenShell forward cleanup.",
  },
  command: {
    kind: "command",
    message: "The OpenShell forward command failed.",
  },
  ownership: {
    kind: "ownership",
    message: "NemoClaw could not prove OpenShell forward ownership.",
  },
  schema: {
    kind: "schema",
    message: "OpenShell returned an invalid forward response.",
  },
  timeout: {
    kind: "timeout",
    message: "The OpenShell forward operation timed out.",
  },
  transport: {
    kind: "transport",
    message: "The OpenShell forward transport failed.",
  },
  validation: {
    kind: "validation",
    message: "The OpenShell forward request is invalid.",
  },
} as const;

export type CapturedCommand = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}>;

type AdapterDeps = Parameters<typeof createCliOpenShellForwardAdapter>[0];
export type RunCommand = NonNullable<AdapterDeps["run"]>;
export type HostProbe = NonNullable<AdapterDeps["hostProbe"]>;
export type InspectListener = NonNullable<AdapterDeps["inspect"]>;
export type InspectLegacyListener = NonNullable<AdapterDeps["inspectLegacy"]>;
export type ProbePort = NonNullable<AdapterDeps["probePort"]>;
export type SignalProcess = NonNullable<AdapterDeps["signalProcess"]>;
export type SpawnForward = NonNullable<AdapterDeps["spawn"]>;
export type ForwardChild = ReturnType<SpawnForward>;
export type TerminateForward = NonNullable<AdapterDeps["terminate"]>;

type HarnessOverrides = Readonly<{
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  hostProbe?: HostProbe;
  inspect?: InspectListener;
  inspectLegacy?: InspectLegacyListener;
  now?: () => number;
  platform?: NodeJS.Platform;
  procRoot?: string;
  procWorkLimit?: number;
  probePort?: ProbePort;
  run?: RunCommand;
  sleep?: (milliseconds: number) => Promise<void>;
  spawn?: SpawnForward;
  terminate?: TerminateForward;
}>;

export function captured(
  status: number | null,
  stdout = "",
  stderr = "",
  details: Omit<CapturedCommand, "status" | "stdout" | "stderr"> = {},
): CapturedCommand {
  return { status, stdout, stderr, ...details };
}

export function capturedForwardList(output: string): CapturedCommand {
  return output === noActiveForwards ? captured(0, "", output) : captured(0, output);
}

export function missingCommand(): CapturedCommand {
  return captured(null, "", "", {
    error: Object.assign(new Error("command unavailable"), { code: "ENOENT" }),
  });
}

const linuxTcpHeader = [
  "sl",
  "local_address",
  "rem_address",
  "st",
  "tx_queue",
  "rx_queue",
  "tr",
  "tm->when",
  "retrnsmt",
  "uid",
  "timeout",
  "inode",
].join(" ");
const linuxTcpListener =
  "0: 0100007F:4965 00000000:0000 0A 00000000:00000000 00:00000000 " + "00000000 1000 0 424242";

type LinuxProcFixture = Readonly<{
  addSocketOwner(pid: number): void;
  executable: string;
  procRoot: string;
  remove(): void;
}>;

export function createLinuxProcFixture(
  options: Readonly<{
    executableOwner?: "expected" | "foreign";
    incomplete?: boolean;
    pid?: number;
    tcp?: "empty" | "listener" | "malformed";
  }> = {},
): LinuxProcFixture {
  const procRoot = mkdtempSync(path.join(tmpdir(), "nemoclaw-forward-proc-"));
  const binRoot = path.join(procRoot, "bin");
  const expectedExecutable = path.join(binRoot, "openshell");
  const foreignExecutable = path.join(binRoot, "foreign");
  mkdirSync(path.join(procRoot, "net"), { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(expectedExecutable, "");
  writeFileSync(foreignExecutable, "");

  const tcp = options.tcp ?? "listener";
  const tcpBody = {
    empty: `${linuxTcpHeader}\n`,
    listener: `${linuxTcpHeader}\n${linuxTcpListener}\n`,
    malformed: `${linuxTcpHeader}\nnot-a-proc-row\n`,
  }[tcp];
  writeFileSync(path.join(procRoot, "net", "tcp"), tcpBody);

  const addSocketOwner = (pid: number) => {
    const pidRoot = path.join(procRoot, String(pid));
    mkdirSync(path.join(pidRoot, "fd"), { recursive: true });
    symlinkSync("socket:[424242]", path.join(pidRoot, "fd", "7"));
    symlinkSync(
      options.executableOwner === "foreign" ? foreignExecutable : expectedExecutable,
      path.join(pidRoot, "exe"),
    );
  };

  if (tcp === "listener") {
    addSocketOwner(options.pid ?? 4_321);
    if (options.incomplete) {
      mkdirSync(path.join(procRoot, "9999"));
      writeFileSync(path.join(procRoot, "9999", "fd"), "not a directory");
    }
  }

  return {
    addSocketOwner,
    executable: expectedExecutable,
    procRoot,
    remove: () => rmSync(procRoot, { force: true, recursive: true }),
  };
}

export function throwSupersededWhen(condition: boolean): void {
  if (condition) throw new Error("superseded generation");
}

export function invokeWhen(condition: boolean, action: () => void): void {
  if (condition) action();
}

export function createHarness(overrides: HarnessOverrides = {}) {
  const child = {
    exitCode: null,
    off: vi.fn(),
    once: vi.fn(),
    pid: 4_321,
    signalCode: null,
    unref: vi.fn(),
  } as unknown as ForwardChild;
  const run = vi.fn<RunCommand>(
    overrides.run ?? (async () => capturedForwardList(noActiveForwards)),
  );
  const inspect = vi.fn<InspectListener>(overrides.inspect ?? (async () => ({ state: "unbound" })));
  const inspectLegacy = vi.fn<InspectLegacyListener>(
    overrides.inspectLegacy ??
      (async (_identity, expectedPid) => ({ state: "owned", pid: expectedPid })),
  );
  const probePort = vi.fn<ProbePort>(overrides.probePort ?? (async () => ({ state: "unbound" })));
  const spawn = vi.fn<SpawnForward>(overrides.spawn ?? (() => child));
  const terminate = vi.fn<TerminateForward>(overrides.terminate ?? (async () => true));
  let time = 0;
  const sleep = vi.fn(
    overrides.sleep ??
      (async (milliseconds: number) => {
        time += milliseconds;
      }),
  );
  const adapter = createCliOpenShellForwardAdapter({
    environment: overrides.environment ?? {},
    executable: overrides.executable ?? executable,
    ...(overrides.hostProbe ? { hostProbe: overrides.hostProbe } : {}),
    inspect,
    inspectLegacy,
    now: overrides.now ?? (() => time),
    platform: overrides.platform ?? "linux",
    ...(overrides.procRoot ? { procRoot: overrides.procRoot } : {}),
    ...(overrides.procWorkLimit ? { procWorkLimit: overrides.procWorkLimit } : {}),
    probePort,
    run,
    sleep,
    spawn,
    terminate,
  });
  return { adapter, child, inspect, inspectLegacy, probePort, run, sleep, spawn, terminate };
}
