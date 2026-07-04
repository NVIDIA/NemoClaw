// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  cleanupPreparedDcodeImageFixture,
  createPreparedDcodeImageFixture,
  NO_FOLLOW_FLAG,
  NON_BLOCK_FLAG,
} from "../../../../test/helpers/rebuild-managed-image-preflight-harness";
import {
  disposePreparedDcodeRebuildImage,
  verifyPreparedDcodeRebuildImage,
} from "./rebuild-managed-image-preflight";

describe("managed DCode rebuild image verification", () => {
  it("reads the prepared Dockerfile through a no-follow nonblocking descriptor (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    const stableOpen = vi.spyOn(fs, "openSync");
    const stableRead = vi.spyOn(fs, "readFileSync");
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      const fileOpen = stableOpen.mock.calls.find(
        ([candidate]) => String(candidate) === fixture.stagedDockerfile,
      );
      const flags = Number(fileOpen?.[1] ?? 0);
      expect(flags & NO_FOLLOW_FLAG).toBe(NO_FOLLOW_FLAG);
      expect(flags & NON_BLOCK_FLAG).toBe(NON_BLOCK_FLAG);
      expect(stableRead).toHaveBeenCalledWith(expect.any(Number));
      expect(stableRead).not.toHaveBeenCalledWith(fixture.stagedDockerfile);
    } finally {
      stableRead.mockRestore();
      stableOpen.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects a symlink swapped in before the prepared Dockerfile opens (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    const realOpen: typeof fs.openSync = fs.openSync.bind(fs);
    const pendingSwap = new Map([
      [
        fixture.stagedDockerfile,
        () => {
          fs.renameSync(fixture.stagedDockerfile, fixture.originalDockerfile);
          fs.symlinkSync(fixture.replacementDockerfile, fixture.stagedDockerfile);
        },
      ],
    ]);
    const read = vi.spyOn(fs, "readFileSync");
    const open = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      const key = String(target);
      const swap = pendingSwap.get(key);
      pendingSwap.delete(key);
      swap?.();
      return realOpen(target, flags, mode);
    }) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(pendingSwap.size).toBe(0);
    } finally {
      open.mockRestore();
      read.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects a symlink swapped in after the prepared Dockerfile opens (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    const realOpen: typeof fs.openSync = fs.openSync.bind(fs);
    const pendingSwap = new Map([
      [
        fixture.stagedDockerfile,
        () => {
          fs.renameSync(fixture.stagedDockerfile, fixture.originalDockerfile);
          fs.symlinkSync(fixture.replacementDockerfile, fixture.stagedDockerfile);
        },
      ],
    ]);
    const open = vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      const descriptor = realOpen(target, flags, mode);
      const key = String(target);
      const swap = pendingSwap.get(key);
      pendingSwap.delete(key);
      swap?.();
      return descriptor;
    }) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
      expect(pendingSwap.size).toBe(0);
      expect(fs.lstatSync(fixture.stagedDockerfile).isSymbolicLink()).toBe(true);
    } finally {
      open.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects a symlink even when the no-follow flag is stripped at open (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    fs.renameSync(fixture.stagedDockerfile, fixture.originalDockerfile);
    fs.symlinkSync(fixture.replacementDockerfile, fixture.stagedDockerfile);
    const realOpen: typeof fs.openSync = fs.openSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync");
    const open = vi
      .spyOn(fs, "openSync")
      .mockImplementation(((target, flags, mode) =>
        realOpen(target, Number(flags) & ~NO_FOLLOW_FLAG, mode)) as typeof fs.openSync);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
      expect(read).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      read.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects an inode replacement after the prepared Dockerfile is read (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    fs.writeFileSync(fixture.replacementDockerfile, "FROM scratch\n");
    const originalRead: typeof fs.readFileSync = fs.readFileSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((...args: unknown[]) => {
      const contents = Reflect.apply(originalRead, fs, args) as Buffer;
      fs.renameSync(fixture.stagedDockerfile, fixture.originalDockerfile);
      fs.renameSync(fixture.replacementDockerfile, fixture.stagedDockerfile);
      return contents;
    }) as never);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
    } finally {
      read.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects content appended while the prepared Dockerfile is fingerprinted (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    const originalRead: typeof fs.readFileSync = fs.readFileSync.bind(fs);
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(((...args: unknown[]) => {
      const contents = Reflect.apply(originalRead, fs, args) as Buffer;
      fs.appendFileSync(fixture.stagedDockerfile, "# changed during fingerprinting\n");
      return contents;
    }) as never);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
    } finally {
      read.mockRestore();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });

  it("rejects changes through an already-open descriptor and disposes idempotently (#6195)", async () => {
    const fixture = await createPreparedDcodeImageFixture();
    const mutationFd = fs.openSync(
      fixture.stagedDockerfile,
      fs.constants.O_WRONLY | fs.constants.O_APPEND,
    );
    const originalMutationStat = fs.fstatSync(mutationFd);
    try {
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      fs.writeSync(mutationFd, "# temporary drift\n", null, "utf8");
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
      fs.ftruncateSync(mutationFd, 0);
      fs.writeSync(mutationFd, "FROM scratch\n", 0, "utf8");
      fs.futimesSync(mutationFd, originalMutationStat.atime, originalMutationStat.mtime);
      fs.utimesSync(fixture.buildCtx, fixture.stableDockerfileTime, fixture.stableDockerfileTime);
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      fs.writeSync(mutationFd, "# changed after preflight\n", 0, "utf8");
      expect(verifyPreparedDcodeRebuildImage(fixture.prepared)).toBe(false);
      fs.closeSync(mutationFd);
      expect(disposePreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      expect(disposePreparedDcodeRebuildImage(fixture.prepared)).toBe(true);
      expect(fixture.cleanupBuildCtx).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      cleanupPreparedDcodeImageFixture(fixture);
    }
  });
});
