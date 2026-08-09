// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  type BootstrapQualificationContract,
  failQualificationGate as fail,
  QUALIFICATION_CONTRACT_PATH,
  QUALIFICATION_MAX_JSON_BYTES,
  validateBootstrapQualificationContract,
} from "./openshell-qualification-bootstrap-contract.mts";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_ITEMS = 100_000;
const QUALIFICATION_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]{1,2048}$/u;

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

export function readBoundedRegularFileBytes(
  filePath: string,
  label: string,
  limits: { maximumBytes: number; minimumBytes?: number },
): Buffer {
  if (
    typeof filePath !== "string" ||
    !SAFE_TEXT_PATTERN.test(filePath) ||
    path.normalize(filePath) !== filePath
  ) {
    fail(`${label} path is invalid or non-canonical`);
  }
  const minimumBytes = limits.minimumBytes ?? 0;
  if (
    !Number.isSafeInteger(minimumBytes) ||
    minimumBytes < 0 ||
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes > QUALIFICATION_MAX_ARTIFACT_BYTES ||
    limits.maximumBytes < minimumBytes
  ) {
    fail(`${label} byte limits are invalid`);
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    fail(`${label} cannot be authenticated without no-follow file access`);
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
  } catch {
    fail(`${label} is missing or is not a regular non-link file`);
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < BigInt(minimumBytes) ||
      before.size > BigInt(limits.maximumBytes)
    ) {
      fail(`${label} must be a bounded regular non-link file`);
    }
    const buffer = Buffer.allocUnsafe(limits.maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      bytesRead !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      fail(`${label} changed while it was being read`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readBoundedRegularFile(
  filePath: string,
  label: string,
  limits: { maximumBytes: number; minimumBytes?: number } = {
    maximumBytes: QUALIFICATION_MAX_JSON_BYTES,
  },
): string {
  return readBoundedRegularFileBytes(filePath, label, limits).toString("utf8");
}

export function readBoundedRegularFileFromRoot(
  root: string,
  relativePath: string,
  label: string,
  limits: { maximumBytes: number; minimumBytes?: number },
): Buffer {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} root or relative path is invalid`);
  }
  const absoluteRoot = path.resolve(root);
  let rootStats: fs.Stats;
  try {
    rootStats = fs.lstatSync(absoluteRoot);
  } catch {
    fail(`${label} root is missing`);
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail(`${label} root must be a real directory`);
  }
  const canonicalRoot = fs.realpathSync(absoluteRoot);
  const parts = relativePath.split("/");
  let cursor = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      fail(`${label} is missing`);
    }
    if (stats.isSymbolicLink()) fail(`${label} path crosses a symbolic link`);
    if (!stats.isDirectory()) fail(`${label} path has an invalid parent`);
    const resolvedParent = fs.realpathSync(cursor);
    if (resolvedParent !== cursor || !resolvedParent.startsWith(`${canonicalRoot}${path.sep}`)) {
      fail(`${label} path escapes its root or crosses a symbolic link`);
    }
    cursor = resolvedParent;
  }
  return readBoundedRegularFileBytes(path.join(cursor, parts.at(-1) as string), label, limits);
}

export function loadBootstrapQualificationContractFromRoot(
  root: string,
): BootstrapQualificationContract {
  return validateBootstrapQualificationContract(
    parseBoundedJson(
      readBoundedRegularFileFromRoot(root, QUALIFICATION_CONTRACT_PATH, "qualification contract", {
        maximumBytes: QUALIFICATION_MAX_JSON_BYTES,
        minimumBytes: 1,
      }).toString("utf8"),
      "qualification contract",
    ),
  );
}
