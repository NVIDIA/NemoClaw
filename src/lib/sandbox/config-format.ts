// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type ConfigObject = import("../security/credential-filter").ConfigObject;

const MAX_CONFIG_STRUCTURE_DEPTH = 64;
const MAX_CONFIG_STRUCTURE_NODES = 100_000;
const MAX_CONFIG_OBJECT_KEYS = 10_000;
const MAX_CONFIG_TOTAL_KEYS = 50_000;
const MAX_CONFIG_ARRAY_LENGTH = 10_000;

type ConfigWalkEntry =
  | { kind: "visit"; depth: number; value: unknown }
  | { kind: "leave"; value: object };

function configStructureLimitError(): Error {
  return new Error("Config exceeds safe structural limits.");
}

function invalidConfigShapeError(): Error {
  return new Error("Config is not a JSON-like object.");
}

function readOwnDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw invalidConfigShapeError();
  return descriptor.value;
}

/**
 * Validate parsed, sandbox-controlled config iteratively before any recursive
 * validation, redaction, or serialization can consume it.
 */
function assertSafeConfigStructure(value: unknown): asserts value is ConfigObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfigShapeError();
  }

  const stack: ConfigWalkEntry[] = [{ kind: "visit", value, depth: 0 }];
  const activeAncestors = new WeakSet<object>();
  let scheduledNodes = 1;
  let totalObjectKeys = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;
    if (entry.kind === "leave") {
      activeAncestors.delete(entry.value);
      continue;
    }
    if (entry.depth > MAX_CONFIG_STRUCTURE_DEPTH) {
      throw configStructureLimitError();
    }

    const entryType = typeof entry.value;
    if (
      entry.value === null ||
      entry.value === undefined ||
      entryType === "boolean" ||
      entryType === "number" ||
      entryType === "string"
    ) {
      continue;
    }
    if (entryType !== "object") {
      throw invalidConfigShapeError();
    }

    const objectValue = entry.value as object;
    if (activeAncestors.has(objectValue)) throw configStructureLimitError();
    activeAncestors.add(objectValue);
    stack.push({ kind: "leave", value: objectValue });

    let children: unknown[];
    if (Array.isArray(entry.value)) {
      if (entry.value.length > MAX_CONFIG_ARRAY_LENGTH) {
        throw configStructureLimitError();
      }
      children = Array.from({ length: entry.value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(entry.value, String(index));
        if (!descriptor) return undefined;
        if (!("value" in descriptor)) throw invalidConfigShapeError();
        return descriptor.value;
      });
    } else {
      const prototype = Object.getPrototypeOf(entry.value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidConfigShapeError();
      }
      const keys = Object.keys(entry.value);
      totalObjectKeys += keys.length;
      if (keys.length > MAX_CONFIG_OBJECT_KEYS || totalObjectKeys > MAX_CONFIG_TOTAL_KEYS) {
        throw configStructureLimitError();
      }
      children = keys.map((key) => readOwnDataValue(entry.value as object, key));
    }

    scheduledNodes += children.length;
    if (scheduledNodes > MAX_CONFIG_STRUCTURE_NODES) throw configStructureLimitError();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ kind: "visit", value: children[index], depth: entry.depth + 1 });
    }
  }
}

/** Parse raw agent configuration according to its manifest-declared format. */
export function parseConfig(raw: string, format: string): ConfigObject {
  let parsed: unknown;
  if (format === "yaml") {
    const YAML = require("yaml") as {
      parse: (text: string) => unknown;
    };
    try {
      parsed = YAML.parse(raw);
    } catch {
      throw new Error("Invalid YAML configuration syntax.");
    }
  } else if (format === "toml") {
    const TOML = require("smol-toml") as {
      parse: (text: string) => unknown;
    };
    try {
      parsed = TOML.parse(raw);
    } catch {
      throw new Error("Invalid TOML configuration syntax.");
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON configuration syntax.");
    }
  }
  assertSafeConfigStructure(parsed);
  return parsed;
}

/** Serialize mutable agent configuration without corrupting TOML inputs. */
export function serializeConfig(config: ConfigObject, format: string): string {
  if (format === "yaml") {
    return require("yaml").stringify(config);
  }
  if (format === "toml") {
    throw new Error("config set is not supported for TOML-format agents.");
  }
  return JSON.stringify(config, null, 2);
}
