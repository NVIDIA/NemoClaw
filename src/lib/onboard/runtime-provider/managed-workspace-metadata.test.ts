// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { prepareManagedWorkspaceMetadata } from "./managed-workspace-metadata";

const wanted = { uid: 0, gid: 999, mode: 0o1775 };
const before = { uid: 999, gid: 999, mode: 0o700, dev: 100, ino: 200, mtime: 1791870000 };
const result = (value: unknown, status = 0) => ({
  status,
  signal: null,
  stdout: Buffer.from(JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});

function fixture(after = { ...before, ...wanted }) {
  return {
    execute: vi.fn().mockReturnValueOnce(result(before)).mockReturnValue(result(after)),
    copyDirectory: vi.fn().mockReturnValue(result(null)),
  };
}

describe("managed workspace directory metadata", () => {
  it("copies only the declared directory header, then verifies the same inode and metadata", () => {
    const operations = fixture();
    prepareManagedWorkspaceMetadata(wanted, operations);
    expect(operations.execute).toHaveBeenCalledTimes(2);
    const archive: Buffer = operations.copyDirectory.mock.calls[0]![0];
    expect(archive.byteLength).toBe(1536);
    const field = (offset: number, length: number) =>
      archive
        .subarray(offset, offset + length)
        .toString("ascii")
        .replace(/\0.*$/su, "");
    expect(field(0, 100)).toBe("sandbox/");
    expect(field(100, 8)).toBe("0001775");
    expect(field(108, 8)).toBe("0000000");
    expect(field(116, 8)).toBe("0001747");
    expect(Number.parseInt(field(124, 12), 8)).toBe(0);
    expect(Number.parseInt(field(136, 12), 8)).toBe(before.mtime);
    expect(field(156, 1)).toBe("5");
    expect(field(157, 100)).toBe("");
    expect(field(257, 6)).toBe("ustar");
    expect(archive.subarray(512).equals(Buffer.alloc(1024))).toBe(true);
    const header = Buffer.from(archive.subarray(0, 512));
    header.fill(0x20, 148, 156);
    expect(Number.parseInt(field(148, 8), 8)).toBe(header.reduce((sum, byte) => sum + byte, 0));
  });

  it("does not rewrite already-correct ownership or permissions", () => {
    const operations = fixture();
    operations.execute.mockReset().mockReturnValue(result({ ...before, ...wanted }));
    prepareManagedWorkspaceMetadata(wanted, operations);
    expect(operations.copyDirectory).not.toHaveBeenCalled();
  });

  it.each([
    ["inode", { ino: 201 }],
    ["device", { dev: 101 }],
    ["UID", { uid: 999 }],
    ["GID", { gid: 998 }],
    ["mode", { mode: 0o700 }],
  ])("rejects a changed %s after engine copy", (_label, changed) => {
    const operations = fixture({ ...before, ...wanted, ...changed });
    expect(() => prepareManagedWorkspaceMetadata(wanted, operations)).toThrow(
      /retain its identity and declared metadata/u,
    );
  });

  it("does not copy after an unsafe directory or failed inspection", () => {
    const operations = fixture();
    operations.execute.mockReset().mockReturnValue(result(null, 20));
    expect(() => prepareManagedWorkspaceMetadata(wanted, operations)).toThrow(/Could not inspect/u);
    expect(operations.copyDirectory).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...before, ino: -1 }])("rejects invalid observed metadata %j", (value) => {
    const operations = fixture();
    operations.execute.mockReset().mockReturnValue(result(value));
    expect(() => prepareManagedWorkspaceMetadata(wanted, operations)).toThrow(
      /metadata was invalid/u,
    );
    expect(operations.copyDirectory).not.toHaveBeenCalled();
  });

  it("reports failed engine copies without advancing to root application", () => {
    const operations = fixture();
    operations.copyDirectory.mockReturnValue(result(null, 1));
    expect(() => prepareManagedWorkspaceMetadata(wanted, operations)).toThrow(
      /could not be restored/u,
    );
    expect(operations.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { ...wanted, uid: -1 },
    { ...wanted, gid: 0 },
    { ...wanted, mode: 0o777 },
  ])("rejects invalid declarations before observation %j", (workspace) => {
    const operations = fixture();
    expect(() => prepareManagedWorkspaceMetadata(workspace, operations)).toThrow(
      /declared numeric ownership and mode/u,
    );
    expect(operations.execute).not.toHaveBeenCalled();
  });
});
