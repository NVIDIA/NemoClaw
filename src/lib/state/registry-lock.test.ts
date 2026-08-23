// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireProcessBoundLockAt,
  classifyExistingLock,
  releaseProcessBoundLock,
  withProcessBoundRegistryLockAt,
  withRegistryLockAt,
  type RegistryLockDeps,
} from "./registry/lock";

const STALE = 10_000;
const LOCK_MTIME = 1_000_000;
const PROCESS_IDENTITY = "12345678-1234-1234-1234-123456789abc 123456";
const RECYCLED_IDENTITY = "12345678-1234-1234-1234-123456789abc 123457";
const OTHER_IDENTITY = "87654321-4321-4321-4321-cba987654321 123456";
const temporaryDirectories: string[] = [];

function fixture(prefix: string) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(homeDir);
  const registryFile = path.join(homeDir, ".nemoclaw", "sandboxes.json");
  const lockDir = `${registryFile}.lock`;
  return {
    homeDir,
    lockDir,
    ownerFile: path.join(lockDir, "owner"),
    processStartFile: path.join(lockDir, "process-start"),
    registryFile,
  };
}

function writeOrdinaryGeneration(test: ReturnType<typeof fixture>, ownerPid: number): void {
  fs.mkdirSync(test.lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(test.ownerFile, String(ownerPid), { mode: 0o600 });
}

function writeExactGeneration(
  test: ReturnType<typeof fixture>,
  ownerPid: number,
  identity: string,
): void {
  writeOrdinaryGeneration(test, ownerPid);
  fs.writeFileSync(test.processStartFile, `${String(ownerPid)} ${identity}\n`, { mode: 0o600 });
}

function markStale(lockDir: string): void {
  fs.utimesSync(lockDir, new Date(LOCK_MTIME), new Date(LOCK_MTIME));
}

function quarantineDirectories(lockDir: string): string[] {
  const parent = path.dirname(lockDir);
  const prefix = `${path.basename(lockDir)}.quarantine.`;
  return fs
    .readdirSync(parent)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(parent, entry));
}

function interceptDetach(
  lockDir: string,
  replace: (rename: typeof fs.renameSync, quarantine: string) => void,
): void {
  const rename = fs.renameSync.bind(fs) as typeof fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
    String(source) === lockDir && String(destination).startsWith(`${lockDir}.quarantine.`)
      ? replace(rename, String(destination))
      : rename(source, destination),
  );
}

function exactDeps(overrides: RegistryLockDeps = {}): RegistryLockDeps {
  return {
    isProcessAlive: () => true,
    now: () => Number.MAX_SAFE_INTEGER,
    readProcessIdentity: () => PROCESS_IDENTITY,
    wait: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("registry lock ownership decisions", () => {
  it("breaks a dead owner and an exact recycled owner without waiting", () => {
    expect(
      classifyExistingLock({
        ownerAlive: false,
        ownerPid: 4242,
        ownerStatus: "ordinary",
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 1,
        staleMs: STALE,
      }),
    ).toBe("break");
    expect(
      classifyExistingLock({
        ownerAlive: true,
        ownerPid: 4242,
        ownerStatus: "recycled",
        lockMtimeMs: LOCK_MTIME,
        nowMs: LOCK_MTIME + 1,
        staleMs: STALE,
      }),
    ).toBe("break");
  });

  it.each(["original", "unverifiable"] as const)(
    "never age-breaks an exact original or unverifiable process-bound owner [case %#]",
    (ownerStatus) => {
      expect(
        classifyExistingLock({
          ownerAlive: true,
          ownerPid: 4242,
          ownerStatus,
          lockMtimeMs: LOCK_MTIME,
          nowMs: Number.MAX_SAFE_INTEGER,
          staleMs: STALE,
        }),
      ).toBe("wait");
    },
  );

  it.each([
    [4242, LOCK_MTIME + 1, "wait"],
    [4242, LOCK_MTIME + STALE + 1, "break"],
    [null, LOCK_MTIME + 1, "wait"],
    [null, LOCK_MTIME + STALE + 1, "break"],
  ] as const)(
    "retains the bounded age rule for ordinary or unreadable owners [case %#]",
    (ownerPid, nowMs, expected) => {
      expect(
        classifyExistingLock({
          ownerAlive: ownerPid !== null,
          ownerPid,
          ownerStatus: "ordinary",
          lockMtimeMs: LOCK_MTIME,
          nowMs,
          staleMs: STALE,
        }),
      ).toBe(expected);
    },
  );
});

describe("process-bound registry locking", () => {
  it("holds beyond ten seconds and makes a contender exhaust 120 bounded retries", () => {
    const test = fixture("nemoclaw-process-bound-lock-");
    const wait = vi.fn();
    const contender = vi.fn();

    withProcessBoundRegistryLockAt(
      test.registryFile,
      () => {
        expect(fs.readFileSync(test.ownerFile, "utf8")).toBe(String(process.pid));
        expect(fs.readFileSync(test.processStartFile, "utf8")).toBe(
          `${String(process.pid)} ${PROCESS_IDENTITY}\n`,
        );
        expect(() => withRegistryLockAt(test.registryFile, contender, exactDeps({ wait }))).toThrow(
          /after 120 retries/,
        );
      },
      exactDeps(),
    );

    expect(wait).toHaveBeenCalledTimes(120);
    expect(contender).not.toHaveBeenCalled();
    expect(fs.existsSync(test.lockDir)).toBe(false);
  });

  it("fails before effects without an exact process identity", () => {
    const test = fixture("nemoclaw-process-bound-precondition-");
    const callback = vi.fn();

    expect(() =>
      withProcessBoundRegistryLockAt(test.registryFile, callback, {
        readProcessIdentity: () => null,
      }),
    ).toThrow(/exact Linux process-start identity/);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(test.registryFile))).toBe(false);
  });

  it("fails before effects when current-user identity is unavailable", () => {
    const test = fixture("nemoclaw-process-bound-no-uid-");
    const callback = vi.fn();
    vi.spyOn(process, "getuid").mockImplementation(() => undefined as never);

    expect(() =>
      withProcessBoundRegistryLockAt(test.registryFile, callback, {
        readProcessIdentity: () => PROCESS_IDENTITY,
      }),
    ).toThrow(/exact Linux process-start identity/);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(test.registryFile))).toBe(false);
  });

  it("breaks a crashed owner and acquires the replacement generation", () => {
    const test = fixture("nemoclaw-dead-lock-");
    writeExactGeneration(test, 4242, PROCESS_IDENTITY);

    expect(
      withRegistryLockAt(test.registryFile, () => "acquired", {
        ...exactDeps(),
        isProcessAlive: () => false,
        maxRetries: 2,
      }),
    ).toBe("acquired");
    expect(fs.existsSync(test.lockDir)).toBe(false);
  });

  it("breaks a rapidly recycled PID from exact tick identity without a time tolerance", () => {
    const test = fixture("nemoclaw-recycled-lock-");
    writeExactGeneration(test, 4242, PROCESS_IDENTITY);

    expect(
      withRegistryLockAt(test.registryFile, () => "acquired", {
        ...exactDeps({ readProcessIdentity: () => RECYCLED_IDENTITY }),
        maxRetries: 2,
        now: () => Number(fs.lstatSync(test.lockDir).mtimeMs) + 1,
      }),
    ).toBe("acquired");
  });

  it("waits on a live process-bound owner when its current identity is unavailable", () => {
    const test = fixture("nemoclaw-unverifiable-lock-");
    writeExactGeneration(test, 4242, PROCESS_IDENTITY);
    markStale(test.lockDir);
    const wait = vi.fn();

    expect(() =>
      withRegistryLockAt(test.registryFile, () => undefined, {
        ...exactDeps({ readProcessIdentity: () => null, wait }),
        maxRetries: 1,
      }),
    ).toThrow(/after 1 retries/);
    expect(wait).toHaveBeenCalledOnce();
    expect(fs.existsSync(test.lockDir)).toBe(true);
  });

  it("keeps a live owner when the host cannot read process identity (#9746)", () => {
    const test = fixture("nemoclaw-unverifiable-host-lock-");
    writeOrdinaryGeneration(test, 4242);
    markStale(test.lockDir);
    const wait = vi.fn();

    expect(() =>
      withRegistryLockAt(test.registryFile, () => undefined, {
        isProcessAlive: () => true,
        maxRetries: 1,
        now: () => Number.MAX_SAFE_INTEGER,
        readProcessIdentity: () => null,
        wait,
      }),
    ).toThrow(/after 1 retries/);
    expect(wait).toHaveBeenCalledOnce();
    expect(fs.existsSync(test.lockDir)).toBe(true);
  });

  it("keeps ordinary non-Linux acquisition and release behavior", () => {
    const test = fixture("nemoclaw-ordinary-no-proc-");
    vi.spyOn(process, "getuid").mockImplementation(() => undefined as never);

    expect(
      withRegistryLockAt(test.registryFile, () => "ordinary", {
        readProcessIdentity: () => null,
      }),
    ).toBe("ordinary");
    expect(fs.existsSync(test.lockDir)).toBe(false);
  });

  it("uses the ordinary age rule for a legacy owner without a process sidecar", () => {
    const test = fixture("nemoclaw-legacy-age-lock-");
    writeOrdinaryGeneration(test, 4242);
    markStale(test.lockDir);

    expect(
      withRegistryLockAt(test.registryFile, () => "acquired", {
        ...exactDeps(),
        maxRetries: 2,
      }),
    ).toBe("acquired");
  });

  it.each([
    [
      "numeric owner with trailing text",
      (test: ReturnType<typeof fixture>) => {
        fs.writeFileSync(test.ownerFile, "4242junk", { mode: 0o600 });
      },
    ],
    [
      "wrong-mode owner",
      (test: ReturnType<typeof fixture>) => {
        fs.chmodSync(test.ownerFile, 0o644);
      },
    ],
    [
      "symbolic-link owner",
      (test: ReturnType<typeof fixture>) => {
        const target = path.join(test.homeDir, "owner-target");
        fs.writeFileSync(target, "4242", { mode: 0o600 });
        fs.unlinkSync(test.ownerFile);
        fs.symlinkSync(target, test.ownerFile);
      },
    ],
  ])("does not trust a %s", (_case, mutateOwner) => {
    const test = fixture("nemoclaw-unsafe-owner-");
    writeOrdinaryGeneration(test, 4242);
    mutateOwner(test);
    markStale(test.lockDir);

    expect(
      withRegistryLockAt(test.registryFile, () => "acquired", {
        ...exactDeps(),
        maxRetries: 2,
      }),
    ).toBe("acquired");
  });
});

describe("generation-safe registry lock removal", () => {
  it("holds and releases one opaque process-bound generation", () => {
    const test = fixture("nemoclaw-opaque-handle-");
    const handle = acquireProcessBoundLockAt(test.lockDir, exactDeps());

    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe(String(process.pid));
    expect(() => acquireProcessBoundLockAt(test.lockDir, exactDeps({ maxRetries: 1 }))).toThrow(
      /after 1 retries/,
    );
    releaseProcessBoundLock(handle);
    expect(fs.existsSync(test.lockDir)).toBe(false);
    expect(() => releaseProcessBoundLock(handle)).toThrow(/inactive/);
  });

  it("preserves a replacement when an opaque-handle release detaches a mismatch", () => {
    const test = fixture("nemoclaw-opaque-release-replacement-");
    const handle = acquireProcessBoundLockAt(test.lockDir, exactDeps());
    interceptDetach(test.lockDir, (rename, quarantine) => {
      rename(test.lockDir, quarantine);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
    });

    expect(() => releaseProcessBoundLock(handle)).not.toThrow();
    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe("4343");
    expect(quarantineDirectories(test.lockDir)).toEqual([]);
  });

  it("preserves a replacement that wins before stale detach", () => {
    const test = fixture("nemoclaw-before-detach-");
    const displaced = `${test.lockDir}.displaced`;
    writeOrdinaryGeneration(test, 4242);
    markStale(test.lockDir);
    interceptDetach(test.lockDir, (rename, quarantine) => {
      rename(test.lockDir, displaced);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
      rename(test.lockDir, quarantine);
    });

    expect(() =>
      withRegistryLockAt(test.registryFile, () => undefined, {
        ...exactDeps(),
        maxRetries: 1,
      }),
    ).toThrow(/after 1 retries/);
    expect(fs.existsSync(test.lockDir)).toBe(false);
    expect(fs.readFileSync(path.join(displaced, "owner"), "utf8")).toBe("4242");
    const [quarantine] = quarantineDirectories(test.lockDir);
    expect(fs.readFileSync(path.join(quarantine!, "owner"), "utf8")).toBe("4343");
  });

  it("leaves a detached mismatch when another canonical generation appears", () => {
    const test = fixture("nemoclaw-restore-winner-");
    const displaced = `${test.lockDir}.displaced`;
    writeOrdinaryGeneration(test, 4242);
    markStale(test.lockDir);
    interceptDetach(test.lockDir, (rename, quarantine) => {
      rename(test.lockDir, displaced);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
      rename(test.lockDir, quarantine);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4444", { mode: 0o600 });
    });

    expect(() =>
      withRegistryLockAt(test.registryFile, () => undefined, {
        ...exactDeps(),
        maxRetries: 1,
      }),
    ).toThrow(/after 1 retries/);
    const [quarantine] = quarantineDirectories(test.lockDir);
    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe("4444");
    expect(fs.readFileSync(path.join(quarantine!, "owner"), "utf8")).toBe("4343");
    expect(fs.readFileSync(path.join(displaced, "owner"), "utf8")).toBe("4242");
  });

  it("does not delete a simultaneous stale breaker's generation after detach", () => {
    const test = fixture("nemoclaw-simultaneous-breakers-");
    writeOrdinaryGeneration(test, 4242);
    markStale(test.lockDir);
    interceptDetach(test.lockDir, (rename, quarantine) => {
      rename(test.lockDir, quarantine);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
      fs.writeFileSync(test.processStartFile, `4343 ${OTHER_IDENTITY}\n`, { mode: 0o600 });
    });
    const ownerLiveness = new Map([
      [4242, false],
      [4343, true],
    ]);
    const currentIdentities = new Map([[4343, OTHER_IDENTITY]]);

    expect(() =>
      withRegistryLockAt(test.registryFile, () => undefined, {
        isProcessAlive: (pid) => ownerLiveness.get(pid) ?? true,
        maxRetries: 2,
        now: () => Number.MAX_SAFE_INTEGER,
        readProcessIdentity: (pid) => currentIdentities.get(pid) ?? PROCESS_IDENTITY,
        wait: () => undefined,
      }),
    ).toThrow(/after 2 retries/);
    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe("4343");
    expect(quarantineDirectories(test.lockDir)).toEqual([]);
  });

  it("removes only the released generation after canonical recreation", () => {
    const test = fixture("nemoclaw-release-recreation-");

    expect(
      withRegistryLockAt(
        test.registryFile,
        () => {
          interceptDetach(test.lockDir, (rename, quarantine) => {
            rename(test.lockDir, quarantine);
            fs.mkdirSync(test.lockDir, { mode: 0o700 });
            fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
          });
          return "released";
        },
        exactDeps(),
      ),
    ).toBe("released");
    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe("4343");
    expect(quarantineDirectories(test.lockDir)).toEqual([]);
  });

  it("quarantines an owner-file replacement and rejects release", () => {
    const test = fixture("nemoclaw-owner-replacement-");

    expect(() =>
      withRegistryLockAt(
        test.registryFile,
        () => {
          const replacement = path.join(test.lockDir, "replacement-owner");
          fs.writeFileSync(replacement, String(process.pid), { mode: 0o600 });
          fs.renameSync(replacement, test.ownerFile);
        },
        exactDeps(),
      ),
    ).toThrow(/changed ownership/);
    expect(fs.existsSync(test.lockDir)).toBe(false);
    const [quarantine] = quarantineDirectories(test.lockDir);
    expect(fs.readFileSync(path.join(quarantine!, "owner"), "utf8")).toBe(String(process.pid));
    expect(fs.existsSync(path.join(quarantine!, "process-start"))).toBe(true);
  });

  it("cleans only its detached failed-acquisition generation", () => {
    const test = fixture("nemoclaw-acquisition-cleanup-");
    const identities = [PROCESS_IDENTITY, RECYCLED_IDENTITY];
    const readProcessIdentity = vi.fn(() => identities.shift() ?? RECYCLED_IDENTITY);
    interceptDetach(test.lockDir, (rename, quarantine) => {
      rename(test.lockDir, quarantine);
      fs.mkdirSync(test.lockDir, { mode: 0o700 });
      fs.writeFileSync(test.ownerFile, "4343", { mode: 0o600 });
    });

    expect(() =>
      withProcessBoundRegistryLockAt(test.registryFile, () => undefined, {
        readProcessIdentity,
      }),
    ).toThrow(/identity changed during acquisition/);
    expect(fs.readFileSync(test.ownerFile, "utf8")).toBe("4343");
    expect(quarantineDirectories(test.lockDir)).toEqual([]);
  });
});
