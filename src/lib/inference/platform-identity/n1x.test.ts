// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  collectN1xIdentity,
  isN1xFastOsRelease,
  isN1xPciDisplayDevice,
  parseTrustedFastOsPlatform,
  isTrustedN1xFastOsMarker,
} from "./n1x";

function trustedMarker(
  overrides: Partial<{ uid: number; gid: number; mode: number; size: number }> = {},
) {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 116,
    uid: 0,
    gid: 0,
    mode: 0o100644,
    ...overrides,
  };
}

function n1xFixture(overrides: Parameters<typeof collectN1xIdentity>[0] = {}) {
  const pciFields: Readonly<Record<string, string>> = {
    vendor: "0x10de\n",
    device: "0x2e2a\n",
    class: "0x030000\n",
  };
  return collectN1xIdentity({
    fastOsReleasePath: "/fixtures/fastos-release",
    pciDevicesPath: "/fixtures/pci",
    openFile: () => 17,
    statFileDescriptor: () => trustedMarker(),
    readFileDescriptor: () =>
      'NAME="N1x FASTOS"\nDATE="2026-08-07T05:30:05+00:00"\nVERSION="1.23.0"\n',
    closeFileDescriptor: () => undefined,
    readdir: () => ["000f:01:00.0"],
    readFile: (filePath) => {
      const field = filePath.split("/").at(-1) ?? "";
      return pciFields[field] ?? unexpectedFixturePath(filePath);
    },
    ...overrides,
  });
}

function unexpectedFixturePath(filePath: string): never {
  throw new Error(`unexpected path: ${filePath}`);
}

describe("N1x identity", () => {
  it("accepts the FastOS marker and NVIDIA display device without pinning FastOS version (#8574)", () => {
    expect(n1xFixture()).toEqual({
      candidate: true,
      fastOsMarker: true,
      fastOsPlatform: "n1x",
      pciGpu: true,
      qualified: true,
    });
    expect(
      n1xFixture({
        readFileDescriptor: () => 'NAME="N1x FASTOS"\nVERSION="99.1.2"\n',
      }),
    ).toEqual({
      candidate: true,
      fastOsMarker: true,
      fastOsPlatform: "n1x",
      pciGpu: true,
      qualified: true,
    });
  });

  it.each([
    ["wrong owner", { uid: 1000 }],
    ["wrong group", { gid: 1000 }],
    ["group-writable mode", { mode: 0o100664 }],
    ["world-writable mode", { mode: 0o100646 }],
    ["empty marker", { size: 0 }],
    ["oversized marker", { size: 4097 }],
  ] as const)("rejects a FastOS marker with %s (#8574)", (_scenario, metadata) => {
    expect(isTrustedN1xFastOsMarker(trustedMarker(metadata))).toBe(false);
  });

  it.each([
    ["unquoted name", "NAME=N1x FASTOS\n"],
    ["wrong name", 'NAME="N1 FASTOS"\n'],
    ["duplicate name", 'NAME="N1x FASTOS"\nNAME="N1x FASTOS"\n'],
    ["mixed name formats", 'NAME="N1x FASTOS"\nNAME=N1x FASTOS\n'],
    ["carriage return", 'NAME="N1x FASTOS"\r\n'],
  ])("rejects a FastOS marker with %s (#8574)", (_scenario, contents) => {
    expect(isN1xFastOsRelease(contents)).toBe(false);
  });

  it("treats non-identity marker lines as inert text (#8574)", () => {
    expect(isN1xFastOsRelease('NAME="N1x FASTOS"\nPAYLOAD="$(touch /tmp/nope)"\n')).toBe(true);
  });

  it("recognizes the exact trusted DGX Spark FastOS marker without treating it as N1x (#10717)", () => {
    const contents = 'NAME="DGX SPARK FASTOS"\nVERSION="1.23.0"\n';
    expect(parseTrustedFastOsPlatform(contents)).toBe("spark");
    expect(isN1xFastOsRelease(contents)).toBe(false);
    expect(n1xFixture({ readFileDescriptor: () => contents })).toMatchObject({
      candidate: true,
      fastOsMarker: false,
      fastOsPlatform: "spark",
      qualified: false,
    });
  });

  it("requires the exact N1x NVIDIA display-class PCI identity (#8574)", () => {
    expect(isN1xPciDisplayDevice("0x10DE", "0x2E2A", "0x030000")).toBe(true);
    expect(isN1xPciDisplayDevice("0x10de", "0x2e2b", "0x030000")).toBe(false);
    expect(isN1xPciDisplayDevice("0x10de", "0x2e2a", "0x020000")).toBe(false);
  });

  it("opens the marker without following a symbolic link and reads the opened descriptor (#8574)", () => {
    const openFile = vi.fn((_filePath: string, _flags: number) => 17);
    const readFileDescriptor = vi.fn(() => 'NAME="N1x FASTOS"\n');
    const closeFileDescriptor = vi.fn();

    expect(n1xFixture({ openFile, readFileDescriptor, closeFileDescriptor }).qualified).toBe(true);
    const [markerPath, flags] = openFile.mock.calls[0] as [string, number];
    expect(markerPath).toBe("/fixtures/fastos-release");
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    expect(readFileDescriptor).toHaveBeenCalledWith(17, 4096);
    expect(closeFileDescriptor).toHaveBeenCalledWith(17);
  });

  it("treats a missing FastOS marker as no N1x candidate (#8574)", () => {
    expect(
      n1xFixture({
        openFile: () => {
          throw Object.assign(new Error("marker unavailable"), { code: "ENOENT" });
        },
      }),
    ).toEqual({ candidate: false, fastOsMarker: false, pciGpu: undefined, qualified: false });
  });

  it.each(["ELOOP", "EMLINK"])(
    "preserves a linked FastOS marker as an unqualified N1x candidate with %s (#8574)",
    (code) => {
      expect(
        n1xFixture({
          openFile: () => {
            throw Object.assign(new Error("marker unavailable"), { code });
          },
        }),
      ).toEqual({ candidate: true, fastOsMarker: false, pciGpu: undefined, qualified: false });
    },
  );

  it("preserves an unreadable FastOS marker as an inconclusive N1x candidate (#8574)", () => {
    expect(
      n1xFixture({
        openFile: () => {
          throw Object.assign(new Error("marker unavailable"), { code: "EACCES" });
        },
      }),
    ).toEqual({
      candidate: true,
      fastOsMarker: undefined,
      pciGpu: undefined,
      qualified: false,
    });
  });

  it("keeps unreadable PCI evidence inconclusive (#8574)", () => {
    expect(
      n1xFixture({
        readFile: () => {
          throw Object.assign(new Error("PCI identity unavailable"), { code: "EIO" });
        },
      }),
    ).toEqual({
      candidate: true,
      fastOsMarker: true,
      fastOsPlatform: "n1x",
      pciGpu: undefined,
      qualified: false,
    });
  });
});
