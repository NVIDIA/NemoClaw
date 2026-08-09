// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openRegularFileNoFollow } from "./regular-file";

describe("regular file adapter", () => {
  it("creates and replaces a private regular file through one descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "gateway.env");

    try {
      const file = openRegularFileNoFollow(filePath, {
        create: true,
        mode: 0o600,
        writable: true,
      });
      file.replaceUtf8("created\n", 0o600);
      file.close();

      expect(fs.readFileSync(filePath, "utf-8")).toBe("created\n");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads and replaces a regular file through one descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "gateway.env");
    fs.writeFileSync(filePath, "before\n");

    try {
      const file = openRegularFileNoFollow(filePath, { writable: true });
      expect(file.readUtf8()).toBe("before\n");
      expect(file.readUtf8()).toBe("before\n");
      file.replaceUtf8("after\n", 0o600);
      file.close();

      expect(fs.readFileSync(filePath, "utf-8")).toBe("after\n");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds reads through the pinned descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "jobs.json");
    fs.writeFileSync(filePath, "trusted\n");

    try {
      const file = openRegularFileNoFollow(filePath);
      try {
        expect(() => file.readUtf8(7)).toThrow(RangeError);

        fs.renameSync(filePath, path.join(tmp, "opened-jobs.json"));
        fs.writeFileSync(filePath, "replacement\n");

        expect(file.readUtf8(8)).toBe("trusted\n");
      } finally {
        file.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads bounded bytes without changing their representation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "runtime.bundle");
    const expected = Buffer.from([0x00, 0xff, 0x7f, 0x0a]);
    fs.writeFileSync(filePath, expected);

    try {
      const file = openRegularFileNoFollow(filePath);
      try {
        expect(file.readBytes(expected.length)).toEqual(expected);
        expect(() => file.readBytes(expected.length - 1)).toThrow(RangeError);
      } finally {
        file.close();
      }
      expect(fs.readFileSync(filePath)).toEqual(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a hard-linked regular file without changing either link", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "runtime.bundle");
    const aliasPath = path.join(tmp, "runtime-alias.bundle");
    const expected = Buffer.from("reviewed runtime\n");
    fs.writeFileSync(filePath, expected);
    fs.linkSync(filePath, aliasPath);

    try {
      expect(() => openRegularFileNoFollow(filePath)).toThrow(/changed during validation/);
      expect(fs.readFileSync(filePath)).toEqual(expected);
      expect(fs.readFileSync(aliasPath)).toEqual(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a replaced path when reading bytes from its original descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "runtime.bundle");
    const openedPath = path.join(tmp, "opened-runtime.bundle");
    fs.writeFileSync(filePath, "reviewed\n");

    try {
      const file = openRegularFileNoFollow(filePath);
      try {
        fs.renameSync(filePath, openedPath);
        fs.writeFileSync(filePath, "replacement\n");
        expect(() => file.readBytes(64)).toThrow(/changed during validation/);
      } finally {
        file.close();
      }
      expect(fs.readFileSync(openedPath, "utf8")).toBe("reviewed\n");
      expect(fs.readFileSync(filePath, "utf8")).toBe("replacement\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects descriptor metadata changes during a byte read", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "runtime.bundle");
    const expected = Buffer.from("reviewed runtime\n");
    fs.writeFileSync(filePath, expected, { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);

    try {
      const file = openRegularFileNoFollow(filePath);
      const originalReadSync = fs.readSync.bind(fs);
      const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
        fs.chmodSync(filePath, 0o600);
        return Reflect.apply(originalReadSync, fs, args);
      }) as typeof fs.readSync);
      try {
        expect(() => file.readBytes(expected.length)).toThrow(/changed while reading/);
      } finally {
        readSpy.mockRestore();
        file.close();
      }
      expect(fs.readFileSync(filePath)).toEqual(expected);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to follow a symbolic link", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const targetPath = path.join(tmp, "target");
    const linkPath = path.join(tmp, "link");
    fs.writeFileSync(targetPath, "foreign\n");
    fs.symlinkSync(targetPath, linkPath);

    try {
      expect(() => openRegularFileNoFollow(linkPath)).toThrow();
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("foreign\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
