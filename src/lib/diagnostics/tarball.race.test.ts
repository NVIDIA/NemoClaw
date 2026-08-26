// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import-time stub: createTarball resolves spawnSync from this module at
// import time, so the mock must be in place before that import runs.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

// Import-time stub, real implementation kept: createTarball's pre-check and
// its rename() call are two separate fs operations that Node's API cannot
// make atomic with each other. Wrapping only renameSync and statSync
// (everything else in this module stays real) lets a test inject a path
// swap in the exact instant between those two calls, or fake a directory's
// ownership without needing an actual second local account to test against
// — neither is reachable by mocking spawnSync alone.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), statSync: vi.fn(actual.statSync) };
});

import { spawnSync } from "node:child_process";
import { renameSync } from "node:fs";
import { createTarball } from "./tarball";

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedStatSync = vi.mocked(statSync);
const mockedRenameSync = vi.mocked(renameSync);

function expectTarInvokedThroughHeldDescriptor(collectDir: string): void {
  expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
  const [command, args, options] = mockedSpawnSync.mock.calls[0];
  // The regression this guards: if tar is ever invoked with the staging
  // *pathname* again (e.g. ["czf", partial, ...]) instead of streaming to
  // stdout through the descriptor already claimed with O_EXCL|O_NOFOLLOW,
  // the close-then-reopen race #10195 fixed reopens — even though these
  // tests would otherwise still pass, since the mocks below write to
  // whichever descriptor they're handed regardless of the real command.
  expect(command).toBe("tar");
  expect(args).toEqual(["czf", "-", "-C", dirname(collectDir), basename(collectDir)]);
  expect((options as { stdio: unknown[] }).stdio).toEqual([
    "ignore",
    expect.any(Number),
    "inherit",
  ]);
}

describe("createTarball staging-descriptor race (#10195)", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tarball-race-"));
    outputDir = mkdtempSync(join(tmpdir(), "tarball-race-out-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it("streams archive bytes through the held descriptor, never the staging pathname", () => {
    const output = join(outputDir, "output.tar.gz");
    mockedSpawnSync.mockImplementation((_command, _args, options) => {
      const stdio = (options as { stdio: unknown[] }).stdio;
      const heldFd = stdio[1] as number;
      writeSync(heldFd, "MARKER");
      return { status: 0, signal: null } as ReturnType<typeof spawnSync>;
    });
    const ok = createTarball(tempDir, output, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(ok).toBe(true);
    expect(readFileSync(output, "utf-8")).toBe("MARKER");
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expectTarInvokedThroughHeldDescriptor(tempDir);
  });

  it("does not modify a symlink target swapped in after the staging claim", () => {
    const output = join(outputDir, "output.tar.gz");
    const partial = `${output}.partial.${String(process.pid)}`;
    const victim = join(outputDir, "victim.txt");
    const victimContent = "do not overwrite me";
    writeFileSync(victim, victimContent, { mode: 0o644 });
    const victimModeBefore = statSync(victim).mode & 0o777;
    mockedSpawnSync.mockImplementation((_command, _args, options) => {
      // Simulate an attacker who wins the race between our exclusive claim
      // and tar's write: swap the staging path for a symlink to the victim,
      // then write through the descriptor tar was actually handed.
      rmSync(partial, { force: true });
      symlinkSync(victim, partial);
      const stdio = (options as { stdio: unknown[] }).stdio;
      const heldFd = stdio[1] as number;
      writeSync(heldFd, "MARKER");
      return { status: 0, signal: null } as ReturnType<typeof spawnSync>;
    });
    const info = vi.fn();
    const error = vi.fn();
    const ok = createTarball(tempDir, output, { info, warn: vi.fn(), error });
    // The archive write and fchmod both went through the descriptor claimed
    // before the swap, so the victim's content and permissions are untouched
    // no matter what the staging pathname points to by the time tar and
    // fchmod run. rename() never dereferences its source, so renaming the
    // swapped-in symlink onto `output` would itself be a legitimate,
    // successful operation (POSIX) — but publication compares the held
    // descriptor's identity against the pathname first and refuses to
    // proceed on a mismatch, so no rename happens at all. The victim is
    // never touched, `output` is never created, and the call fails closed
    // instead of reporting success for attacker-chosen content.
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("Tarball written"));
    expect(readFileSync(victim, "utf-8")).toBe(victimContent);
    expect(statSync(victim).mode & 0o777).toBe(victimModeBefore);
    expect(() => statSync(output)).toThrow();
    expectTarInvokedThroughHeldDescriptor(tempDir);
  });

  it("does not report success for content swapped in after the pre-rename identity check", async () => {
    const output = join(outputDir, "output.tar.gz");
    const partial = `${output}.partial.${String(process.pid)}`;
    const victim = join(outputDir, "victim.txt");
    const victimContent = "do not overwrite me";
    writeFileSync(victim, victimContent, { mode: 0o644 });
    const victimModeBefore = statSync(victim).mode & 0o777;
    mockedSpawnSync.mockImplementation((_command, _args, options) => {
      const stdio = (options as { stdio: unknown[] }).stdio;
      const heldFd = stdio[1] as number;
      writeSync(heldFd, "MARKER");
      return { status: 0, signal: null } as ReturnType<typeof spawnSync>;
    });
    // The pre-rename identity check (lstatSync(partial) vs fstatSync(fd))
    // runs and matches normally — the swap happens only here, in the
    // instant createTarball actually calls renameSync, simulating an
    // attacker who wins the race in the one window neither that check nor
    // O_EXCL can close: after the check passes, before the pathname-based
    // rename executes. Goes through vi.importActual (not the imported,
    // mocked `renameSync` binding) to avoid the mock calling itself. The
    // real rename still runs afterward, so this proves the *post*-rename
    // identity check is what catches it, not a rename that was refused.
    const { renameSync: realRenameSync } =
      await vi.importActual<typeof import("node:fs")>("node:fs");
    mockedRenameSync.mockImplementationOnce((from, to) => {
      rmSync(partial, { force: true });
      symlinkSync(victim, partial);
      return realRenameSync(from, to);
    });
    const info = vi.fn();
    const error = vi.fn();
    const ok = createTarball(tempDir, output, { info, warn: vi.fn(), error });
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("Tarball written"));
    expect(readFileSync(victim, "utf-8")).toBe(victimContent);
    expect(statSync(victim).mode & 0o777).toBe(victimModeBefore);
    expect(() => statSync(output)).toThrow();
    expectTarInvokedThroughHeldDescriptor(tempDir);
  });

  it("refuses a sticky output directory owned by a different local account", async () => {
    const output = join(outputDir, "output.tar.gz");
    const { statSync: realStatSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
    const otherUid = (process.getuid?.() ?? 0) + 1;
    // The sticky bit alone only stops accounts OTHER than the directory's
    // owner from touching entries they don't own — it grants the owner no
    // such restriction. A sticky, world-writable directory owned by some
    // other account is therefore exactly as unsafe as one with no sticky
    // bit at all: that owner can still remove or replace our published
    // file at any point, sticky bit or not. Faking a real directory's stat
    // result rather than an actual second account, which this environment
    // cannot provision.
    mockedStatSync.mockImplementationOnce((path, opts) => {
      const real = realStatSync(path as string, opts as never);
      return { ...real, mode: (real.mode & ~0o777) | 0o1777, uid: otherUid };
    });
    const ok = createTarball(tempDir, output, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(() => statSync(output)).toThrow();
  });
});
