// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hasOwnedLoopbackTcpListener } from "../fixtures/owned-tcp-listener.ts";

describe("owned loopback TCP listener", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-listener-"));
    fs.mkdirSync(path.join(root, "123", "fd"), { recursive: true });
    fs.mkdirSync(path.join(root, "net"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test.each([
    {
      name: "owned listener",
      address: "0100007F:2CAC",
      state: "0A",
      inode: "42",
      descriptor: "socket:[42]",
      expected: true,
    },
    {
      name: "foreign listener",
      address: "0100007F:2CAC",
      state: "0A",
      inode: "43",
      descriptor: "socket:[42]",
      expected: false,
    },
    {
      name: "different port",
      address: "0100007F:2CAD",
      state: "0A",
      inode: "42",
      descriptor: "socket:[42]",
      expected: false,
    },
    {
      name: "wildcard binding",
      address: "00000000:2CAC",
      state: "0A",
      inode: "42",
      descriptor: "socket:[42]",
      expected: false,
    },
    {
      name: "established connection",
      address: "0100007F:2CAC",
      state: "01",
      inode: "42",
      descriptor: "socket:[42]",
      expected: false,
    },
    {
      name: "non-socket descriptor",
      address: "0100007F:2CAC",
      state: "0A",
      inode: "42",
      descriptor: "pipe:[42]",
      expected: false,
    },
  ])(
    "identifies $name from the child's descriptors and the kernel TCP table",
    ({ address, state, inode, descriptor, expected }) => {
      fs.symlinkSync(descriptor, path.join(root, "123", "fd", "3"));
      fs.writeFileSync(
        path.join(root, "net", "tcp"),
        `sl local_address rem_address st tx_queue tr retrnsmt uid timeout inode\n0: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`,
      );
      expect(hasOwnedLoopbackTcpListener(123, 11436, root)).toBe(expected);
    },
  );

  test("rejects a missing child without borrowing another process's listener", () => {
    expect(hasOwnedLoopbackTcpListener(undefined, 11436, root)).toBe(false);
    expect(hasOwnedLoopbackTcpListener(456, 11436, root)).toBe(false);
  });

  test("rejects a vanished descriptor while the child changes state", () => {
    fs.symlinkSync("socket:[42]", path.join(root, "123", "fd", "3"));
    const readlink = vi.spyOn(fs, "readlinkSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("descriptor closed"), { code: "ENOENT" });
    });
    try {
      expect(hasOwnedLoopbackTcpListener(123, 11436, root)).toBe(false);
    } finally {
      readlink.mockRestore();
    }
  });

  test("fails when kernel ownership evidence cannot be read", () => {
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("ownership evidence denied"), { code: "EACCES" });
    });
    try {
      expect(() => hasOwnedLoopbackTcpListener(123, 11436, root)).toThrow(
        "ownership evidence denied",
      );
    } finally {
      readdir.mockRestore();
    }
  });
});
