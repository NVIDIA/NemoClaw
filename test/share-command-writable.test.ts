// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkLocalMountWritable } from "../dist/lib/share-command.js";

describe("checkLocalMountWritable (#3192)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns writable=true when mkdirSync and accessSync both succeed", () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

    const result = checkLocalMountWritable("/some/writable/path");

    expect(result).toEqual({ writable: true });
    expect(mkdirSpy).toHaveBeenCalledWith("/some/writable/path", { recursive: true });
    expect(accessSpy).toHaveBeenCalledWith("/some/writable/path", fs.constants.W_OK);
  });

  it("reports a read-only filesystem when mkdirSync raises EROFS", () => {
    const err = new Error(
      "EROFS: read-only file system, mkdir '/ro/mount'",
    ) as NodeJS.ErrnoException;
    err.code = "EROFS";
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw err;
    });

    expect(checkLocalMountWritable("/ro/mount")).toEqual({
      writable: false,
      reason: "parent filesystem is read-only",
    });
  });

  it("reports permission denied when mkdirSync raises EACCES", () => {
    const err = new Error(
      "EACCES: permission denied, mkdir '/restricted'",
    ) as NodeJS.ErrnoException;
    err.code = "EACCES";
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw err;
    });

    expect(checkLocalMountWritable("/restricted")).toEqual({
      writable: false,
      reason: "permission denied creating the directory",
    });
  });

  it("falls back to the underlying error message for unexpected mkdirSync failures", () => {
    const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
    err.code = "ENOSPC";
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw err;
    });

    expect(checkLocalMountWritable("/full-disk")).toEqual({
      writable: false,
      reason: "ENOSPC: no space left on device",
    });
  });

  it("preserves EROFS on a pre-existing directory whose filesystem is read-only", () => {
    const err = new Error(
      "EROFS: read-only file system, access '/preexisting/ro/mount'",
    ) as NodeJS.ErrnoException;
    err.code = "EROFS";
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw err;
    });

    expect(checkLocalMountWritable("/preexisting/ro/mount")).toEqual({
      writable: false,
      reason: "filesystem is read-only",
    });
  });

  it("reports a generic permission failure on EACCES from accessSync", () => {
    const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw err;
    });

    expect(checkLocalMountWritable("/preexisting/no-write")).toEqual({
      writable: false,
      reason: "directory is not writable",
    });
  });

  describe("recursive-mkdir EROFS masking (#4311)", () => {
    it("uses non-recursive mkdirSync when the parent directory exists so EROFS propagates", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      checkLocalMountWritable("/parent/exists/mnt");

      expect(mkdirSpy).toHaveBeenCalledWith("/parent/exists/mnt");
      expect(mkdirSpy).not.toHaveBeenCalledWith("/parent/exists/mnt", { recursive: true });
    });

    it("falls back to recursive mkdirSync when the parent directory is missing", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      checkLocalMountWritable("/missing/parent/mnt");

      expect(mkdirSpy).toHaveBeenCalledWith("/missing/parent/mnt", { recursive: true });
    });

    it("reports 'parent filesystem is read-only' when non-recursive mkdir on an existing parent raises EROFS", () => {
      const err = new Error(
        "EROFS: read-only file system, mkdir '/ro/mnt'",
      ) as NodeJS.ErrnoException;
      err.code = "EROFS";
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
        throw err;
      });

      expect(checkLocalMountWritable("/ro/mnt")).toEqual({
        writable: false,
        reason: "parent filesystem is read-only",
      });
    });

    it("treats EEXIST from non-recursive mkdir as success when the existing path is a directory", () => {
      const err = new Error(
        "EEXIST: file already exists, mkdir '/parent/mnt'",
      ) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
        throw err;
      });
      vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      expect(checkLocalMountWritable("/parent/mnt")).toEqual({ writable: true });
      expect(accessSpy).toHaveBeenCalledWith("/parent/mnt", fs.constants.W_OK);
    });

    it("rejects an existing non-directory mount target instead of silently passing the writability check", () => {
      const err = new Error(
        "EEXIST: file already exists, mkdir '/parent/file'",
      ) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
        throw err;
      });
      vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => false } as fs.Stats);
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      expect(checkLocalMountWritable("/parent/file")).toEqual({
        writable: false,
        reason: "mount target exists and is not a directory",
      });
      expect(accessSpy).not.toHaveBeenCalled();
    });
  });
});
