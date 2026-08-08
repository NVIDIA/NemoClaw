// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { readValidatedArtifactZipEntry } from "../scorecard/read-artifact-zip.mts";
import {
  fail,
  isRecord,
  MAX_JSON_DEPTH,
  MAX_JSON_ITEMS,
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_MAX_ARTIFACT_BYTES,
  QUALIFICATION_MAX_JSON_BYTES,
  QUALIFICATION_RECEIPT_FILE,
  type QualificationContract,
  type QualificationReceipt,
  type QualificationReceiptExpectation,
  SAFE_TEXT_PATTERN,
  validateQualificationContract,
  validateQualificationReceipt,
} from "./openshell-qualification-core.mts";

function skipWhitespace(source: string, cursor: { index: number }): void {
  while (/\s/u.test(source[cursor.index] ?? "")) cursor.index += 1;
}

function scanJsonString(source: string, cursor: { index: number }): string {
  const start = cursor.index;
  cursor.index += 1;
  while (cursor.index < source.length) {
    const character = source[cursor.index];
    if (character === "\\") {
      cursor.index += 2;
      continue;
    }
    cursor.index += 1;
    if (character === '"') {
      try {
        return JSON.parse(source.slice(start, cursor.index)) as string;
      } catch {
        fail("JSON contains a malformed string");
      }
    }
  }
  fail("JSON contains an unterminated string");
}

function scanJsonValue(
  source: string,
  cursor: { index: number; items: number },
  depth: number,
): void {
  if (depth > MAX_JSON_DEPTH) fail("JSON nesting is too deep");
  skipWhitespace(source, cursor);
  const character = source[cursor.index];
  if (character === "{") {
    cursor.index += 1;
    const keys = new Set<string>();
    skipWhitespace(source, cursor);
    if (source[cursor.index] === "}") {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      skipWhitespace(source, cursor);
      if (source[cursor.index] !== '"') fail("JSON object key is malformed");
      const key = scanJsonString(source, cursor);
      if (keys.has(key)) fail(`JSON contains duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      cursor.items += 1;
      if (cursor.items > MAX_JSON_ITEMS) fail("JSON contains too many items");
      skipWhitespace(source, cursor);
      if (source[cursor.index] !== ":") fail("JSON object separator is malformed");
      cursor.index += 1;
      scanJsonValue(source, cursor, depth + 1);
      skipWhitespace(source, cursor);
      if (source[cursor.index] === "}") {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ",") fail("JSON object delimiter is malformed");
      cursor.index += 1;
    }
    fail("JSON object is unterminated");
  }
  if (character === "[") {
    cursor.index += 1;
    skipWhitespace(source, cursor);
    if (source[cursor.index] === "]") {
      cursor.index += 1;
      return;
    }
    while (cursor.index < source.length) {
      cursor.items += 1;
      if (cursor.items > MAX_JSON_ITEMS) fail("JSON contains too many items");
      scanJsonValue(source, cursor, depth + 1);
      skipWhitespace(source, cursor);
      if (source[cursor.index] === "]") {
        cursor.index += 1;
        return;
      }
      if (source[cursor.index] !== ",") fail("JSON array delimiter is malformed");
      cursor.index += 1;
    }
    fail("JSON array is unterminated");
  }
  if (character === '"') {
    scanJsonString(source, cursor);
    return;
  }
  const start = cursor.index;
  while (cursor.index < source.length && !/[\s,\]}]/u.test(source[cursor.index] ?? "")) {
    cursor.index += 1;
  }
  if (cursor.index === start) fail("JSON value is malformed");
  try {
    JSON.parse(source.slice(start, cursor.index));
  } catch {
    fail("JSON primitive is malformed");
  }
}

export function parseBoundedJson(source: string, label: string): unknown {
  if (Buffer.byteLength(source, "utf8") > QUALIFICATION_MAX_JSON_BYTES) {
    fail(`${label} is oversized`);
  }
  const cursor = { index: 0, items: 0 };
  scanJsonValue(source, cursor, 0);
  skipWhitespace(source, cursor);
  if (cursor.index !== source.length) fail(`${label} has trailing content`);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function readBoundedRegularFile(filePath: string, label: string): string {
  if (
    typeof filePath !== "string" ||
    !SAFE_TEXT_PATTERN.test(filePath) ||
    path.normalize(filePath) !== filePath
  ) {
    fail(`${label} path is invalid or non-canonical`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular non-link file`);
  if (stats.size > QUALIFICATION_MAX_JSON_BYTES) fail(`${label} is oversized`);
  return fs.readFileSync(filePath, "utf8");
}

export function loadQualificationContract(filePath: string): QualificationContract {
  return validateQualificationContract(
    parseBoundedJson(
      readBoundedRegularFile(filePath, "qualification contract"),
      "qualification contract",
    ),
  );
}

export function loadQualificationContractFromRoot(
  root: string,
  relativePath = QUALIFICATION_CONTRACT_PATH,
): QualificationContract {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("qualification contract root or relative path is invalid");
  }
  const absoluteRoot = path.resolve(root);
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(absoluteRoot);
  } catch {
    fail("qualification contract root is missing");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail("qualification contract root must be a real directory");
  }
  const canonicalRoot = fs.realpathSync(absoluteRoot);
  let cursor = canonicalRoot;
  for (const [index, part] of relativePath.split("/").entries()) {
    cursor = path.join(cursor, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      fail("qualification contract is missing");
    }
    if (stats.isSymbolicLink()) fail("qualification contract path crosses a symbolic link");
    if (index < relativePath.split("/").length - 1 && !stats.isDirectory()) {
      fail("qualification contract path has an invalid parent");
    }
    if (
      index === relativePath.split("/").length - 1 &&
      (!stats.isFile() || stats.size > QUALIFICATION_MAX_JSON_BYTES)
    ) {
      fail("qualification contract must be a bounded regular file");
    }
  }
  const resolved = fs.realpathSync(cursor);
  if (!resolved.startsWith(`${canonicalRoot}${path.sep}`)) {
    fail("qualification contract path escapes its root");
  }
  return validateQualificationContract(
    parseBoundedJson(fs.readFileSync(resolved, "utf8"), "qualification contract"),
  );
}

export function loadQualificationReceipt(
  filePath: string,
  contract: QualificationContract,
  expected: QualificationReceiptExpectation,
): QualificationReceipt {
  return validateQualificationReceipt(
    parseBoundedJson(
      readBoundedRegularFile(filePath, "qualification receipt"),
      "qualification receipt",
    ),
    contract,
    expected,
  );
}

export function readQualificationReceiptArchive(
  archive: Buffer,
  contract: QualificationContract,
  expected: QualificationReceiptExpectation,
): QualificationReceipt {
  return validateQualificationReceipt(
    parseQualificationReceiptArchive(archive),
    contract,
    expected,
  );
}

export function parseQualificationReceiptArchive(archive: Buffer): unknown {
  if (archive.length > QUALIFICATION_MAX_ARTIFACT_BYTES)
    fail("qualification artifact is oversized");
  const source = readValidatedArtifactZipEntry(archive, QUALIFICATION_RECEIPT_FILE, {
    maxBytes: QUALIFICATION_MAX_JSON_BYTES,
    maxEntries: 1,
  });
  if (source === null) fail("qualification artifact archive is malformed or ambiguous");
  return parseBoundedJson(source, "qualification receipt");
}
