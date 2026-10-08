// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  pausePortableHostLockOwner,
  type PortableHostLockBarrierDeps,
} from "./mcp-bridge-portable-lock-barrier.ts";

const PID = 4242;
const START_TICK = "987654";
const BOOT_ID = "11111111-2222-4333-8444-555555555555";
const COMMAND_PATH = "/workspace/bin/nemoclaw.js";
const COMMAND_ARGS = [
  "e2e-mcp-hermes",
  "mcp",
  "add",
  "concurrent",
  "--url",
  "https://mcp.example.test/mcp",
  "--env",
  "FAKE_MCP_SECRET",
] as const;

interface BarrierFixture {
  readonly bootIdPath: string;
  readonly homeDir: string;
  readonly lockDir: string;
  readonly procDir: string;
  readonly procRoot: string;
  readonly root: string;
  readonly writeProcessState: (state: string) => void;
}

const roots: string[] = [];

function processStat(state: string, startTick = START_TICK): string {
  return `${String(PID)} (node) ${[state, ...Array(18).fill("0"), startTick].join(" ")}\n`;
}

function createBarrierFixture(
  options: { commandArgs?: readonly string[]; startTick?: string } = {},
): BarrierFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-lock-barrier-"));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const lockDir = path.join(homeDir, ".nemoclaw-portable-host.lock");
  const procRoot = path.join(root, "proc");
  const procDir = path.join(procRoot, String(PID));
  const bootIdPath = path.join(root, "boot_id");
  fs.mkdirSync(lockDir, { mode: 0o700, recursive: true });
  fs.mkdirSync(procDir, { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), `${String(PID)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(lockDir, "process-start"),
    `${String(PID)} ${BOOT_ID} ${options.startTick ?? START_TICK}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(bootIdPath, `${BOOT_ID}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(procDir, "cmdline"),
    Buffer.from(
      ["/usr/bin/node", COMMAND_PATH, ...(options.commandArgs ?? COMMAND_ARGS), ""].join("\0"),
    ),
    { mode: 0o600 },
  );
  const writeProcessState = (state: string) =>
    fs.writeFileSync(path.join(procDir, "stat"), processStat(state), { mode: 0o600 });
  writeProcessState("S");
  return { bootIdPath, homeDir, lockDir, procDir, procRoot, root, writeProcessState };
}

function fakeTiming(fixture: BarrierFixture, onStop?: () => void) {
  let nowMs = 1_000;
  const signals: NodeJS.Signals[] = [];
  const deps: PortableHostLockBarrierDeps = {
    bootIdPath: fixture.bootIdPath,
    now: () => nowMs,
    procRoot: fixture.procRoot,
    signal: (_pid, signal) => {
      signals.push(signal);
      const stop = (): void => {
        fixture.writeProcessState("T");
        onStop?.();
      };
      const resume = (): void => fixture.writeProcessState("S");
      (signal === "SIGSTOP" ? stop : resume)();
    },
    sleep: async (durationMs) => {
      nowMs += durationMs;
    },
  };
  return { deps, signals };
}

function options(fixture: BarrierFixture) {
  return { commandArgs: COMMAND_ARGS, commandPath: COMMAND_PATH, homeDir: fixture.homeDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("MCP Portable host lock overlap barrier", () => {
  it("stops and resumes the exact authenticated first add", async () => {
    const fixture = createBarrierFixture();
    const timing = fakeTiming(fixture);

    const barrier = await pausePortableHostLockOwner(options(fixture), timing.deps);
    expect(barrier.pid).toBe(PID);
    expect(timing.signals).toEqual(["SIGSTOP"]);

    await barrier.resume();
    await barrier.resume();
    expect(timing.signals).toEqual(["SIGSTOP", "SIGCONT"]);
  });

  it("rejects a lock owner whose command line is not the exact first add", async () => {
    const fixture = createBarrierFixture({ commandArgs: [...COMMAND_ARGS, "--force"] });
    const timing = fakeTiming(fixture);

    await expect(pausePortableHostLockOwner(options(fixture), timing.deps)).rejects.toThrow(
      "does not match the exact first MCP add",
    );
    expect(timing.signals).toEqual([]);
  });

  it("bounds the wait when the first add never publishes a lock owner", async () => {
    const fixture = createBarrierFixture();
    fs.rmSync(fixture.lockDir, { force: true, recursive: true });
    const timing = fakeTiming(fixture);

    await expect(pausePortableHostLockOwner(options(fixture), timing.deps)).rejects.toThrow(
      "did not publish an authenticated Portable host lock owner",
    );
    expect(timing.deps.now?.()).toBe(31_000);
    expect(timing.signals).toEqual([]);
  });

  it("rejects a lock record whose process-start identity differs from the live owner", async () => {
    const fixture = createBarrierFixture({ startTick: "123456" });
    const timing = fakeTiming(fixture);

    await expect(pausePortableHostLockOwner(options(fixture), timing.deps)).rejects.toThrow(
      "does not match its live owner",
    );
    expect(timing.signals).toEqual([]);
  });

  it("resumes the authenticated process before rejecting a changed lock generation", async () => {
    const fixture = createBarrierFixture();
    const timing = fakeTiming(fixture, () => {
      const owner = path.join(fixture.lockDir, "owner");
      const replacement = path.join(fixture.lockDir, "owner.replacement");
      fs.writeFileSync(replacement, `${String(PID)}\n`, { mode: 0o600 });
      fs.renameSync(replacement, owner);
    });

    await expect(pausePortableHostLockOwner(options(fixture), timing.deps)).rejects.toThrow(
      "changed after SIGSTOP",
    );
    expect(timing.signals).toEqual(["SIGSTOP", "SIGCONT"]);
  });

  it("does not signal a PID again after the authenticated owner exits", async () => {
    const fixture = createBarrierFixture();
    const timing = fakeTiming(fixture, () => {
      fs.rmSync(fixture.procDir, { force: true, recursive: true });
    });

    await expect(pausePortableHostLockOwner(options(fixture), timing.deps)).rejects.toThrow(
      "does not match its live owner",
    );
    expect(timing.signals).toEqual(["SIGSTOP"]);
  });

  it("does not attempt resume when SIGSTOP itself fails", async () => {
    const fixture = createBarrierFixture();
    const timing = fakeTiming(fixture);
    const deps: PortableHostLockBarrierDeps = {
      ...timing.deps,
      signal: () => {
        throw new Error("signal denied");
      },
    };

    await expect(pausePortableHostLockOwner(options(fixture), deps)).rejects.toThrow(
      "signal denied",
    );
    expect(timing.signals).toEqual([]);
  });

  it("resumes the authenticated owner when the loser assertion throws", async () => {
    const fixture = createBarrierFixture();
    const timing = fakeTiming(fixture);
    const barrier = await pausePortableHostLockOwner(options(fixture), timing.deps);

    await expect(
      (async () => {
        try {
          throw new Error("unexpected loser result");
        } finally {
          await barrier.resume();
        }
      })(),
    ).rejects.toThrow("unexpected loser result");
    expect(timing.signals).toEqual(["SIGSTOP", "SIGCONT"]);
  });
});
