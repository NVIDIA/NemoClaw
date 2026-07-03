// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./helpers/mcp-lifecycle-lock-properties";

type LifecycleLockModule = typeof import("../src/lib/state/mcp-lifecycle-lock");

const requireDist = createRequire(import.meta.url);
const lockModulePath = requireDist.resolve("../src/lib/state/mcp-lifecycle-lock.js");
const lifecycleLock = requireDist(lockModulePath) as LifecycleLockModule;
const currentProcessIdentity = lifecycleLock.readMcpLockProcessIdentity(process.pid);
const currentHostIdentity = lifecycleLock.readMcpLockHostIdentity();
const currentPidNamespaceIdentity = lifecycleLock.readMcpLockPidNamespaceIdentity();

let stateDir: string;
const children = new Set<ChildProcess>();

function options(overrides: Record<string, number> = {}) {
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
      expect(lifecycleLock.readMcpLockProcessIdentity(4242, true)).toBe(
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
    "does not follow a symlink when observing lock ownership",
    async () => {
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
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

      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", () => "acquired", options()),
      ).resolves.toBe("acquired");
      expect(fs.readFileSync(targetPath, "utf8")).toBe(target);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reaps a non-regular Unix socket found at the lock path",
    async () => {
      const shortStateDir = path.join("/tmp", `m${process.pid}`);
      fs.rmSync(shortStateDir, { recursive: true, force: true });
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", shortStateDir);
      expect(Buffer.byteLength(lockPath)).toBeLessThan(104);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(lockPath, resolve);
      });
      expect(fs.lstatSync(lockPath).isSocket()).toBe(true);

      try {
        await expect(
          lifecycleLock.withMcpLifecycleLock("alpha", () => "acquired", {
            ...options(),
            stateDir: shortStateDir,
          }),
        ).resolves.toBe("acquired");
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

  it("waits for grace then recovers a stable truncated owner record", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
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
        () => "acquired",
        options({ timeoutMs: 200, corruptLockGraceMs: 20 }),
      ),
    ).resolves.toBe("acquired");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("recovers a reaper whose owner was killed during stale-lock cleanup", async () => {
    const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
    const reaperPath = `${lockPath}.reaper`;
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
    expect(fs.existsSync(reaperPath)).toBe(false);
  });

  it("does not unlink a replacement reaper published during stale recovery", async () => {
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
        token: "observed-stale-token",
        acquiredAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const replacement = {
      version: 1,
      sandboxName: "alpha",
      pid: process.pid,
      processIdentity: lifecycleLock.readMcpLockProcessIdentity(process.pid),
      hostIdentity: currentHostIdentity,
      pidNamespaceIdentity: currentPidNamespaceIdentity,
      token: "replacement-reaper-token",
      acquiredAt: new Date().toISOString(),
    };
    const rename = fs.promises.rename.bind(fs.promises);
    let injectedReplacement = false;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      const shouldInject = !injectedReplacement && String(from) === reaperPath;
      switch (shouldInject) {
        case true:
          injectedReplacement = true;
          fs.unlinkSync(reaperPath);
          fs.writeFileSync(reaperPath, `${JSON.stringify(replacement)}\n`);
      }
      return rename(from, to);
    });

    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 50 })),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    } finally {
      renameSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(reaperPath, "utf8")).token).toBe("replacement-reaper-token");
  });

  it("does not delete a replacement main lock during stale recovery", async () => {
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
      processIdentity: lifecycleLock.readMcpLockProcessIdentity(process.pid),
      hostIdentity: currentHostIdentity,
      pidNamespaceIdentity: currentPidNamespaceIdentity,
      token: "replacement-main-token",
      acquiredAt: new Date().toISOString(),
    };
    const rename = fs.promises.rename.bind(fs.promises);
    let injectedReplacement = false;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      const shouldInject = !injectedReplacement && String(from) === lockPath;
      switch (shouldInject) {
        case true:
          injectedReplacement = true;
          fs.unlinkSync(lockPath);
          fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);
      }
      return rename(from, to);
    });

    try {
      await expect(
        lifecycleLock.withMcpLifecycleLock("alpha", () => undefined, options({ timeoutMs: 50 })),
      ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");
    } finally {
      renameSpy.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("replacement-main-token");
  });

  it.skipIf(currentProcessIdentity === null)(
    "recovers a recycled PID by comparing process-start identity",
    async () => {
      const lockPath = lifecycleLock.getMcpLifecycleLockPath("alpha", stateDir);
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
});
