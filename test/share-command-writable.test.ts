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
    const err = new Error("EROFS: read-only file system, mkdir '/ro/mount'") as NodeJS.ErrnoException;
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
    const err = new Error("EACCES: permission denied, mkdir '/restricted'") as NodeJS.ErrnoException;
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
});
