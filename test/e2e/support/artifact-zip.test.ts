// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readValidatedArtifactZipEntries } from "../../../scripts/lib/read-artifact-zip.mts";
import { artifactZip, artifactZipEntryDataOffset } from "../../helpers/artifact-zip";

const LIMITS = { maxEntries: 10, maxTotalUncompressedBytes: 1_024 };

function withDataDescriptor(archive: Buffer, signature: boolean): Buffer {
  const centralOffset = archive.readUInt32LE(archive.length - 6);
  const offset = signature ? 4 : 0;
  const descriptor = Buffer.alloc(offset + 12);
  signature && descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(archive.readUInt32LE(14), offset);
  descriptor.writeUInt32LE(archive.readUInt32LE(18), offset + 4);
  descriptor.writeUInt32LE(archive.readUInt32LE(22), offset + 8);

  const result = Buffer.concat([
    archive.subarray(0, centralOffset),
    descriptor,
    archive.subarray(centralOffset),
  ]);
  const movedCentralOffset = centralOffset + descriptor.length;
  const endOffset = result.length - 22;
  result.writeUInt16LE(result.readUInt16LE(6) | 0x0008, 6);
  result.writeUInt32LE(0, 14);
  result.writeUInt32LE(0, 18);
  result.writeUInt32LE(0, 22);
  result.writeUInt16LE(
    result.readUInt16LE(movedCentralOffset + 8) | 0x0008,
    movedCentralOffset + 8,
  );
  result.writeUInt32LE(movedCentralOffset, endOffset + 16);
  return result;
}

function mutateLocalField(offset: number, centralOffset: number) {
  return (archive: Buffer) =>
    archive.writeUInt32LE(archive.readUInt32LE(centralOffset) + 1, offset);
}

describe("validated GitHub artifact ZIP reader", () => {
  it.each([0, 8])("returns validated bytes for safe regular files using method %s", (method) => {
    const archive = artifactZip(
      [
        { name: "summary.json", contents: '{"safe":true}' },
        { name: "diagnostics/log.txt", contents: "log" },
      ],
      method,
    );
    expect(readValidatedArtifactZipEntries(archive, LIMITS)).toEqual([
      { name: "summary.json", bytes: Buffer.from('{"safe":true}') },
      { name: "diagnostics/log.txt", bytes: Buffer.from("log") },
    ]);
  });

  it("preserves distinct UTF-8 entry identities including a leading BOM", () => {
    const archive = artifactZip([
      { name: "summary.json", contents: "normal" },
      { name: "\ufeffsummary.json", contents: "BOM-prefixed" },
    ]);
    expect(readValidatedArtifactZipEntries(archive, LIMITS)).toEqual([
      { name: "summary.json", bytes: Buffer.from("normal") },
      { name: "\ufeffsummary.json", bytes: Buffer.from("BOM-prefixed") },
    ]);
  });

  it("rejects duplicate, unsafe, linked, and invalid UTF-8 entry names", () => {
    const duplicate = artifactZip([
      { name: "same.json", contents: "one" },
      { name: "same.json", contents: "two" },
    ]);
    expect(readValidatedArtifactZipEntries(duplicate, LIMITS)).toBeNull();

    const linked = artifactZip([{ name: "summary.json", contents: "{}" }]);
    linked.writeUInt32LE(0xa0000000, linked.readUInt32LE(linked.length - 6) + 38);
    expect(readValidatedArtifactZipEntries(linked, LIMITS)).toBeNull();

    const invalidUtf8 = artifactZip([{ name: "x.json", contents: "{}" }]);
    invalidUtf8[30] = 0xff;
    invalidUtf8[invalidUtf8.readUInt32LE(invalidUtf8.length - 6) + 46] = 0xff;
    expect(readValidatedArtifactZipEntries(invalidUtf8, LIMITS)).toBeNull();
  });

  it.each([
    [1, 6],
    [10, 5],
    [0, 6],
    [1.5, 6],
    [Number.NaN, 6],
    [Number.POSITIVE_INFINITY, 6],
    [10, -1],
    [10, 1.5],
    [10, Number.NaN],
    [10, Number.POSITIVE_INFINITY],
  ])(
    "rejects archive limits maxEntries=%s maxBytes=%s",
    (maxEntries, maxTotalUncompressedBytes) => {
      const archive = artifactZip([
        { name: "one", contents: "123" },
        { name: "two", contents: "456" },
      ]);
      expect(
        readValidatedArtifactZipEntries(archive, { maxEntries, maxTotalUncompressedBytes }),
      ).toBeNull();
    },
  );

  it.each(["/summary.json", "../summary.json", "a\\b", "a//b", "a/./b", "a/"])(
    "rejects unsafe entry name %s",
    (name) => {
      expect(
        readValidatedArtifactZipEntries(artifactZip([{ name, contents: "x" }]), LIMITS),
      ).toBeNull();
    },
  );

  it.each([
    ["CRC", 14, 16],
    ["compressed size", 18, 20],
    ["uncompressed size", 22, 24],
  ])(
    "rejects a local %s that differs from the central directory",
    (_name, localOffset, centralFieldOffset) => {
      const archive = artifactZip([{ name: "summary.json", contents: "safe" }]);
      const centralOffset = archive.readUInt32LE(archive.length - 6);
      mutateLocalField(localOffset, centralOffset + centralFieldOffset)(archive);
      expect(readValidatedArtifactZipEntries(archive, LIMITS)).toBeNull();
    },
  );

  it.each([false, true])(
    "returns validated bytes for a bit-3 data descriptor (signature: %s)",
    (signature) => {
      const archive = withDataDescriptor(
        artifactZip([{ name: "summary.json", contents: '{"safe":true}' }], 8),
        signature,
      );
      expect(readValidatedArtifactZipEntries(archive, LIMITS)).toEqual([
        { name: "summary.json", bytes: Buffer.from('{"safe":true}') },
      ]);
    },
  );

  it.each([
    [false, "CRC", 0],
    [false, "compressed size", 4],
    [false, "uncompressed size", 8],
    [true, "CRC", 0],
    [true, "compressed size", 4],
    [true, "uncompressed size", 8],
  ])(
    "rejects a bit-3 data descriptor mismatch (signature: %s, field: %s)",
    (signature, _field, fieldOffset) => {
      const archive = withDataDescriptor(
        artifactZip([{ name: "summary.json", contents: '{"safe":true}' }], 8),
        signature,
      );
      const centralOffset = archive.readUInt32LE(archive.length - 6);
      const descriptorOffset = centralOffset - (signature ? 16 : 12) + (signature ? 4 : 0);
      const offset = descriptorOffset + fieldOffset;
      archive.writeUInt32LE(archive.readUInt32LE(offset) + 1, offset);
      expect(readValidatedArtifactZipEntries(archive, LIMITS)).toBeNull();
    },
  );

  it.each([
    ["CRC", 14, 16],
    ["compressed size", 18, 20],
    ["uncompressed size", 22, 24],
  ])(
    "rejects a bit-3 data descriptor with a populated local %s",
    (_field, localOffset, centralFieldOffset) => {
      const archive = withDataDescriptor(
        artifactZip([{ name: "summary.json", contents: '{"safe":true}' }], 8),
        true,
      );
      const centralOffset = archive.readUInt32LE(archive.length - 6);
      archive.writeUInt32LE(archive.readUInt32LE(centralOffset + centralFieldOffset), localOffset);
      expect(readValidatedArtifactZipEntries(archive, LIMITS)).toBeNull();
    },
  );

  it("rejects trailing data between a bit-3 descriptor and the central directory", () => {
    const archive = withDataDescriptor(
      artifactZip([{ name: "summary.json", contents: '{"safe":true}' }], 8),
      true,
    );
    const centralOffset = archive.readUInt32LE(archive.length - 6);
    const result = Buffer.concat([
      archive.subarray(0, centralOffset),
      Buffer.from([0]),
      archive.subarray(centralOffset),
    ]);
    result.writeUInt32LE(centralOffset + 1, result.length - 6);
    expect(readValidatedArtifactZipEntries(result, LIMITS)).toBeNull();
  });

  it("accepts the UTF-8 names flag", () => {
    const archive = artifactZip([{ name: "résumé.json", contents: "safe" }]);
    const centralOffset = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt16LE(archive.readUInt16LE(6) | 0x0800, 6);
    archive.writeUInt16LE(archive.readUInt16LE(centralOffset + 8) | 0x0800, centralOffset + 8);
    expect(readValidatedArtifactZipEntries(archive, LIMITS)).toEqual([
      { name: "résumé.json", bytes: Buffer.from("safe") },
    ]);
  });

  it.each([
    ["compression option", 0x0002],
    ["patched data", 0x0020],
  ])("rejects the unsupported %s flag", (_flag, flag) => {
    const archive = artifactZip([{ name: "summary.json", contents: "safe" }]);
    const centralOffset = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt16LE(archive.readUInt16LE(6) | flag, 6);
    archive.writeUInt16LE(archive.readUInt16LE(centralOffset + 8) | flag, centralOffset + 8);
    expect(readValidatedArtifactZipEntries(archive, LIMITS)).toBeNull();
  });

  it("rejects encryption, local method disagreement, corrupt data, and CRC mismatch", () => {
    const encrypted = artifactZip([{ name: "summary.json", contents: "safe" }]);
    const encryptedCentral = encrypted.readUInt32LE(encrypted.length - 6);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(6) | 1, 6);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(encryptedCentral + 8) | 1, encryptedCentral + 8);
    expect(readValidatedArtifactZipEntries(encrypted, LIMITS)).toBeNull();

    const methodMismatch = artifactZip([{ name: "summary.json", contents: "safe" }]);
    methodMismatch.writeUInt16LE(8, 8);
    expect(readValidatedArtifactZipEntries(methodMismatch, LIMITS)).toBeNull();

    const corrupt = artifactZip([{ name: "summary.json", contents: "safe" }], 8);
    corrupt[artifactZipEntryDataOffset(corrupt, 0)] ^= 0xff;
    expect(readValidatedArtifactZipEntries(corrupt, LIMITS)).toBeNull();

    const crcMismatch = artifactZip([{ name: "summary.json", contents: "safe" }]);
    const centralOffset = crcMismatch.readUInt32LE(crcMismatch.length - 6);
    crcMismatch.writeUInt32LE(crcMismatch.readUInt32LE(14) + 1, 14);
    crcMismatch.writeUInt32LE(crcMismatch.readUInt32LE(centralOffset + 16) + 1, centralOffset + 16);
    expect(readValidatedArtifactZipEntries(crcMismatch, LIMITS)).toBeNull();
  });
});
