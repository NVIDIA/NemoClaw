// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { readValidatedArtifactZipEntry } from "../../../scripts/scorecard/read-artifact-zip.mts";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function artifactZip(
  entries: Array<{ name: string; contents: string }>,
  compressionMethod = 0,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.from(entry.contents, "utf8");
    const compressed =
      compressionMethod === 8 ? zlib.deflateRawSync(contents) : Buffer.from(contents);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compressionMethod, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const locals = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(locals.length, 16);
  return Buffer.concat([locals, centralDirectory, end]);
}

describe("validated GitHub artifact ZIP reader", () => {
  it("reads only the exact root-level entry from a multi-entry archive", () => {
    const archive = artifactZip([
      { name: "diagnostics/log.txt", contents: "ignored" },
      { name: "summary.json", contents: '{"safe":true}' },
    ]);

    expect(readValidatedArtifactZipEntry(archive, "summary.json", { maxBytes: 1_024 })).toBe(
      '{"safe":true}',
    );
    expect(readValidatedArtifactZipEntry(archive, "log.txt", { maxBytes: 1_024 })).toBeNull();
  });

  it("rejects duplicate target entries and payloads over the caller's bound", () => {
    expect(
      readValidatedArtifactZipEntry(
        artifactZip([
          { name: "summary.json", contents: "one" },
          { name: "summary.json", contents: "two" },
        ]),
        "summary.json",
        { maxBytes: 1_024 },
      ),
    ).toBeNull();
    expect(
      readValidatedArtifactZipEntry(
        artifactZip([{ name: "summary.json", contents: "too large" }]),
        "summary.json",
        { maxBytes: 2 },
      ),
    ).toBeNull();
  });

  it("reads deflated entries and rejects corrupt compressed data", () => {
    const archive = artifactZip([{ name: "summary.json", contents: '{"compressed":true}' }], 8);

    expect(readValidatedArtifactZipEntry(archive, "summary.json", { maxBytes: 1_024 })).toBe(
      '{"compressed":true}',
    );

    const corruptArchive = Buffer.from(archive);
    const compressedDataOffset =
      30 + corruptArchive.readUInt16LE(26) + corruptArchive.readUInt16LE(28);
    const compressedDataEnd = compressedDataOffset + corruptArchive.readUInt32LE(18);
    corruptArchive.fill(0, compressedDataOffset, compressedDataEnd);
    expect(
      readValidatedArtifactZipEntry(corruptArchive, "summary.json", { maxBytes: 1_024 }),
    ).toBeNull();
  });
});
