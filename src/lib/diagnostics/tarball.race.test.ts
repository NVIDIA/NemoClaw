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

import { spawnSync } from "node:child_process";
import { createTarball } from "./tarball";

const mockedSpawnSync = vi.mocked(spawnSync);

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
    const ok = createTarball(tempDir, output, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    // The archive write and fchmod both went through the descriptor claimed
    // before the swap, so the victim's content and permissions are untouched
    // no matter what the staging pathname points to by the time tar and
    // fchmod run. rename() never dereferences its source, so renaming the
    // swapped-in symlink onto `output` is itself a legitimate, successful
    // operation (POSIX) — it moves the link, not the victim. This is the
    // known residual: an attacker who can win this race can substitute what
    // `output` points to, but can never write through it to the victim.
    expect(ok).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe(victimContent);
    expect(statSync(victim).mode & 0o777).toBe(victimModeBefore);
    expectTarInvokedThroughHeldDescriptor(tempDir);
  });
});
