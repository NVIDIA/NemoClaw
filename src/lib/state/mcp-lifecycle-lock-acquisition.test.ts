// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginCommittedMcpLifecycleContainmentSync,
  durableMcpLifecycleContainmentFailure,
  isMcpLifecycleLockHeld,
  localAbandonedTimerGeneration,
  withMcpLifecycleDeadlineFence,
  withMcpLifecycleDeadlineFenceSync,
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "./mcp-lifecycle-lock-acquisition";
import { localTimerProcessStartIdentity } from "./mcp-lifecycle-lock/shields-timer-authority";
import {
  createMcpLifecycleLockOwner,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
} from "./mcp-lifecycle-lock-identity";
import { getMcpLifecycleLockPath } from "./mcp-lifecycle-lock-storage";

const SANDBOX_NAME = "alpha";
let stateDir: string;

type LockExecutor = {
  label: string;
  run: <T>(operation: () => T, overrides?: Record<string, unknown>) => Promise<T>;
};

function options() {
  return {
    stateDir,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
    corruptLockGraceMs: 1,
  };
}

function writeTimerMarker(
  processToken: string | undefined,
  restoreAt = new Date(Date.now() + 60_000).toISOString(),
  pid = process.pid,
  extra: Record<string, unknown> = {},
): void {
  fs.writeFileSync(
    path.join(stateDir, `shields-timer-${SANDBOX_NAME}.json`),
    JSON.stringify({
      pid,
      sandboxName: SANDBOX_NAME,
      snapshotPath: path.join(stateDir, "snapshot.yaml"),
      restoreAt,
      ...(processToken ? { processToken } : {}),
      ...extra,
    }),
  );
}

function writeStaleMainOwner(shieldsTakeoverToken?: string): string {
  const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      version: 1,
      sandboxName: SANDBOX_NAME,
      pid: 2_147_483_647,
      processIdentity: "dead-process",
      hostIdentity: readMcpLockHostIdentity(),
      pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
      ...(shieldsTakeoverToken ? { shieldsTakeoverToken } : {}),
      token: "stale-main-token",
      acquiredAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  return lockPath;
}

function writeStructuredCompletedContainment(
  processToken: string,
  containedToken = "stale-main-token",
): { containmentPath: string; lockPath: string } {
  const lockPath = writeStaleMainOwner(processToken);
  const containmentPath = `${lockPath}.containment`;
  const mainStat = fs.statSync(lockPath);
  fs.writeFileSync(
    containmentPath,
    JSON.stringify({
      ...createMcpLifecycleLockOwner(SANDBOX_NAME, "structured-containment", processToken),
      pid: 2_147_483_646,
      processIdentity: "dead-containment-owner",
      containmentReason: "Human-readable containment diagnostics may change independently",
      containedGeneration: {
        target: "main",
        dev: mainStat.dev,
        ino: mainStat.ino,
        token: containedToken,
        ownerPid: 2_147_483_647,
      },
    }),
  );
  return { containmentPath, lockPath };
}

function writeOwnerAt(lockPath: string, token: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify(createMcpLifecycleLockOwner(SANDBOX_NAME, token))}\n`,
  );
}

const lockExecutors: LockExecutor[] = [
  {
    label: "asynchronous",
    run: (operation, overrides = {}) =>
      withMcpLifecycleLock(SANDBOX_NAME, operation, { ...options(), ...overrides }),
  },
  {
    label: "synchronous",
    run: (operation, overrides = {}) =>
      Promise.resolve().then(() =>
        withMcpLifecycleLockSync(SANDBOX_NAME, operation, { ...options(), ...overrides }),
      ),
  },
];

function publishTimerWhenStaleOwnerIsObserved(processToken: string): ReturnType<typeof vi.fn> {
  const realProcessKill = process.kill.bind(process);
  const processKill = vi
    .fn((pid: number, signal?: string | number) => realProcessKill(pid, signal as never))
    .mockImplementationOnce((pid: number, signal?: string | number) => {
      expect(pid).toBe(2_147_483_647);
      expect(signal).toBe(0);
      writeTimerMarker(processToken);
      const error = new Error("stale owner exited") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
  vi.spyOn(process, "kill").mockImplementation(processKill);
  return processKill;
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-acquisition-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("MCP lifecycle lock acquisition", () => {
  describe.each(lockExecutors)("$label parity", ({ run }) => {
    it("acquires one generation and releases it after ordinary work", async () => {
      const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
      const operation = vi.fn(() => {
        expect(fs.existsSync(lockPath)).toBe(true);
        return "complete";
      });

      await expect(run(operation)).resolves.toBe("complete");

      expect(operation).toHaveBeenCalledOnce();
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it.each(["main", "reaper", "deadline"])(
      "denies entry while an active %s generation owns the gate",
      async (generation) => {
        const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
        const generationPaths = new Map([
          ["main", lockPath],
          ["reaper", `${lockPath}.reaper`],
          ["deadline", `${lockPath}.deadline`],
        ]);
        const operation = vi.fn(() => "must not enter");
        writeOwnerAt(generationPaths.get(generation)!, `active-${generation}-token`);

        await expect(
          run(operation, {
            timeoutMs: 10,
            monotonicNow: (() => {
              let now = 0;
              return () => now++;
            })(),
          }),
        ).rejects.toThrow(/Timed out waiting for (the )?sandbox mutation lock/);

        expect(operation).not.toHaveBeenCalled();
        expect(fs.existsSync(generationPaths.get(generation)!)).toBe(true);
      },
    );

    it("waits through corruption grace without reclaiming an unverifiable generation", async () => {
      const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
      const operation = vi.fn(() => "must not enter");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, "{truncated");
      let now = 0;

      await expect(
        run(operation, {
          corruptLockGraceMs: 100,
          timeoutMs: 10,
          monotonicNow: () => now++,
        }),
      ).rejects.toThrow(/Timed out waiting for (the )?sandbox mutation lock/);

      expect(operation).not.toHaveBeenCalled();
      expect(fs.readFileSync(lockPath, "utf8")).toBe("{truncated");
    });

    it("reclaims an exact stale ordinary generation before entering", async () => {
      const lockPath = writeStaleMainOwner();
      const operation = vi.fn(() => "entered");

      await expect(run(operation, { timeoutMs: 2_000 })).resolves.toBe("entered");

      expect(operation).toHaveBeenCalledOnce();
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(`${lockPath}.reaper`)).toBe(false);
    });

    it("keeps committed containment authoritative", async () => {
      const processToken = "c".repeat(32);
      const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
      const operation = vi.fn(() => "must not enter");
      writeTimerMarker(processToken);
      beginCommittedMcpLifecycleContainmentSync(
        SANDBOX_NAME,
        processToken,
        "test containment",
        stateDir,
      );

      await expect(run(operation)).rejects.toThrow("Sandbox mutation containment is active");

      expect(operation).not.toHaveBeenCalled();
      expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
    });

    it("does not release a replacement generation after work completes", async () => {
      const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
      const replacementToken = "replacement-generation";

      await expect(
        run(() => {
          writeOwnerAt(lockPath, replacementToken);
          return "complete";
        }),
      ).resolves.toBe("complete");

      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
        token: replacementToken,
      });
    });
  });

  it("keeps ordinary acquisition closed after an unpublished timer deadline", async () => {
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("1".repeat(32), new Date(Date.now() - 1_000).toISOString());

    await expect(withMcpLifecycleLock(SANDBOX_NAME, operation, options())).rejects.toThrow(
      "Timed out waiting for the sandbox mutation lock",
    );

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
  });

  it("rejects asynchronous entry after its published generation is replaced", async () => {
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const realLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementationOnce(async (candidatePath, targetPath) => {
      await realLink(candidatePath, targetPath);
      await fs.promises.rm(targetPath);
      writeOwnerAt(String(targetPath), "replacement-generation");
    });

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, operation, { ...options(), timeoutMs: 10 }),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      token: "replacement-generation",
    });
  });

  it("keeps ordinary acquisition closed after a dead timer misses its deadline", async () => {
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("2".repeat(32), new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);

    await expect(withMcpLifecycleLock(SANDBOX_NAME, operation, options())).rejects.toThrow(
      "Timed out waiting for the sandbox mutation lock",
    );

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("recovers through the deadline fence after an abandoned timer deadline", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("4".repeat(32), new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, () => "entered", {
        ...options(),
        recoverAbandonedExpiredTimer: true,
      }),
    ).resolves.toBe("entered");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("recovers through the deadline fence when a live PID's recorded ps identity no longer matches", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("9".repeat(32), new Date(Date.now() - 1_000).toISOString(), process.pid, {
      timerProcessStartIdentity: "ps:recorded",
    });
    vi.spyOn(localTimerProcessStartIdentity, "read").mockReturnValue("ps:observed");

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, () => "entered", {
        ...options(),
        recoverAbandonedExpiredTimer: true,
      }),
    ).resolves.toBe("entered");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("restarts abandoned-timer grace when a replacement generation appears", async () => {
    const operation = vi.fn(() => "entered");
    writeTimerMarker("a".repeat(32), new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    const pending = withMcpLifecycleLock(SANDBOX_NAME, operation, {
      ...options(),
      recoverAbandonedExpiredTimer: true,
      pollIntervalMs: 15,
      timeoutMs: 5_000,
      corruptLockGraceMs: 80,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeTimerMarker("b".repeat(32), new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(operation).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe("entered");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("restarts asynchronous recovery grace after confirmation observes a replacement generation (#10066)", async () => {
    const tokenA = "a".repeat(32);
    const tokenB = "b".repeat(32);
    writeTimerMarker(tokenA, new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    const snapA = { token: tokenA, key: `${tokenA}:2147483647:` };
    const snapB = { token: tokenB, key: `${tokenB}:2147483647:` };
    const observations = [snapA, snapA, snapB, snapA, snapA, snapA];
    let reads = 0;
    vi.spyOn(localAbandonedTimerGeneration, "read").mockImplementation(() => {
      const observation = observations[Math.min(reads, observations.length - 1)]!;
      reads += 1;
      return observation;
    });
    const operation = vi.fn(() => "entered");
    let monotonicNow = 0;

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, operation, {
        ...options(),
        recoverAbandonedExpiredTimer: true,
        corruptLockGraceMs: 2,
        monotonicNow: () => monotonicNow++,
      }),
    ).resolves.toBe("entered");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(monotonicNow).toBeGreaterThan(2);
  });

  it("keeps waiting when an expired timer's process is still alive", async () => {
    const operation = vi.fn(() => "must not enter");
    writeTimerMarker("5".repeat(32), new Date(Date.now() - 1_000).toISOString());

    await expect(withMcpLifecycleLock(SANDBOX_NAME, operation, options())).rejects.toThrow(
      "Timed out waiting for the sandbox mutation lock",
    );

    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects synchronous entry after its published generation is replaced", () => {
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const realLinkSync = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementationOnce((candidatePath, targetPath) => {
      realLinkSync(candidatePath, targetPath);
      fs.rmSync(targetPath);
      writeOwnerAt(String(targetPath), "replacement-generation");
    });

    expect(() =>
      withMcpLifecycleLockSync(SANDBOX_NAME, operation, { ...options(), timeoutMs: 10 }),
    ).toThrow("Timed out waiting for sandbox mutation lock");

    expect(operation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      token: "replacement-generation",
    });
  });

  it("releases an asynchronous deadline generation when authority changes after publication", async () => {
    const processToken = "3".repeat(32);
    const replacementToken = "4".repeat(32);
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    const realLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementationOnce(async (candidatePath, targetPath) => {
      await realLink(candidatePath, targetPath);
      writeTimerMarker(replacementToken);
    });

    await expect(
      withMcpLifecycleDeadlineFence(SANDBOX_NAME, processToken, operation, options()),
    ).rejects.toThrow("Auto-restore authority changed");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases a synchronous deadline generation when authority changes after publication", () => {
    const processToken = "5".repeat(32);
    const replacementToken = "6".repeat(32);
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    const realLinkSync = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync").mockImplementationOnce((candidatePath, targetPath) => {
      realLinkSync(candidatePath, targetPath);
      writeTimerMarker(replacementToken);
    });

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, options()),
    ).toThrow("Auto-restore authority changed");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(deadlinePath)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases an ambiguously published async main generation after authority changes", async () => {
    const processToken = "7".repeat(32);
    const replacementToken = "8".repeat(32);
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    const realLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link")
      .mockImplementationOnce((candidatePath, targetPath) => realLink(candidatePath, targetPath))
      .mockImplementationOnce(async (candidatePath, targetPath) => {
        await realLink(candidatePath, targetPath);
        writeTimerMarker(replacementToken);
        vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(
          new Error("publication reconciliation unavailable"),
        );
        throw new Error("publication reply lost");
      });

    await expect(
      withMcpLifecycleDeadlineFence(SANDBOX_NAME, processToken, operation, options()),
    ).rejects.toThrow("Auto-restore authority changed");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
  });

  it("releases an ambiguously published sync main generation after authority changes", () => {
    const processToken = "9".repeat(32);
    const replacementToken = "a".repeat(32);
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    const realLinkSync = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync")
      .mockImplementationOnce((candidatePath, targetPath) =>
        realLinkSync(candidatePath, targetPath),
      )
      .mockImplementationOnce((candidatePath, targetPath) => {
        realLinkSync(candidatePath, targetPath);
        writeTimerMarker(replacementToken);
        vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
          throw new Error("publication reconciliation unavailable");
        });
        throw new Error("publication reply lost");
      });

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, options()),
    ).toThrow("Auto-restore authority changed");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
  });

  it("does not strand asynchronous recovery behind an expired legacy marker", async () => {
    writeTimerMarker(undefined, new Date(Date.now() - 1_000).toISOString());

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, () => "entered", {
        ...options(),
        monotonicNow: () => 0,
      }),
    ).resolves.toBe("entered");
  });

  it("does not strand synchronous recovery behind an expired legacy short-token marker", () => {
    writeTimerMarker("legacy-token", new Date(Date.now() - 1_000).toISOString());

    // Drive the deadline from a stepping clock: marker recovery does real
    // filesystem work, and a loaded CI runner can exceed the real 1-second
    // budget (NVIDIA/NemoClaw#8900 shard 11). Unlike the async sibling's
    // pinned clock, stepping keeps a genuine strand bounded — the budget
    // still expires after 1,000 clock reads instead of blocking the worker.
    let tick = 0;
    expect(
      withMcpLifecycleLockSync(SANDBOX_NAME, () => "entered", {
        ...options(),
        monotonicNow: () => tick++,
      }),
    ).toBe("entered");
  });

  it("rejects asynchronous admission when restoreAt passes after main publication", async () => {
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const beforeDeadline = Date.now();
    writeTimerMarker("3".repeat(32), new Date(beforeDeadline + 500).toISOString());
    const linkSpy = vi.spyOn(fs.promises, "link");
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(beforeDeadline)
      .mockReturnValueOnce(beforeDeadline)
      .mockReturnValue(beforeDeadline + 1_000);

    await expect(withMcpLifecycleLock(SANDBOX_NAME, operation, options())).rejects.toThrow(
      "Timed out waiting for the sandbox mutation lock",
    );

    expect(linkSpy).toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("holds ordinary admission for abandoned-timer grace when restoreAt crosses after the gate", async () => {
    const operation = vi.fn(() => "must not enter");
    const beforeDeadline = Date.now();
    writeTimerMarker("9".repeat(32), new Date(beforeDeadline + 500).toISOString(), 2_147_483_647);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(beforeDeadline)
      .mockReturnValue(beforeDeadline + 1_000);

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, operation, {
        ...options(),
        timeoutMs: 200,
        corruptLockGraceMs: 10_000,
      }),
    ).rejects.toThrow("Timed out waiting for the sandbox mutation lock");

    expect(operation).not.toHaveBeenCalled();
  });

  it("releases a synchronous lock after nested work completes", () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const events: string[] = [];

    const result = withMcpLifecycleLockSync(
      SANDBOX_NAME,
      () => {
        expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
        events.push("outer");
        return withMcpLifecycleLockSync(
          SANDBOX_NAME,
          () => {
            expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
            events.push("nested");
            return "complete";
          },
          options(),
        );
      },
      options(),
    );

    expect(result).toBe("complete");
    expect(events).toEqual(["outer", "nested"]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("allows a nested synchronous lock during deadline recovery and releases the main lock and deadline gate afterward", () => {
    const processToken = "a".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);

    const result = withMcpLifecycleDeadlineFenceSync(
      SANDBOX_NAME,
      processToken,
      () => {
        expect(isMcpLifecycleLockHeld(SANDBOX_NAME, stateDir)).toBe(true);
        return withMcpLifecycleLockSync(SANDBOX_NAME, () => "restored", options());
      },
      options(),
    );

    expect(result).toBe("restored");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
  });

  it("releases the synchronous deadline and main generations after an ordinary error", () => {
    const processToken = "e".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(
        SANDBOX_NAME,
        processToken,
        () => {
          throw new Error("ordinary recovery failure");
        },
        options(),
      ),
    ).toThrow("ordinary recovery failure");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
  });

  it("denies completed auto-restore cleanup while the exact timer owner is still live", () => {
    const processToken = "c".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify(createMcpLifecycleLockOwner(SANDBOX_NAME, "live-main", processToken)),
    );
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: process.pid,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("main generation is not the exact stale timer owner");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("preserves a terminal auto-restore containment with the same timer token", () => {
    const processToken = "d".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const containmentPath = `${lockPath}.containment`;
    writeTimerMarker(processToken);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      containmentPath,
      JSON.stringify({
        ...createMcpLifecycleLockOwner(SANDBOX_NAME, "terminal-containment", processToken),
        pid: 2_147_483_647,
        processIdentity: "dead-containment-owner",
        containmentReason:
          "Auto-restore recovery failed while the exact timer generation still owned recovery authority",
      }),
    );
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_646,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("does not identify a recoverable completed timer generation");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(containmentPath)).toBe(true);
  });

  it("recovers from structured containment independently of diagnostic wording", () => {
    const processToken = "e".repeat(32);
    writeTimerMarker(processToken, new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    const paths = writeStructuredCompletedContainment(processToken);

    expect(
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, () => "complete", {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_647,
          assertAuthority: vi.fn(),
        },
      }),
    ).toBe("complete");
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.existsSync(paths.containmentPath)).toBe(false);
  });

  it("uses completed auto-restore authority when the canonical timer marker is unavailable", () => {
    const processToken = "e".repeat(32);
    const paths = writeStructuredCompletedContainment(processToken);
    const assertAuthority = vi.fn();

    expect(
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, () => "complete", {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_647,
          assertAuthority,
        },
      }),
    ).toBe("complete");
    expect(assertAuthority).toHaveBeenCalled();
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(fs.existsSync(paths.containmentPath)).toBe(false);
  });

  it("cleans an ambiguously published main generation before refusing completed recovery authority", () => {
    const processToken = "e".repeat(32);
    const operation = vi.fn(() => "must not enter");
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    let authorityCurrent = true;
    const assertAuthority = vi.fn(() => expect(authorityCurrent).toBe(true));
    const realLinkSync = fs.linkSync.bind(fs);
    vi.spyOn(fs, "linkSync")
      .mockImplementationOnce((candidatePath, targetPath) =>
        realLinkSync(candidatePath, targetPath),
      )
      .mockImplementationOnce((candidatePath, targetPath) => {
        realLinkSync(candidatePath, targetPath);
        authorityCurrent = false;
        vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
          throw new Error("publication reconciliation unavailable");
        });
        throw new Error("publication reply lost");
      });

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_647,
          assertAuthority,
        },
      }),
    ).toThrow("Auto-restore authority changed");

    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
  });

  it("preserves structured containment when its protected generation is absent", () => {
    const processToken = "e".repeat(32);
    writeTimerMarker(processToken, new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    const paths = writeStructuredCompletedContainment(processToken);
    fs.unlinkSync(paths.lockPath);
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_647,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("structured containment has no remaining main generation to verify");
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.containmentPath)).toBe(true);
  });

  it("preserves containment whose structured generation does not match", () => {
    const processToken = "e".repeat(32);
    writeTimerMarker(processToken, new Date(Date.now() - 1_000).toISOString(), 2_147_483_647);
    const paths = writeStructuredCompletedContainment(processToken, "different-main-token");
    const operation = vi.fn();

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        completedAutoRestoreRecovery: {
          ownerPid: 2_147_483_647,
          assertAuthority: vi.fn(),
        },
      }),
    ).toThrow("contained lifecycle generation changed");
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.containmentPath)).toBe(true);
  });

  it("retains exact synchronous deadline and main generations after an uncommitted durable-containment failure", () => {
    const processToken = "f".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const onReleased = vi.fn();
    writeTimerMarker(processToken);

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(
        SANDBOX_NAME,
        processToken,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("containment state is read-only"),
            lockPath,
          );
        },
        { ...options(), onReleased },
      ),
    ).toThrow("containment state is read-only");

    const mainOwner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const deadlineOwner = JSON.parse(fs.readFileSync(deadlinePath, "utf8"));
    expect(mainOwner).toMatchObject({
      sandboxName: SANDBOX_NAME,
      pid: process.pid,
      shieldsTakeoverToken: processToken,
    });
    expect(deadlineOwner).toMatchObject({
      sandboxName: SANDBOX_NAME,
      pid: process.pid,
      shieldsTakeoverToken: processToken,
    });
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
    expect(onReleased).not.toHaveBeenCalled();
  });

  it("releases owned generations when committed containment is proven present", () => {
    const processToken = "1".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(
        SANDBOX_NAME,
        processToken,
        () => {
          beginCommittedMcpLifecycleContainmentSync(
            SANDBOX_NAME,
            processToken,
            "test containment",
            stateDir,
          );
          throw durableMcpLifecycleContainmentFailure(
            new Error("containment reporting stopped"),
            lockPath,
          );
        },
        options(),
      ),
    ).toThrow("containment reporting stopped");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("releases async owned generations when committed containment is proven present", async () => {
    const processToken = "a".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);

    await expect(
      withMcpLifecycleDeadlineFence(
        SANDBOX_NAME,
        processToken,
        () => {
          beginCommittedMcpLifecycleContainmentSync(
            SANDBOX_NAME,
            processToken,
            "test async containment",
            stateDir,
          );
          throw durableMcpLifecycleContainmentFailure(
            new Error("async containment reporting stopped"),
            lockPath,
          );
        },
        options(),
      ),
    ).rejects.toThrow("async containment reporting stopped");

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("retains owned generations when committed containment cannot be inspected", () => {
    const processToken = "2".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const containmentPath = `${lockPath}.containment`;
    const realLstatSync = fs.lstatSync.bind(fs);
    let denyContainmentInspection = false;
    const rejectContainmentInspection = (): never => {
      const error = new Error("containment inspection denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    };
    vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      return denyContainmentInspection && String(target) === containmentPath
        ? rejectContainmentInspection()
        : realLstatSync(target, options as never);
    });
    writeTimerMarker(processToken);

    expect(() =>
      withMcpLifecycleDeadlineFenceSync(
        SANDBOX_NAME,
        processToken,
        () => {
          denyContainmentInspection = true;
          throw durableMcpLifecycleContainmentFailure(
            new Error("containment commit could not be verified"),
            lockPath,
          );
        },
        options(),
      ),
    ).toThrow("containment commit could not be verified");

    denyContainmentInspection = false;
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(true);
  });

  it("retains an async lifecycle generation only for an uncommitted coded failure", async () => {
    const retainedLockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("8".repeat(32));

    await expect(
      withMcpLifecycleLock(
        SANDBOX_NAME,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("nested containment commit failed"),
            retainedLockPath,
          );
        },
        options(),
      ),
    ).rejects.toThrow("nested containment commit failed");
    expect(fs.existsSync(retainedLockPath)).toBe(true);

    fs.rmSync(retainedLockPath, { force: true });
    await expect(
      withMcpLifecycleLock(
        SANDBOX_NAME,
        () => {
          throw new Error("ordinary nested failure");
        },
        options(),
      ),
    ).rejects.toThrow("ordinary nested failure");
    expect(fs.existsSync(retainedLockPath)).toBe(false);
  });

  it("retains a synchronous lifecycle generation only for an uncommitted coded failure", () => {
    const retainedLockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker("9".repeat(32));

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX_NAME,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("synchronous nested containment commit failed"),
            retainedLockPath,
          );
        },
        options(),
      ),
    ).toThrow("synchronous nested containment commit failed");
    expect(fs.existsSync(retainedLockPath)).toBe(true);

    fs.rmSync(retainedLockPath, { force: true });
    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX_NAME,
        () => {
          throw new Error("ordinary synchronous nested failure");
        },
        options(),
      ),
    ).toThrow("ordinary synchronous nested failure");
    expect(fs.existsSync(retainedLockPath)).toBe(false);
  });

  it("retains a timer-bound lifecycle generation when nested code handles the containment failure", () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const processToken = "4".repeat(32);
    writeTimerMarker(processToken);

    const result = withMcpLifecycleLockSync(
      SANDBOX_NAME,
      () => {
        try {
          throw durableMcpLifecycleContainmentFailure(
            new Error("nested containment commit failed"),
            lockPath,
          );
        } catch {
          return "handled";
        }
      },
      options(),
    );

    expect(result).toBe("handled");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      sandboxName: SANDBOX_NAME,
      shieldsTakeoverToken: processToken,
    });
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("retains an async timer-bound lifecycle generation when nested code handles the containment failure", async () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const processToken = "5".repeat(32);
    writeTimerMarker(processToken);

    const result = await withMcpLifecycleLock(
      SANDBOX_NAME,
      async () => {
        try {
          throw durableMcpLifecycleContainmentFailure(
            new Error("nested async containment commit failed"),
            lockPath,
          );
        } catch {
          await Promise.resolve();
          return "handled";
        }
      },
      options(),
    );

    expect(result).toBe("handled");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      sandboxName: SANDBOX_NAME,
      shieldsTakeoverToken: processToken,
    });
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("releases a non-timer-bound lifecycle generation after a coded containment failure", () => {
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);

    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX_NAME,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("non-timer containment failure"),
            lockPath,
          );
        },
        options(),
      ),
    ).toThrow("non-timer containment failure");

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("contains a retained timer-bound main generation after its owner exits", () => {
    const processToken = "a".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);
    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX_NAME,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("retain this timer-bound generation"),
            lockPath,
          );
        },
        options(),
      ),
    ).toThrow("retain this timer-bound generation");
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      shieldsTakeoverToken: processToken,
    });

    const realProcessKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      const failRetainedOwnerProbe = () => {
        const error = new Error("retained owner exited") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      };
      const retainedOwnerProbe =
        pid === process.pid && signal === 0 ? failRetainedOwnerProbe : undefined;
      retainedOwnerProbe?.();
      return realProcessKill(pid, signal as never);
    });
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    expect(() => withMcpLifecycleLockSync(SANDBOX_NAME, () => "must not enter", options())).toThrow(
      "Sandbox mutation containment is active",
    );
    expect(waitSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("returns operator guidance after recording durable containment for a stale deadline generation", () => {
    const processToken = "6".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    const operation = vi.fn();
    const containmentReasons: string[] = [];
    writeTimerMarker(processToken);
    fs.mkdirSync(path.dirname(deadlinePath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      JSON.stringify({
        ...createMcpLifecycleLockOwner(SANDBOX_NAME, "stale-deadline-token", processToken),
        pid: 2_147_483_647,
        processIdentity: "dead-process",
      }),
    );

    let failure: unknown;
    try {
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        throwOnCommittedContainment: true,
        onContainment: ({ reason }) => containmentReasons.push(reason),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "NEMOCLAW_DURABLE_CONTAINMENT" });
    expect(String(failure)).toContain(
      "A committed process-tree containment requires operator resolution",
    );
    expect(containmentReasons).toEqual([
      expect.stringContaining("remove only the exact stale owner generations"),
    ]);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(deadlinePath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("returns operator guidance after recording durable containment for a stale timer-bound main generation", () => {
    const processToken = "b".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const operation = vi.fn();
    const containmentReasons: string[] = [];
    writeTimerMarker(processToken);
    writeStaleMainOwner(processToken);

    let failure: unknown;
    try {
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, operation, {
        ...options(),
        throwOnCommittedContainment: true,
        onContainment: ({ reason }) => containmentReasons.push(reason),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "NEMOCLAW_DURABLE_CONTAINMENT" });
    expect(String(failure)).toContain("remove only the exact stale owner generations");
    expect(containmentReasons).toEqual([
      expect.stringContaining("remove only the exact stale owner generations"),
    ]);
    expect(operation).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("retains async deadline generations only for an uncommitted coded failure", async () => {
    const processToken = "7".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);

    await expect(
      withMcpLifecycleDeadlineFence(
        SANDBOX_NAME,
        processToken,
        () => {
          throw durableMcpLifecycleContainmentFailure(
            new Error("async deadline containment commit failed"),
            lockPath,
          );
        },
        options(),
      ),
    ).rejects.toThrow("async deadline containment commit failed");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(deadlinePath)).toBe(true);

    fs.rmSync(lockPath, { force: true });
    fs.rmSync(deadlinePath, { force: true });
    await expect(
      withMcpLifecycleDeadlineFence(
        SANDBOX_NAME,
        processToken,
        () => {
          throw new Error("ordinary async deadline failure");
        },
        options(),
      ),
    ).rejects.toThrow("ordinary async deadline failure");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(deadlinePath)).toBe(false);
  });

  it("runs deadline release completion only after exact gates are absent (#9750)", async () => {
    const processToken = "8".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    const onReleased = vi.fn(() => {
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(deadlinePath)).toBe(false);
    });

    await expect(
      withMcpLifecycleDeadlineFence(SANDBOX_NAME, processToken, () => "complete", {
        ...options(),
        onReleased,
      }),
    ).resolves.toBe("complete");
    expect(onReleased).toHaveBeenCalledOnce();
  });

  it("runs synchronous release completion only after exact gates are absent (#10094)", () => {
    const processToken = "9".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);
    const onReleased = vi.fn(() => {
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
    });

    expect(
      withMcpLifecycleDeadlineFenceSync(SANDBOX_NAME, processToken, () => "complete", {
        ...options(),
        onReleased,
      }),
    ).toBe("complete");
    expect(onReleased).toHaveBeenCalledOnce();
  });

  it("contains a stale async main generation that records a rotated Shields timer token", async () => {
    const ownerToken = "3".repeat(32);
    const currentToken = "4".repeat(32);
    const lockPath = writeStaleMainOwner(ownerToken);
    writeTimerMarker(currentToken);
    let entered = false;

    await expect(
      withMcpLifecycleLock(
        SANDBOX_NAME,
        () => {
          entered = true;
        },
        options(),
      ),
    ).rejects.toThrow("Sandbox mutation containment is active");

    expect(entered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("contains a stale synchronous main generation that records the current Shields timer token", () => {
    const processToken = "5".repeat(32);
    const lockPath = writeStaleMainOwner(processToken);
    writeTimerMarker(processToken);

    expect(() => withMcpLifecycleLockSync(SANDBOX_NAME, () => "entered", options())).toThrow(
      "Sandbox mutation containment is active",
    );

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("contains a stale async owner acquired before its Shields timer marker appears", async () => {
    const processToken = "6".repeat(32);
    const lockPath = writeStaleMainOwner();
    const operation = vi.fn();
    const processKill = publishTimerWhenStaleOwnerIsObserved(processToken);

    await expect(
      withMcpLifecycleLock(SANDBOX_NAME, operation, {
        ...options(),
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("Sandbox mutation containment is active");

    expect(operation).not.toHaveBeenCalled();
    expect(processKill).toHaveBeenCalledWith(2_147_483_647, 0);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${lockPath}.containment`, "utf8"))).toMatchObject({
      sandboxName: SANDBOX_NAME,
      shieldsTakeoverToken: processToken,
      containmentReason: expect.stringContaining("timer-bound sandbox mutation owner exited"),
      containedGeneration: {
        target: "main",
        dev: expect.any(Number),
        ino: expect.any(Number),
        token: "stale-main-token",
        ownerPid: 2_147_483_647,
      },
    });
  });

  it("contains a stale synchronous owner acquired before its Shields timer marker appears", () => {
    const processToken = "7".repeat(32);
    const lockPath = writeStaleMainOwner();
    const operation = vi.fn();
    const processKill = publishTimerWhenStaleOwnerIsObserved(processToken);

    expect(() =>
      withMcpLifecycleLockSync(SANDBOX_NAME, operation, {
        ...options(),
        timeoutMs: 2_000,
      }),
    ).toThrow("Sandbox mutation containment is active");

    expect(operation).not.toHaveBeenCalled();
    expect(processKill).toHaveBeenCalledWith(2_147_483_647, 0);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${lockPath}.containment`, "utf8"))).toMatchObject({
      sandboxName: SANDBOX_NAME,
      shieldsTakeoverToken: processToken,
      containmentReason: expect.stringContaining("timer-bound sandbox mutation owner exited"),
      containedGeneration: {
        target: "main",
        dev: expect.any(Number),
        ino: expect.any(Number),
        token: "stale-main-token",
        ownerPid: 2_147_483_647,
      },
    });
  });

  it("reclaims a stale main generation with no Shields timer authority", () => {
    const lockPath = writeStaleMainOwner();

    expect(
      withMcpLifecycleLockSync(SANDBOX_NAME, () => "entered", {
        ...options(),
        timeoutMs: 2_000,
      }),
    ).toBe("entered");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
  });

  it("blocks synchronous mutation while committed containment is active", () => {
    const processToken = "b".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    writeTimerMarker(processToken);
    beginCommittedMcpLifecycleContainmentSync(
      SANDBOX_NAME,
      processToken,
      "test containment",
      stateDir,
    );

    expect(() => withMcpLifecycleLockSync(SANDBOX_NAME, () => "entered", options())).toThrow(
      "Sandbox mutation containment is active",
    );
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(true);
  });

  it("keeps an active deadline gate closed when containment reporting fails", async () => {
    const processToken = "c".repeat(32);
    const replacementToken = "d".repeat(32);
    const lockPath = getMcpLifecycleLockPath(SANDBOX_NAME, stateDir);
    const deadlinePath = `${lockPath}.deadline`;
    writeTimerMarker(processToken);
    fs.mkdirSync(path.dirname(deadlinePath), { recursive: true });
    fs.writeFileSync(
      deadlinePath,
      `${JSON.stringify(
        createMcpLifecycleLockOwner(SANDBOX_NAME, "active-deadline-owner", processToken),
      )}\n`,
    );
    const onContainment = vi.fn(() => {
      writeTimerMarker(replacementToken);
      throw new Error("audit unavailable");
    });

    await expect(
      withMcpLifecycleDeadlineFence(SANDBOX_NAME, processToken, () => "entered", {
        ...options(),
        onContainment,
      }),
    ).rejects.toThrow("Auto-restore authority changed");
    expect(onContainment).toHaveBeenCalledOnce();
    expect(fs.existsSync(deadlinePath)).toBe(true);
  });
});
