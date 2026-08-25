// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as lifecycleLock from "../../src/lib/state/mcp-lifecycle-lock";
import {
  createAsynchronousLockReplacementClock,
  createSynchronousLockReplacementClock,
} from "../helpers/mcp-lifecycle-lock-deadline-clock";

const requireDist = createRequire(import.meta.url);
const lockModulePath = requireDist.resolve("../../src/lib/state/mcp-lifecycle-lock.js");
// Keep one CommonJS instance for the macOS probe spy. Behavior tests use the
// static source import so Vitest attributes their coverage to the split modules.
const requiredLifecycleLock = requireDist(
  lockModulePath,
) as typeof import("../../src/lib/state/mcp-lifecycle-lock");
const currentProcessIdentity = lifecycleLock.readMcpLockProcessIdentity(process.pid);
const currentHostIdentity = lifecycleLock.readMcpLockHostIdentity();
const currentPidNamespaceIdentity = lifecycleLock.readMcpLockPidNamespaceIdentity();

let stateDir: string;
const children = new Set<ChildProcess>();

function options(overrides: Partial<lifecycleLock.McpLifecycleLockOptions> = {}) {
  return {
    stateDir,
    pollIntervalMs: 5,
    timeoutMs: 1_000,
    corruptLockGraceMs: 10,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function writeTimerMarker(sandboxName: string, processToken: string): void {
  fs.writeFileSync(
    path.join(stateDir, `shields-timer-${sandboxName}.json`),
    JSON.stringify({
      pid: process.pid,
      sandboxName,
      snapshotPath: path.join(stateDir, "snapshot.yaml"),
      restoreAt: new Date(Date.now() + 60_000).toISOString(),
      processToken,
    }),
  );
}

function routeLinkToPath(
  targetPath: string,
  targetLink: typeof fs.promises.link,
  fallback: typeof fs.promises.link,
): typeof fs.promises.link {
  const routes = new Map([[targetPath, targetLink]]);
  return (from, to) => (routes.get(String(to)) ?? fallback)(from, to);
}

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 2_000);
    child.once("error", reject);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const matched = output.split(/\r?\n/).includes(expected);
      switch (matched) {
        case true:
          clearTimeout(timeout);
          resolve();
      }
    });
  });
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("MCP lifecycle lock", () => {
  it("does not forward an MCP credential to the macOS process-identity probe", () => {
    const childProcess = requireDist("node:child_process");
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const spawnSync = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      status: 0,
      stdout: "Mon Jun 30 12:00:00 2026\n",
      stderr: "",
    } as never);
    const priorSecret = process.env.TEST_MCP_RAW_TOKEN;
    const priorGateway = process.env.OPENSHELL_GATEWAY;
    process.env.TEST_MCP_RAW_TOKEN = "must-reach-only-provider-mutation";
    process.env.OPENSHELL_GATEWAY = "nemoclaw-19080";

    try {
      expect(requiredLifecycleLock.readMcpLockProcessIdentity(4242, true)).toBe(
        "darwin:Mon Jun 30 12:00:00 2026",
      );
      const options = spawnSync.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(options.env?.TEST_MCP_RAW_TOKEN).toBeUndefined();
      expect(options.env?.OPENSHELL_GATEWAY).toBe("nemoclaw-19080");
      expect(options.env?.PATH).toBe(process.env.PATH);
    } finally {
      priorSecret === undefined
        ? delete process.env.TEST_MCP_RAW_TOKEN
        : (process.env.TEST_MCP_RAW_TOKEN = priorSecret);
      priorGateway === undefined
        ? delete process.env.OPENSHELL_GATEWAY
        : (process.env.OPENSHELL_GATEWAY = priorGateway);
      platform.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "contains a symlink generation without following or deleting it",
    async () => {
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
      const containmentPath = `${lockPath}.containment`;
      const targetPath = path.join(stateDir, "operator-owned-target");
      const target = `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: process.pid,
        processIdentity: currentProcessIdentity,
        token: "operator-owned-token",
        acquiredAt: new Date().toISOString(),
      })}\n`;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(targetPath, target);
      fs.symlinkSync(targetPath, lockPath);
      const nowValues = [0, 0, 0, 0, 11];
      let nowCalls = 0;

      await expect(
        lifecycleLock.withMcpLifecycleLock(
          "alpha",
          () => "acquired",
          options({
            timeoutMs: 50,
            monotonicNow: () => nowValues[Math.min(nowCalls++, nowValues.length - 1)],
          }),
        ),
      ).rejects.toThrow(/containment is active/);
      expect(fs.readFileSync(targetPath, "utf8")).toBe(target);
      expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(containmentPath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "contains a non-regular Unix socket generation without deleting it",
    async () => {
      const shortStateDir = path.join("/tmp", `m${process.pid}`);
      fs.rmSync(shortStateDir, { recursive: true, force: true });
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", shortStateDir);
      const containmentPath = `${lockPath}.containment`;
      expect(Buffer.byteLength(lockPath)).toBeLessThan(104);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(lockPath, resolve);
      });
      expect(fs.lstatSync(lockPath).isSocket()).toBe(true);
      let monotonicNow = 0;

      try {
        await expect(
          lifecycleLock.withMcpLifecycleLock("alpha", () => "acquired", {
            ...options(),
            stateDir: shortStateDir,
            corruptLockGraceMs: 1,
            monotonicNow: () => monotonicNow++,
          }),
        ).rejects.toThrow(/containment is active/);
        expect(fs.lstatSync(lockPath).isSocket()).toBe(true);
        expect(fs.existsSync(containmentPath)).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(shortStateDir, { recursive: true, force: true });
      }
    },
  );

  it("serializes separate top-level promises in one process", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = lifecycleLock.withMcpLifecycleLock(
      "alpha",
      async () => {
        order.push("first-enter");
        firstEntered.resolve();
        await releaseFirst.promise;
        order.push("first-exit");
      },
      options(),
    );
    await firstEntered.promise;

    const second = lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        order.push("second-enter");
      },
      options(),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-enter"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("is reentrant only inside the same async lifecycle context", async () => {
    const events: string[] = [];
    await lifecycleLock.withMcpLifecycleLock(
      "alpha",
      async () => {
        events.push("outer");
        await lifecycleLock.withMcpLifecycleLock(
          "alpha",
          () => events.push("nested"),
          options({ timeoutMs: 50 }),
        );
      },
      options(),
    );
    expect(events).toEqual(["outer", "nested"]);
    expect(fs.existsSync(lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir))).toBe(false);
  });

  it("does not let a detached promise reuse an ended operation's lease", async () => {
    const startDetached = deferred();
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    let detached: Promise<void> | undefined;

    await lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        detached = (async () => {
          await startDetached.promise;
          await lifecycleLock.withMcpLifecycleLock(
            "alpha",
            () => expect(fs.existsSync(lockPath)).toBe(true),
            options(),
          );
        })();
      },
      options(),
    );

    startDetached.resolve();
    await detached;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("serializes a second Node process on the same sandbox", async () => {
    const releasePath = path.join(stateDir, "release-child");
    const script = String.raw`
const fs = require("node:fs");
const lock = require(process.argv[1]);
const stateDir = process.argv[2];
const releasePath = process.argv[3];
(async () => {
  await lock.withMcpLifecycleLock("alpha", async () => {
    process.stdout.write("READY\n");
    while (!fs.existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }, { stateDir, pollIntervalMs: 5, timeoutMs: 2000 });
})().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
`;
    const child = spawn(process.execPath, ["-e", script, lockModulePath, stateDir, releasePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const childExit = new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}`))));
    });
    await waitForLine(child, "READY");

    let parentEntered = false;
    const parent = lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        parentEntered = true;
      },
      options({ timeoutMs: 2_000 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(parentEntered).toBe(false);

    fs.writeFileSync(releasePath, "release\n");
    await parent;
    expect(parentEntered).toBe(true);
    await childExit;
    children.delete(child);
  });

  it("recovers an atomic lock left by a dead owner", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    let entered = false;
    await lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        entered = true;
      },
      options(),
    );
    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(containmentPath)).toBe(false);
  });

  it("recovers an atomic lock left by a dead owner for synchronous callers", () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-sync-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    expect(lifecycleLock.withMcpLifecycleLockSync("alpha", () => "acquired", options())).toBe(
      "acquired",
    );
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(containmentPath)).toBe(false);
  });

  it("preserves a replacement main lock published during stale recovery", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "observed-stale-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const replacement = {
      version: 1,
      sandboxName: "alpha",
      pid: process.pid,
      processIdentity: currentProcessIdentity,
      hostIdentity: currentHostIdentity,
      pidNamespaceIdentity: currentPidNamespaceIdentity,
      token: "replacement-main-token",
      acquiredAt: new Date().toISOString(),
    };
    const rename = fs.promises.rename.bind(fs.promises);
    let injectedReplacement = false;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      switch (!injectedReplacement && String(from) === lockPath) {
        case true:
          injectedReplacement = true;
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
      }
      return rename(from, to);
    });

    // Drive the deadline from a stepping clock: on a loaded CI runner the
    // real 50 ms budget can expire before stale recovery reaches its first
    // rename, so the replacement is never published and the final assertion
    // observes the planted stale token (NVIDIA/NemoClaw#8948).
    let monotonicNow = 0;
    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock(
          "alpha",
          () => undefined,
          options({ timeoutMs: 50, monotonicNow: () => monotonicNow++ }),
        ),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    } finally {
      renameSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("replacement-main-token");
  });

  it("commits durable containment for a stale deadline generation before an ordinary mutation", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-deadline",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-deadline-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    let monotonicNow = 0;
    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({
          timeoutMs: 40,
          monotonicNow: () => monotonicNow++,
        }),
      ),
    ).rejects.toThrow("Sandbox mutation containment is active");
    expect(fs.existsSync(deadlinePath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("commits durable containment for a stale deadline generation before deadline recovery", async () => {
    const processToken = "9".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const containmentPath = `${lockPath}.containment`;
    writeTimerMarker("alpha", processToken);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-deadline",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        shieldsTakeoverToken: processToken,
        token: "stale-deadline-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const onContainment = vi.fn(() => writeTimerMarker("alpha", "8".repeat(32)));
    await expect(
      lifecycleLock.withMcpLifecycleDeadlineFence("alpha", processToken, () => undefined, {
        ...options({ timeoutMs: 40 }),
        onContainment,
      }),
    ).rejects.toThrow("Auto-restore authority changed");
    expect(onContainment).toHaveBeenCalledOnce();
    expect(fs.existsSync(deadlinePath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("waits for a foreign-host owner instead of reaping it with local PID checks", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "foreign-process",
        hostIdentity: `${currentHostIdentity}-foreign`,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "foreign-host-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const old = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, old, old);

    await expect(
      lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 40 })),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("foreign-host-token");
  });

  it.each([
    ["unknown legacy host", {}],
    [
      "foreign PID namespace",
      {
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: `${currentPidNamespaceIdentity ?? "unknown"}-foreign`,
      },
    ],
  ])("fails closed for an owner from an %s", async (_label, ownerLocation) => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "unknown-process",
        ...ownerLocation,
        token: "untrusted-owner-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    await expect(
      lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 40 })),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("untrusted-owner-token");
  });

  it("accepts ownership when LINK succeeded but its NFS reply reports EEXIST", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const link = fs.promises.link.bind(fs.promises);
    let injectedAmbiguousReply = false;
    const linkSpy = vi.spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
      await link(from, to);
      const shouldInject =
        !injectedAmbiguousReply && String(to) === lockPath && String(from).includes(".candidate-");
      switch (shouldInject) {
        case true:
          injectedAmbiguousReply = true;
          throw Object.assign(new Error("simulated replayed LINK response"), { code: "EEXIST" });
      }
    });

    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", () => "acquired", options()),
      ).resolves.toBe("acquired");
    } finally {
      linkSpy.mockRestore();
    }
    expect(injectedAmbiguousReply).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not strand a canonical self-lock when candidate cleanup fails", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const rm = fs.promises.rm.bind(fs.promises);
    let injectedCleanupFailure = false;
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const shouldInject = !injectedCleanupFailure && String(target).includes(".candidate-");
      switch (shouldInject) {
        case true:
          injectedCleanupFailure = true;
          throw Object.assign(new Error("simulated candidate cleanup failure"), { code: "EIO" });
      }
      return rm(target, options);
    });

    let entered = false;
    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock(
          "alpha",
          () => {
            entered = true;
          },
          options(),
        ),
      ).resolves.toBeUndefined();
    } finally {
      rmSpy.mockRestore();
    }
    expect(injectedCleanupFailure).toBe(true);
    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("waits for grace then commits durable containment for a stable truncated owner record", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{"version":1,"sandboxName":"alpha"');

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({ timeoutMs: 30, corruptLockGraceMs: 100 }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(fs.readFileSync(lockPath, "utf8")).toContain('"sandboxName":"alpha"');

    const future = new Date(Date.now() + 24 * 60 * 60_000);
    fs.utimesSync(lockPath, future, future);

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({ timeoutMs: 1_000, corruptLockGraceMs: 20 }),
      ),
    ).rejects.toThrow("Sandbox mutation containment is active");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("preserves a corrupt lock when observation crosses the acquisition deadline (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{"version":1,"sandboxName":"alpha"');
    const nowValues = [0, 0, 0, 0, 10, 10, 200];
    let nowCalls = 0;

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({
          timeoutMs: 30,
          corruptLockGraceMs: 100,
          monotonicNow: () => nowValues[Math.min(nowCalls++, nowValues.length - 1)],
        }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(fs.readFileSync(lockPath, "utf8")).toContain('"sandboxName":"alpha"');
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("rolls back containment when publication crosses the acquisition deadline in the asynchronous path (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-deadline",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-deadline-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const linkSync = fs.linkSync.bind(fs);
    let now = 0;
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      linkSync(from, to);
      now = String(to) === containmentPath ? 100 : now;
    });
    const operation = vi.fn();

    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", operation, {
          ...options({ timeoutMs: 30 }),
          monotonicNow: () => now,
        }),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    } finally {
      linkSpy.mockRestore();
    }

    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(deadlinePath, "utf8")).token).toBe("stale-deadline-token");
    expect(fs.existsSync(containmentPath)).toBe(false);
  });

  it("rolls back containment when publication crosses the acquisition deadline in the synchronous path (#7858)", () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-deadline",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-deadline-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const linkSync = fs.linkSync.bind(fs);
    let now = 0;
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      linkSync(from, to);
      now = String(to) === containmentPath ? 100 : now;
    });
    const operation = vi.fn();

    try {
      expect(() =>
        lifecycleLock.withMcpLifecycleLockSync("alpha", operation, {
          ...options({ timeoutMs: 30 }),
          monotonicNow: () => now,
        }),
      ).toThrow("Timed out waiting for sandbox mutation lock");
    } finally {
      linkSpy.mockRestore();
    }

    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(deadlinePath, "utf8")).token).toBe("stale-deadline-token");
    expect(fs.existsSync(containmentPath)).toBe(false);
  });

  it("does not enter the critical section when lock publication crosses the acquisition deadline (#7858)", async () => {
    let nowCalls = 0;
    let entered = false;

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => {
          entered = true;
        },
        options({
          timeoutMs: 30,
          monotonicNow: () => (nowCalls++ < 3 ? 0 : 100),
        }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(entered).toBe(false);
    expect(fs.existsSync(lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir))).toBe(false);
  });

  it("does not invoke the callback after the acquisition deadline in the asynchronous path (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const clock = createAsynchronousLockReplacementClock(lockPath, "async-replacement-token");
    const operation = vi.fn();

    await expect(
      lifecycleLock.withMcpLifecycleLock("alpha", operation, {
        ...options({ timeoutMs: 30 }),
        monotonicNow: clock.monotonicNow,
      }),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(clock.handoffScheduled()).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("async-replacement-token");
  });

  it("does not invoke the callback after the acquisition deadline in the synchronous path (#7858)", () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const clock = createSynchronousLockReplacementClock(lockPath, "sync-replacement-token");
    const operation = vi.fn();

    expect(() =>
      lifecycleLock.withMcpLifecycleLockSync("alpha", operation, {
        ...options({ timeoutMs: 30 }),
        monotonicNow: clock.monotonicNow,
      }),
    ).toThrow("Timed out waiting for sandbox mutation lock");

    expect(clock.acquisitionPublished()).toBe(true);
    expect(clock.replacementPublished()).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("sync-replacement-token");
  });

  it("does not enter the synchronous critical section when lock publication crosses the acquisition deadline (#7858)", () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const linkSync = fs.linkSync.bind(fs);
    let now = 0;
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      linkSync(from, to);
      now = String(to) === lockPath ? 100 : now;
    });
    const operation = vi.fn();

    try {
      expect(() =>
        lifecycleLock.withMcpLifecycleLockSync("alpha", operation, {
          ...options({ timeoutMs: 30 }),
          monotonicNow: () => now,
        }),
      ).toThrow("Timed out waiting for sandbox mutation lock");
    } finally {
      linkSpy.mockRestore();
    }

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("restores a stale main lock when reclamation crosses the acquisition deadline (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-main-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const rename = fs.promises.rename.bind(fs.promises);
    let now = 0;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      now = String(from) === lockPath ? 100 : now;
    });
    let entered = false;

    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock(
          "alpha",
          () => {
            entered = true;
          },
          options({ timeoutMs: 30, monotonicNow: () => now }),
        ),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    } finally {
      renameSpy.mockRestore();
    }

    expect(entered).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("stale-main-token");
  });

  it("restores a stale main lock when synchronous reclamation crosses the acquisition deadline (#7858)", () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-process",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-main-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const renameSync = fs.renameSync.bind(fs);
    let now = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameSync(from, to);
      now = String(from) === lockPath ? 100 : now;
    });
    const operation = vi.fn();

    try {
      expect(() =>
        lifecycleLock.withMcpLifecycleLockSync("alpha", operation, {
          ...options({ timeoutMs: 30 }),
          monotonicNow: () => now,
        }),
      ).toThrow("Timed out waiting for sandbox mutation lock");
    } finally {
      renameSpy.mockRestore();
    }

    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("stale-main-token");
  });

  it("preserves a stale reaper when observation crosses the acquisition deadline (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const reaperPath = `${lockPath}.reaper`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      reaperPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-reaper",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-reaper-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    let nowCalls = 0;

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({ timeoutMs: 30, monotonicNow: () => (nowCalls++ < 2 ? 0 : 100) }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(JSON.parse(fs.readFileSync(reaperPath, "utf8")).token).toBe("stale-reaper-token");
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("does not reclaim a corrupt directory at the lock path (#7858)", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(lockPath, { recursive: true });
    const nowValues = [0, 0, 0, 0, 100];
    let nowCalls = 0;

    await expect(
      lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => undefined,
        options({
          timeoutMs: 30,
          corruptLockGraceMs: 1,
          monotonicNow: () => nowValues[Math.min(nowCalls++, nowValues.length - 1)],
        }),
      ),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(fs.lstatSync(lockPath).isDirectory()).toBe(true);
  });

  it("commits durable containment for a reaper whose owner died during stale-lock cleanup", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const reaperPath = `${lockPath}.reaper`;
    const containmentPath = `${lockPath}.containment`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      reaperPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "killed-reaper",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "stale-reaper-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );

    await expect(
      lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 200 })),
    ).rejects.toThrow("Sandbox mutation containment is active");
    expect(fs.existsSync(reaperPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("never overwrites an existing durable-containment generation", () => {
    const processToken = "a".repeat(32);
    const containmentPath = `${lifecycleLock.getMcpLifecycleLockPath(
      "alpha",
      stateDir,
    )}.containment`;
    lifecycleLock.beginCommittedMcpLifecycleContainmentSync(
      "alpha",
      processToken,
      "first containment",
      stateDir,
    );
    const firstGeneration = fs.readFileSync(containmentPath, "utf8");

    expect(() =>
      lifecycleLock.beginCommittedMcpLifecycleContainmentSync(
        "alpha",
        processToken,
        "replacement containment",
        stateDir,
      ),
    ).toThrow("already exists");
    expect(fs.readFileSync(containmentPath, "utf8")).toBe(firstGeneration);
  });

  it.skipIf(currentProcessIdentity === null)(
    "recovers a recycled PID after confirming a fresh process-start mismatch",
    async () => {
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
      const containmentPath = `${lockPath}.containment`;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          sandboxName: "alpha",
          pid: process.pid,
          processIdentity: `${String(currentProcessIdentity)}-different-start`,
          hostIdentity: currentHostIdentity,
          pidNamespaceIdentity: currentPidNamespaceIdentity,
          token: "recycled-token",
          acquiredAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );

      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options()),
      ).resolves.toBeUndefined();
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(containmentPath)).toBe(false);
    },
  );

  it.skipIf(currentProcessIdentity === null)(
    "does not treat a recycled same PID as synchronous reentrancy",
    () => {
      const processToken = "6".repeat(32);
      const replacementProcessToken = "7".repeat(32);
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
      writeTimerMarker("alpha", processToken);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          sandboxName: "alpha",
          pid: process.pid,
          processIdentity: `${String(currentProcessIdentity)}-different-start`,
          hostIdentity: currentHostIdentity,
          pidNamespaceIdentity: currentPidNamespaceIdentity,
          shieldsTakeoverToken: processToken,
          token: "recycled-sync-token",
          acquiredAt: "2026-01-01T00:00:00.000Z",
        })}\n`,
      );
      const onContainment = vi.fn(() => writeTimerMarker("alpha", replacementProcessToken));

      expect(() =>
        lifecycleLock.withMcpLifecycleDeadlineFenceSync("alpha", processToken, () => undefined, {
          ...options({ timeoutMs: 10 }),
          onContainment,
        }),
      ).toThrow("Auto-restore authority changed");
      expect(onContainment).toHaveBeenCalled();
    },
  );

  it("does not break a long-lived lock owned by the same process identity", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: process.pid,
        processIdentity: lifecycleLock.readMcpLockProcessIdentity(process.pid),
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        token: "active-token",
        acquiredAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const old = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, old, old);

    await expect(
      lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 40 })),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("active-token");
  });

  it("never releases a lock whose owner token changed", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    await lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        fs.writeFileSync(lockPath, `${JSON.stringify({ ...owner, token: "replacement-token" })}\n`);
      },
      options(),
    );

    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("replacement-token");
  });

  it("binds an ordinary lifecycle owner to the active Shields timer generation", async () => {
    const processToken = "a".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    writeTimerMarker("alpha", processToken);

    await lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).shieldsTakeoverToken).toBe(
          processToken,
        );
      },
      options(),
    );
  });

  it("does not read a timer marker through a traversal-shaped lifecycle key", async () => {
    const sandboxName = `a/../../escaped-${path.basename(stateDir)}`;
    const escapedMarkerPath = path.join(stateDir, `shields-timer-${sandboxName}.json`);
    const processToken = "a".repeat(32);
    fs.writeFileSync(
      escapedMarkerPath,
      JSON.stringify({
        pid: process.pid,
        sandboxName,
        snapshotPath: path.join(stateDir, "snapshot.yaml"),
        restoreAt: new Date(Date.now() + 60_000).toISOString(),
        processToken,
      }),
    );

    try {
      const lockPath = lifecycleLock.getMcpLifecycleLockPath(sandboxName, stateDir);
      await lifecycleLock.withMcpLifecycleLock(
        sandboxName,
        () => {
          expect(
            JSON.parse(fs.readFileSync(lockPath, "utf8")).shieldsTakeoverToken,
          ).toBeUndefined();
        },
        options(),
      );
    } finally {
      fs.rmSync(escapedMarkerPath, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not derive Shields authority from a symlinked timer marker",
    async () => {
      const processToken = "8".repeat(32);
      const targetPath = path.join(stateDir, "operator-owned-timer-marker.json");
      const markerPath = path.join(stateDir, "shields-timer-alpha.json");
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
      fs.writeFileSync(
        targetPath,
        JSON.stringify({
          pid: process.pid,
          sandboxName: "alpha",
          snapshotPath: path.join(stateDir, "snapshot.yaml"),
          restoreAt: new Date(Date.now() + 60_000).toISOString(),
          processToken,
        }),
      );
      fs.symlinkSync(targetPath, markerPath);
      let observedTakeoverToken: string | undefined;

      await lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => {
          observedTakeoverToken = JSON.parse(
            fs.readFileSync(lockPath, "utf8"),
          ).shieldsTakeoverToken;
        },
        options(),
      );

      expect(observedTakeoverToken).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(targetPath, "utf8")).processToken).toBe(processToken);
    },
  );

  it("retries without entering when the timer generation changes during lock publication", async () => {
    const firstProcessToken = "a".repeat(32);
    const replacementProcessToken = "b".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    writeTimerMarker("alpha", firstProcessToken);
    const link = fs.promises.link.bind(fs.promises);
    const lockPathLink = vi.fn(link);
    lockPathLink.mockImplementationOnce(async (from, to) => {
      await link(from, to);
      writeTimerMarker("alpha", replacementProcessToken);
    });
    const linkSpy = vi
      .spyOn(fs.promises, "link")
      .mockImplementation(routeLinkToPath(lockPath, lockPathLink, link));

    try {
      await lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => {
          expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).shieldsTakeoverToken).toBe(
            replacementProcessToken,
          );
        },
        options(),
      );
    } finally {
      linkSpy.mockRestore();
    }
    expect(lockPathLink).toHaveBeenCalled();
  });

  it("keeps the deadline fence closed through restore and configuration relock", async () => {
    const processToken = "c".repeat(32);
    writeTimerMarker("alpha", processToken);
    const entered = deferred();
    const release = deferred();
    let contenderEntered = false;

    const deadline = lifecycleLock.withMcpLifecycleDeadlineFence(
      "alpha",
      processToken,
      async () => {
        entered.resolve();
        await release.promise;
      },
      options(),
    );
    await entered.promise;
    const contender = lifecycleLock.withMcpLifecycleLock(
      "alpha",
      () => {
        contenderEntered = true;
      },
      options({ timeoutMs: 2_000 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(contenderEntered).toBe(false);

    release.resolve();
    await Promise.all([deadline, contender]);
    expect(contenderEntered).toBe(true);
  });

  it("keeps the deadline fence when an in-flight ordinary publication wins the main link", async () => {
    const processToken = "0".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker("alpha", processToken);

    const ordinaryLinkStarted = deferred();
    const allowOrdinaryPublication = deferred();
    const ordinaryPublished = deferred();
    const allowOrdinaryLinkReturn = deferred();
    const timerMainLinkStarted = deferred();
    const timerEntered = deferred();
    const releaseTimer = deferred();
    const link = fs.promises.link.bind(fs.promises);
    let ordinaryEntered = false;
    const lockPathLink = vi.fn(link);
    lockPathLink.mockImplementationOnce(async (from, to) => {
      ordinaryLinkStarted.resolve();
      await allowOrdinaryPublication.promise;
      await link(from, to);
      ordinaryPublished.resolve();
      await allowOrdinaryLinkReturn.promise;
    });
    lockPathLink.mockImplementationOnce(async (from, to) => {
      timerMainLinkStarted.resolve();
      await ordinaryPublished.promise;
      await link(from, to);
    });
    const linkSpy = vi
      .spyOn(fs.promises, "link")
      .mockImplementation(routeLinkToPath(lockPath, lockPathLink, link));

    try {
      const ordinary = lifecycleLock.withMcpLifecycleLock(
        "alpha",
        () => {
          ordinaryEntered = true;
        },
        options({ timeoutMs: 2_000 }),
      );
      await ordinaryLinkStarted.promise;

      const deadline = lifecycleLock.withMcpLifecycleDeadlineFence(
        "alpha",
        processToken,
        async () => {
          timerEntered.resolve();
          await releaseTimer.promise;
        },
        options({ timeoutMs: 2_000 }),
      );
      await timerMainLinkStarted.promise;
      expect(fs.existsSync(deadlinePath)).toBe(true);

      allowOrdinaryPublication.resolve();
      await ordinaryPublished.promise;
      allowOrdinaryLinkReturn.resolve();
      await timerEntered.promise;
      expect(fs.existsSync(deadlinePath)).toBe(true);
      expect(ordinaryEntered).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ordinaryEntered).toBe(false);

      releaseTimer.resolve();
      await Promise.all([deadline, ordinary]);
      expect(ordinaryEntered).toBe(true);
      expect(lockPathLink.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      allowOrdinaryPublication.resolve();
      allowOrdinaryLinkReturn.resolve();
      releaseTimer.resolve();
      linkSpy.mockRestore();
    }
  });

  it("waits for a live same-generation owner to release naturally", async () => {
    const processToken = "d".repeat(32);
    writeTimerMarker("alpha", processToken);
    const releasePath = path.join(stateDir, "release-owner");
    const script = String.raw`
const fs = require("node:fs");
const lock = require(process.argv[1]);
const stateDir = process.argv[2];
const releasePath = process.argv[3];
(async () => {
  await lock.withMcpLifecycleLock("alpha", async () => {
    process.stdout.write("READY\n");
    while (!fs.existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }, { stateDir, pollIntervalMs: 5, timeoutMs: 2000 });
})().then(() => process.exit(0), () => process.exit(1));
`;
    const child = spawn(process.execPath, ["-e", script, lockModulePath, stateDir, releasePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    await waitForLine(child, "READY");
    const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const containmentReported = deferred();
    let entered = false;
    let reportedOwnerPid: number | null = null;
    const deadline = lifecycleLock.withMcpLifecycleDeadlineFence(
      "alpha",
      processToken,
      () => {
        entered = true;
      },
      {
        ...options({ timeoutMs: 10 }),
        onContainment: ({ ownerPid }) => {
          reportedOwnerPid = ownerPid;
          containmentReported.resolve();
        },
      },
    );
    await containmentReported.promise;
    expect(reportedOwnerPid).toBe(child.pid);
    expect(entered).toBe(false);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();

    fs.writeFileSync(releasePath, "release\n");
    await Promise.all([deadline, childExit]);
    expect(entered).toBe(true);
    children.delete(child);
  });

  it("preserves an active owner from a different timer generation", async () => {
    const processToken = "e".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    writeTimerMarker("alpha", processToken);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: process.pid,
        processIdentity: currentProcessIdentity,
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        shieldsTakeoverToken: "f".repeat(32),
        token: "replacement-generation",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    const deadlinePath = `${lockPath}.deadline`;
    const deadlineObservations: boolean[] = [];
    const onContainment = vi.fn(() => {
      deadlineObservations.push(fs.existsSync(deadlinePath));
      writeTimerMarker("alpha", "3".repeat(32));
    });
    await expect(
      lifecycleLock.withMcpLifecycleDeadlineFence("alpha", processToken, () => undefined, {
        ...options({ timeoutMs: 10 }),
        onContainment,
      }),
    ).rejects.toThrow("Auto-restore authority changed");
    expect(deadlineObservations).not.toHaveLength(0);
    expect(deadlineObservations.every(Boolean)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("replacement-generation");
  });

  it("contains an already-dead local owner because surviving descendants cannot be ruled out", async () => {
    const processToken = "4".repeat(32);
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const containmentPath = `${lockPath}.containment`;
    writeTimerMarker("alpha", processToken);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        pid: 2_147_483_647,
        processIdentity: "dead-owner",
        hostIdentity: currentHostIdentity,
        pidNamespaceIdentity: currentPidNamespaceIdentity,
        shieldsTakeoverToken: "5".repeat(32),
        token: "dead-foreign-generation",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    const onContainment = vi.fn(() => writeTimerMarker("alpha", "a".repeat(32)));
    await expect(
      lifecycleLock.withMcpLifecycleDeadlineFence("alpha", processToken, () => undefined, {
        ...options(),
        onContainment,
      }),
    ).rejects.toThrow("Auto-restore authority changed");
    expect(onContainment).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(containmentPath)).toBe(true);
  });
});
