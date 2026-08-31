// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AddressInfo, createServer } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ForwardServiceProcessDeps } from "./forward-service-process";
import {
  ensureForwardServiceProcess,
  inspectForwardServiceProcess,
  processOwnsForwardServiceListener,
  stopForwardServiceProcess,
} from "./forward-service-process";

const uid = process.getuid?.() ?? 0;
const target = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default" as const,
  sandboxName: "alpha",
  sandboxIdentityFingerprint: "a".repeat(64),
  localHost: "127.0.0.1" as const,
  localPort: 18_789,
  targetHost: "127.0.0.1" as const,
  targetPort: 18_789,
};

function createProcessHarness(
  options: {
    ignoreChildSignal?: boolean;
    neverReady?: boolean;
    unreachable?: boolean;
    unreadableMetadata?: boolean;
  } = {},
): {
  deps: ForwardServiceProcessDeps;
  calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[];
  setReachable(value: boolean): void;
  replaceListenerWithForeign(): void;
  replaceIdentity(): void;
} {
  const pid = 4242;
  let alive = false;
  let reachable = false;
  let ownsListener = false;
  let foreignListener = false;
  let processIdentity: string | null = "linux:test-boot:100";
  let argv: readonly string[] | null = null;
  const calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
  const stopChild = options.ignoreChildSignal
    ? () => {}
    : () => {
        alive = false;
        ownsListener = false;
        reachable = foreignListener;
      };
  const deps: ForwardServiceProcessDeps = {
    hostIdentity: "linux:test-host",
    pidNamespaceIdentity: "pid:[100]",
    isReachable: () => reachable,
    processIsAlive: () => alive,
    processOwnsListener: () => ownsListener,
    readProcessArgv: () => argv,
    readProcessIdentity: () => processIdentity,
    readProcessUid: () => uid,
    signalProcess: () => {
      alive = false;
      ownsListener = false;
      reachable = foreignListener;
    },
    sleep: () => {},
    spawnDetached: (executable, args, environment) => {
      alive = options.neverReady !== true || options.unreadableMetadata === true;
      reachable = options.neverReady !== true && options.unreachable !== true;
      ownsListener = reachable;
      argv =
        options.neverReady === true || options.unreadableMetadata === true
          ? null
          : [executable, ...args];
      processIdentity = options.unreadableMetadata ? null : processIdentity;
      calls.push({ args, environment });
      return {
        pid,
        kill: () => {
          stopChild();
          return true;
        },
        unref: vi.fn(),
      };
    },
    now: () => "2026-08-31T16:00:00.000Z",
  };
  return {
    deps,
    calls,
    setReachable: (value) => {
      reachable = value;
    },
    replaceListenerWithForeign: () => {
      ownsListener = false;
      foreignListener = true;
      reachable = true;
    },
    replaceIdentity: () => {
      processIdentity = "linux:test-boot:200";
    },
  };
}

describe("OpenShell ForwardTcp process lifecycle (#10691)", () => {
  let stateDirectory = "";
  const lifecycleOptions = (harness: ReturnType<typeof createProcessHarness>) => ({
    deps: harness.deps,
    runExclusive: <T>(operation: () => T): T => operation(),
    stateDirectory,
    uid,
  });

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-service-process-"));
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { force: true, recursive: true });
  });

  it("binds listener evidence to the process that owns the socket", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address() as AddressInfo;
      expect(
        processOwnsForwardServiceListener(process.pid, {
          ...target,
          localPort: address.port,
          targetPort: address.port,
        }),
      ).toBe(true);
      const unusedPort = address.port === 65_535 ? address.port - 1 : address.port + 1;
      expect(
        processOwnsForwardServiceListener(process.pid, {
          ...target,
          localPort: unusedPort,
          targetPort: unusedPort,
        }),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("starts one detached direct ForwardTcp process with an allowlisted environment", () => {
    const harness = createProcessHarness();
    const result = ensureForwardServiceProcess(target, {
      ...lifecycleOptions(harness),
      sourceEnvironment: {
        HOME: "/home/tester",
        PATH: "/usr/bin",
        OPENSHELL_GATEWAY_ENDPOINT: "https://attacker.invalid",
        GITHUB_TOKEN: "secret",
      },
    });

    expect(result.action).toBe("started");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.args).toEqual(result.receipt.argv.slice(1));
    expect(harness.calls[0]?.environment).toMatchObject({ HOME: "/home/tester", PATH: "/usr/bin" });
    expect(harness.calls[0]?.environment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(harness.calls[0]?.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toMatchObject({
      disposition: "owned",
      ownsListener: true,
      reachable: true,
    });
  });

  it("reuses an owned reachable process without another spawn", () => {
    const harness = createProcessHarness();
    ensureForwardServiceProcess(target, lifecycleOptions(harness));
    expect(ensureForwardServiceProcess(target, lifecycleOptions(harness)).action).toBe("reused");
    expect(harness.calls).toHaveLength(1);
  });

  it("stops only an owned process and removes its receipt", () => {
    const harness = createProcessHarness();
    ensureForwardServiceProcess(target, lifecycleOptions(harness));
    expect(stopForwardServiceProcess(target, lifecycleOptions(harness))).toBe("stopped");
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toEqual({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
  });

  it("refuses to signal a PID after process identity reuse", () => {
    const harness = createProcessHarness();
    ensureForwardServiceProcess(target, lifecycleOptions(harness));
    harness.replaceIdentity();
    expect(() => stopForwardServiceProcess(target, lifecycleOptions(harness))).toThrow(
      /refusing signal/u,
    );
  });

  it("refuses to start when an untracked listener owns the local port", () => {
    const harness = createProcessHarness();
    harness.setReachable(true);
    expect(() => ensureForwardServiceProcess(target, lifecycleOptions(harness))).toThrow(
      /another listener/u,
    );
    expect(harness.calls).toHaveLength(0);
  });

  it("does not reuse a live receipt process when another process owns the reachable listener", () => {
    const harness = createProcessHarness();
    ensureForwardServiceProcess(target, lifecycleOptions(harness));
    harness.replaceListenerWithForeign();

    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toMatchObject({
      disposition: "owned",
      ownsListener: false,
      reachable: true,
    });
    expect(() => ensureForwardServiceProcess(target, lifecycleOptions(harness))).toThrow(
      /another listener/u,
    );
    expect(harness.calls).toHaveLength(1);
  });

  it("fails without a receipt when the child never becomes ready", () => {
    const harness = createProcessHarness({ neverReady: true });
    expect(() =>
      ensureForwardServiceProcess(target, {
        ...lifecycleOptions(harness),
        startTimeoutMs: 1,
      }),
    ).toThrow(/did not become ready/u);
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toEqual({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
  });

  it("stops an identified child when its listener never becomes reachable", () => {
    const harness = createProcessHarness({ unreachable: true });
    expect(() =>
      ensureForwardServiceProcess(target, {
        ...lifecycleOptions(harness),
        startTimeoutMs: 1,
      }),
    ).toThrow(/did not become ready/u);
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toEqual({
      disposition: "absent",
      ownsListener: false,
      reachable: false,
      receipt: null,
    });
  });

  it("retains process authority when an unready child ignores SIGTERM", () => {
    const harness = createProcessHarness({ ignoreChildSignal: true, unreachable: true });
    expect(() =>
      ensureForwardServiceProcess(target, {
        ...lifecycleOptions(harness),
        startTimeoutMs: 1,
        stopTimeoutMs: 1,
      }),
    ).toThrow(/remains running/u);
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toMatchObject({
      disposition: "owned",
      reachable: false,
    });
  });

  it("retains pending authority when an unidentified failed child ignores SIGTERM", () => {
    const harness = createProcessHarness({
      ignoreChildSignal: true,
      unreachable: true,
      unreadableMetadata: true,
    });
    expect(() =>
      ensureForwardServiceProcess(target, {
        ...lifecycleOptions(harness),
        startTimeoutMs: 1,
        stopTimeoutMs: 1,
      }),
    ).toThrow(/remains running/u);
    expect(inspectForwardServiceProcess(target, lifecycleOptions(harness))).toMatchObject({
      disposition: "unknown",
      ownsListener: null,
      receipt: null,
    });
    expect(() => ensureForwardServiceProcess(target, lifecycleOptions(harness))).toThrow(
      /pending process is unknown/u,
    );
    expect(harness.calls).toHaveLength(1);
  });
});
