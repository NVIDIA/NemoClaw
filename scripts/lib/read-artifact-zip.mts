// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import zlib from "node:zlib";

const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_UTF8_NAMES_FLAG = 0x0800;
const ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS = ZIP_DATA_DESCRIPTOR_FLAG | ZIP_UTF8_NAMES_FLAG;

type ParseOptions = {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
};

export type ValidatedArtifactZipEntry = {
  name: string;
  bytes: Buffer;
};

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

function isSafeExpectedFile(expectedFile: string): boolean {
  const segments = expectedFile.split("/");
  return (
    expectedFile.length > 0 &&
    !expectedFile.startsWith("/") &&
    !expectedFile.endsWith("/") &&
    !expectedFile.includes("\\") &&
    !/[\0-\x1f\x7f*?[\]]/u.test(expectedFile) &&
    !expectedFile.startsWith("-") &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isSafeIntegerAtLeast(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function matchingDataDescriptorEnd(
  archive: Buffer,
  offset: number,
  boundary: number,
  expectedCrc: number,
  compressedSize: number,
  uncompressedSize: number,
): number | null {
  const matchesAt = (fieldsOffset: number): boolean =>
    fieldsOffset + 12 <= boundary &&
    archive.readUInt32LE(fieldsOffset) === expectedCrc &&
    archive.readUInt32LE(fieldsOffset + 4) === compressedSize &&
    archive.readUInt32LE(fieldsOffset + 8) === uncompressedSize;

  if (
    offset + 4 <= boundary &&
    archive.readUInt32LE(offset) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    matchesAt(offset + 4)
  ) {
    return offset + 16;
  }
  return matchesAt(offset) ? offset + 12 : null;
}

/** Owns all ZIP parsing, structural validation, optional inflation, and CRC checks. */
function parseValidatedArtifactZip(
  archive: Buffer,
  options: ParseOptions,
): ValidatedArtifactZipEntry[] | null {
  if (
    !isSafeIntegerAtLeast(options.maxEntries, 1) ||
    !isSafeIntegerAtLeast(options.maxTotalUncompressedBytes, 0)
  ) {
    return null;
  }

  const endOffset = findZipEndOfCentralDirectory(archive);
  if (endOffset < 0) return null;
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  if (
    archive.readUInt16LE(endOffset + 4) !== 0 ||
    archive.readUInt16LE(endOffset + 6) !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > options.maxEntries ||
    centralDirectoryOffset + centralDirectorySize !== endOffset
  ) {
    return null;
  }

  const entries: ValidatedArtifactZipEntry[] = [];
  const localRecords: Array<{ end: number; start: number; usesDataDescriptor: boolean }> = [];
  const seen = new Set<string>();
  let totalUncompressedBytes = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > endOffset ||
      archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      return null;
    }
    const creatorSystem = archive.readUInt8(offset + 5);
    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > endOffset) return null;

    const nameBytes = archive.subarray(offset + 46, offset + 46 + fileNameLength);
    let name: string;
    try {
      // TextDecoder handles and strips a leading BOM unless ignoreBOM is true. Preserve it so distinct ZIP entry names keep distinct identities.
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes);
    } catch {
      return null;
    }
    totalUncompressedBytes += uncompressedSize;
    const unixFileType = (externalAttributes >>> 16) & 0xf000;
    if (
      !isSafeExpectedFile(name) ||
      totalUncompressedBytes > options.maxTotalUncompressedBytes ||
      seen.has(name) ||
      diskStart !== 0 ||
      (flags & ~ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      (creatorSystem !== 0 && creatorSystem !== 3) ||
      (creatorSystem === 3 && unixFileType !== 0 && unixFileType !== 0x8000) ||
      localHeaderOffset + 30 > centralDirectoryOffset ||
      archive.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE
    ) {
      return null;
    }

    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localCrc = archive.readUInt32LE(localHeaderOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(localHeaderOffset + 22);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const localNameEnd = localHeaderOffset + 30 + localNameLength;
    const compressedDataOffset = localNameEnd + localExtraLength;
    const dataEnd = compressedDataOffset + compressedSize;
    const usesDataDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    const descriptorEnd = usesDataDescriptor
      ? matchingDataDescriptorEnd(
          archive,
          dataEnd,
          centralDirectoryOffset,
          expectedCrc,
          compressedSize,
          uncompressedSize,
        )
      : dataEnd;
    if (
      localNameEnd > centralDirectoryOffset ||
      dataEnd > centralDirectoryOffset ||
      localFlags !== flags ||
      localCompressionMethod !== compressionMethod ||
      (usesDataDescriptor
        ? localCrc !== 0 ||
          localCompressedSize !== 0 ||
          localUncompressedSize !== 0 ||
          descriptorEnd === null
        : localCrc !== expectedCrc ||
          localCompressedSize !== compressedSize ||
          localUncompressedSize !== uncompressedSize) ||
      !archive.subarray(localHeaderOffset + 30, localNameEnd).equals(nameBytes)
    ) {
      return null;
    }

    const compressedData = archive.subarray(compressedDataOffset, dataEnd);
    let bytes: Buffer;
    try {
      bytes =
        compressionMethod === 0
          ? Buffer.from(compressedData)
          : zlib.inflateRawSync(compressedData, {
              maxOutputLength: Math.max(1, uncompressedSize),
            });
    } catch {
      return null;
    }
    if (bytes.length !== uncompressedSize || crc32(bytes) !== expectedCrc) return null;

    seen.add(name);
    entries.push({ name, bytes });
    localRecords.push({
      end: descriptorEnd ?? dataEnd,
      start: localHeaderOffset,
      usesDataDescriptor,
    });
    offset = entryEnd;
  }
  if (offset !== endOffset) return null;

  localRecords.sort((left, right) => left.start - right.start);
  for (let index = 0; index < localRecords.length; index += 1) {
    const record = localRecords[index]!;
    const nextBoundary = localRecords[index + 1]?.start ?? centralDirectoryOffset;
    if (record.end > nextBoundary || (record.usesDataDescriptor && record.end !== nextBoundary)) {
      return null;
    }
  }
  return entries;
}

/**
 * Returns every safe regular-file entry and its validated bytes. The whole
 * archive is structurally validated before any entry is returned, and every
 * entry is inflated and CRC-checked within the caller's aggregate bound.
 */
export function readValidatedArtifactZipEntries(
  archive: Buffer,
  options: { maxEntries?: number; maxTotalUncompressedBytes: number },
): ValidatedArtifactZipEntry[] | null {
  return parseValidatedArtifactZip(archive, {
    maxEntries: options.maxEntries ?? 1000,
    maxTotalUncompressedBytes: options.maxTotalUncompressedBytes,
  });
}
