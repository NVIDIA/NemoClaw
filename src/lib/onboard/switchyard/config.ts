// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { TextDecoder } from "node:util";

import { parseDocument } from "yaml";

import {
  createHermesSwitchyardRoutingIntent,
  type HermesSwitchyardRoutingIntent,
} from "../../hermes-switchyard-routing";

export const SWITCHYARD_ONBOARD_CONFIG_MAX_BYTES = 16 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "efficient", "capable"]);

export class SwitchyardOnboardConfigError extends Error {
  constructor(message: string) {
    super(`Invalid --switchyard-config: ${message}`);
    this.name = "SwitchyardOnboardConfigError";
  }
}

function fail(message: string): never {
  throw new SwitchyardOnboardConfigError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("the document must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseStrictJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("the document must contain valid JSON");
  }
  const duplicateCheck = parseDocument(text, { uniqueKeys: true });
  if (duplicateCheck.errors.length > 0) {
    fail("duplicate or ambiguous JSON fields are not allowed");
  }
  return parsed;
}

function stableRegularFileStats(descriptor: number, filePath: string): fs.Stats {
  const descriptorStats = fs.fstatSync(descriptor);
  const pathStats = fs.lstatSync(filePath);
  if (
    !descriptorStats.isFile() ||
    descriptorStats.nlink !== 1 ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    pathStats.nlink !== 1 ||
    descriptorStats.dev !== pathStats.dev ||
    descriptorStats.ino !== pathStats.ino
  ) {
    throw new Error("unstable regular file");
  }
  return descriptorStats;
}

function readBoundedRegularFile(filePath: string): Buffer {
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    return fail("the platform must support no-follow file reads");
  }
  const nonblock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonblock);
  } catch {
    return fail("the path must identify one stable regular file, not a symlink");
  }
  try {
    const before = stableRegularFileStats(descriptor, filePath);
    if (before.size > SWITCHYARD_ONBOARD_CONFIG_MAX_BYTES) {
      return fail(`the file must not exceed ${String(SWITCHYARD_ONBOARD_CONFIG_MAX_BYTES)} bytes`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) return fail("the file changed while it was being read");
      offset += read;
    }
    const after = stableRegularFileStats(descriptor, filePath);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return fail("the file changed while it was being read");
    }
    return bytes;
  } catch (error) {
    if (error instanceof SwitchyardOnboardConfigError) throw error;
    return fail("the path must identify one stable regular file, not a symlink");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function parseSwitchyardOnboardConfig(text: string): HermesSwitchyardRoutingIntent {
  const value = record(parseStrictJson(text));
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    fail("unknown fields, endpoints, credentials, and internal routing fragments are not allowed");
  }
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  try {
    return createHermesSwitchyardRoutingIntent({
      efficient: value.efficient,
      capable: value.capable,
    });
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message.replace(/^Invalid Hermes Switchyard routing: /u, "")
        : "invalid target selection",
    );
  }
}

export function loadSwitchyardOnboardConfig(filePath: string): HermesSwitchyardRoutingIntent {
  const bytes = readBoundedRegularFile(filePath);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return fail("the file must contain valid UTF-8");
  }
  return parseSwitchyardOnboardConfig(text);
}
