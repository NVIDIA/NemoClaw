// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import zlib from "node:zlib";

type ZipEntry = {
  creatorSystem: number;
  flags: number;
  compressionMethod: number;
  expectedCrc: number;
  compressedSize: number;
  uncompressedSize: number;
  diskStart: number;
  externalAttributes: number;
  localHeaderOffset: number;
};

const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;

function findZipEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }
  return -1;
}

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

/**
 * Reads one exact root-level file from a GitHub artifact ZIP without
 * extracting paths to disk. Duplicate targets, links, encryption, split
 * archives, ZIP64, excess entries, and oversized payloads are rejected.
 */
export function readValidatedArtifactZipEntry(
  archive: Buffer,
  expectedFile: string,
  options: { maxBytes: number; maxEntries?: number },
): string | null {
  const maxEntries = options.maxEntries ?? 1000;
  const expectedFileName = Buffer.from(expectedFile, "utf8");
  if (
    expectedFile.length === 0 ||
    expectedFile.includes("/") ||
    expectedFile.includes("\\") ||
    options.maxBytes < 1 ||
    maxEntries < 1
  ) {
    return null;
  }

  const endOffset = findZipEndOfCentralDirectory(archive);
  if (endOffset < 0) return null;

  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > maxEntries ||
    centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    return null;
  }

  let centralEntryOffset = centralDirectoryOffset;
  let target: ZipEntry | null = null;
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (
      centralEntryOffset + 46 > endOffset ||
      archive.readUInt32LE(centralEntryOffset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      return null;
    }
    const fileNameLength = archive.readUInt16LE(centralEntryOffset + 28);
    const extraLength = archive.readUInt16LE(centralEntryOffset + 30);
    const commentLength = archive.readUInt16LE(centralEntryOffset + 32);
    const centralEntryEnd = centralEntryOffset + 46 + fileNameLength + extraLength + commentLength;
    if (centralEntryEnd > endOffset) return null;
    const fileName = archive.subarray(
      centralEntryOffset + 46,
      centralEntryOffset + 46 + fileNameLength,
    );
    if (fileName.equals(expectedFileName)) {
      if (target !== null) return null;
      target = {
        creatorSystem: archive.readUInt8(centralEntryOffset + 5),
        flags: archive.readUInt16LE(centralEntryOffset + 8),
        compressionMethod: archive.readUInt16LE(centralEntryOffset + 10),
        expectedCrc: archive.readUInt32LE(centralEntryOffset + 16),
        compressedSize: archive.readUInt32LE(centralEntryOffset + 20),
        uncompressedSize: archive.readUInt32LE(centralEntryOffset + 24),
        diskStart: archive.readUInt16LE(centralEntryOffset + 34),
        externalAttributes: archive.readUInt32LE(centralEntryOffset + 38),
        localHeaderOffset: archive.readUInt32LE(centralEntryOffset + 42),
      };
    }
    centralEntryOffset = centralEntryEnd;
  }
  if (centralEntryOffset !== endOffset || target === null) return null;

  const {
    creatorSystem,
    flags,
    compressionMethod,
    expectedCrc,
    compressedSize,
    uncompressedSize,
    diskStart,
    externalAttributes,
    localHeaderOffset,
  } = target;
  const unixFileType = (externalAttributes >>> 16) & 0xf000;
  if (
    diskStart !== 0 ||
    (flags & 0x1) !== 0 ||
    (compressionMethod !== 0 && compressionMethod !== 8) ||
    compressedSize > options.maxBytes ||
    uncompressedSize > options.maxBytes ||
    (creatorSystem !== 0 && creatorSystem !== 3) ||
    (creatorSystem === 3 && unixFileType !== 0 && unixFileType !== 0x8000) ||
    localHeaderOffset + 30 > centralDirectoryOffset ||
    archive.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    return null;
  }

  const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
  const localCompressionMethod = archive.readUInt16LE(localHeaderOffset + 8);
  const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const localFileNameEnd = localHeaderOffset + 30 + localFileNameLength;
  const compressedDataOffset = localFileNameEnd + localExtraLength;
  const compressedDataEnd = compressedDataOffset + compressedSize;
  if (
    localFileNameEnd > centralDirectoryOffset ||
    localFlags !== flags ||
    localCompressionMethod !== compressionMethod ||
    !archive.subarray(localHeaderOffset + 30, localFileNameEnd).equals(expectedFileName) ||
    compressedDataEnd > centralDirectoryOffset
  ) {
    return null;
  }

  const compressedData = archive.subarray(compressedDataOffset, compressedDataEnd);
  let contents: Buffer;
  try {
    contents =
      compressionMethod === 0
        ? Buffer.from(compressedData)
        : zlib.inflateRawSync(compressedData, { maxOutputLength: options.maxBytes });
  } catch {
    return null;
  }
  if (contents.length !== uncompressedSize || crc32(contents) !== expectedCrc) return null;
  return contents.toString("utf8");
}
