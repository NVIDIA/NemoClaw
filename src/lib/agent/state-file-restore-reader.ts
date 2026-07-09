// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AgentStateFileStrategy,
  ManifestRecord,
  ManifestValue,
  StateFileFreshHeader,
  StateFileRestoreOwnership,
  StateFileUserKey,
  StateFileUserKeyType,
} from "./definition-types";

function isManifestValue(value: unknown): value is ManifestValue {
  if (value === null || value instanceof Date) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isManifestValue(entry));
  }
  return isManifestRecord(value);
}

function isManifestRecord(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every((entry) => isManifestValue(entry));
}

function readString(record: ManifestRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: ManifestRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function assertDottedKey(key: string, field: string): void {
  if (CONTROL_CHAR_RE.test(key)) {
    throw new Error(`Agent manifest field '${field}' must not contain control characters`);
  }
  if (key.split(".").some((segment) => segment.length === 0)) {
    throw new Error(`Agent manifest field '${field}' must not contain empty path segments`);
  }
}

function dottedKeysOverlap(left: string, right: string): boolean {
  const leftSegments = left.split(".");
  const rightSegments = right.split(".");
  const sharedLength = Math.min(leftSegments.length, rightSegments.length);
  return leftSegments.slice(0, sharedLength).every((segment, index) => {
    return segment === rightSegments[index];
  });
}

function assertNonOverlappingDottedKeys(keys: readonly string[], field: string): void {
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      if (dottedKeysOverlap(keys[left] ?? "", keys[right] ?? "")) {
        throw new Error(
          `Agent manifest fields '${field}[${String(left)}]' and '${field}[${String(right)}]' must not duplicate or contain one another`,
        );
      }
    }
  }
}

function assertKnownFields(
  record: ManifestRecord,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Agent manifest field '${field}.${key}' is not allowed`);
    }
  }
}

const STATE_FILE_MERGE_STRATEGIES = ["key-allowlist", "openclaw-config"] as const;
const STATE_FILE_USER_KEY_TYPES: readonly StateFileUserKeyType[] = [
  "boolean",
  "string",
  "integer",
  "number",
  "enum",
];
const STATE_FILE_RESTORE_FIELDS = new Set([
  "merge",
  "user_keys",
  "require_fresh_tables",
  "require_fresh_headers",
]);
const STATE_FILE_USER_KEY_FIELDS = new Set(["key", "type", "values", "min", "max", "max_length"]);
const STATE_FILE_FRESH_HEADER_FIELDS = new Set(["match", "value"]);

function readStateFileUserKey(raw: ManifestValue, field: string): StateFileUserKey {
  if (!isManifestRecord(raw)) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
  assertKnownFields(raw, STATE_FILE_USER_KEY_FIELDS, field);
  const key = readString(raw, "key");
  if (!key) {
    throw new Error(`Agent manifest field '${field}.key' is required`);
  }
  assertDottedKey(key, `${field}.key`);
  const type = readString(raw, "type");
  if (!type || !(STATE_FILE_USER_KEY_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Agent manifest field '${field}.type' must be one of ${STATE_FILE_USER_KEY_TYPES.join(", ")}`,
    );
  }
  const userKey: StateFileUserKey = { key, type: type as StateFileUserKeyType };

  if (type === "enum") {
    const values = raw.values;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every(
        (item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      )
    ) {
      throw new Error(
        `Agent manifest field '${field}.values' must be a non-empty array of scalars for enum type`,
      );
    }
    userKey.values = values as (string | number | boolean)[];
  } else if (raw.values !== undefined) {
    throw new Error(`Agent manifest field '${field}.values' is only allowed for enum type`);
  }

  if (type === "integer" || type === "number") {
    for (const bound of ["min", "max"] as const) {
      if (raw[bound] === undefined) continue;
      const parsed = readNumber(raw, bound);
      if (parsed === undefined) {
        throw new Error(`Agent manifest field '${field}.${bound}' must be a finite number`);
      }
      if (type === "integer" && !Number.isInteger(parsed)) {
        throw new Error(`Agent manifest field '${field}.${bound}' must be an integer`);
      }
      userKey[bound] = parsed;
    }
    if (userKey.min !== undefined && userKey.max !== undefined && userKey.min > userKey.max) {
      throw new Error(`Agent manifest field '${field}.min' must not exceed '${field}.max'`);
    }
  } else if (raw.min !== undefined || raw.max !== undefined) {
    throw new Error(
      `Agent manifest field '${field}.min'/'${field}.max' are only allowed for integer or number types`,
    );
  }

  if (type === "string") {
    if (raw.max_length !== undefined) {
      const maxLength = readNumber(raw, "max_length");
      if (maxLength === undefined || !Number.isInteger(maxLength) || maxLength < 0) {
        throw new Error(
          `Agent manifest field '${field}.max_length' must be a non-negative integer`,
        );
      }
      userKey.maxLength = maxLength;
    }
  } else if (raw.max_length !== undefined) {
    throw new Error(`Agent manifest field '${field}.max_length' is only allowed for string type`);
  }

  return userKey;
}

function readStateFileDottedKeys(
  record: ManifestRecord,
  key: string,
  field: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Agent manifest field '${field}' must be a non-empty array`);
  }
  return value.map((raw, index) => {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(
        `Agent manifest field '${field}[${String(index)}]' must be a non-empty string`,
      );
    }
    assertDottedKey(raw, `${field}[${String(index)}]`);
    return raw;
  });
}

function readStateFileFreshHeaders(
  record: ManifestRecord,
  field: string,
): StateFileFreshHeader[] | undefined {
  const value = record.require_fresh_headers;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Agent manifest field '${field}' must be a non-empty array`);
  }
  return value.map((raw, index) => {
    const itemField = `${field}[${String(index)}]`;
    if (typeof raw === "string") {
      if (raw.length === 0) {
        throw new Error(`Agent manifest field '${itemField}' must not be empty`);
      }
      return { match: "exact", value: raw };
    }
    if (!isManifestRecord(raw)) {
      throw new Error(`Agent manifest field '${itemField}' must be a string or object`);
    }
    assertKnownFields(raw, STATE_FILE_FRESH_HEADER_FIELDS, itemField);
    const headerValue = readString(raw, "value");
    if (!headerValue) {
      throw new Error(`Agent manifest field '${itemField}.value' is required`);
    }
    if (raw.match !== undefined && typeof raw.match !== "string") {
      throw new Error(`Agent manifest field '${itemField}.match' must be a string`);
    }
    const match = readString(raw, "match") ?? "exact";
    if (match !== "exact" && match !== "prefix") {
      throw new Error(`Agent manifest field '${itemField}.match' must be exact or prefix`);
    }
    return { match, value: headerValue };
  });
}

export function readStateFileRestore(
  entry: ManifestRecord,
  index: number,
  strategy: AgentStateFileStrategy,
): StateFileRestoreOwnership | undefined {
  const value = entry.restore;
  if (value === undefined) return undefined;
  const field = `state_files[${String(index)}].restore`;
  if (!isManifestRecord(value)) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
  assertKnownFields(value, STATE_FILE_RESTORE_FIELDS, field);
  if (strategy !== "copy") {
    throw new Error(`Agent manifest field '${field}' requires strategy 'copy'`);
  }
  const merge = readString(value, "merge");
  if (!merge || !(STATE_FILE_MERGE_STRATEGIES as readonly string[]).includes(merge)) {
    throw new Error(
      `Agent manifest field '${field}.merge' must be one of ${STATE_FILE_MERGE_STRATEGIES.join(", ")}`,
    );
  }

  if (merge === "openclaw-config") {
    for (const disallowed of ["user_keys", "require_fresh_tables", "require_fresh_headers"]) {
      if (value[disallowed] !== undefined) {
        throw new Error(
          `Agent manifest field '${field}.${disallowed}' is not allowed for merge 'openclaw-config'`,
        );
      }
    }
    return { merge: "openclaw-config" };
  }

  const userKeysValue = value.user_keys;
  if (!Array.isArray(userKeysValue) || userKeysValue.length === 0) {
    throw new Error(`Agent manifest field '${field}.user_keys' must be a non-empty array`);
  }
  const userKeys = userKeysValue.map((raw, keyIndex) =>
    readStateFileUserKey(raw, `${field}.user_keys[${String(keyIndex)}]`),
  );
  assertNonOverlappingDottedKeys(
    userKeys.map((entry) => entry.key),
    `${field}.user_keys`,
  );
  const ownership: StateFileRestoreOwnership = { merge: "key-allowlist", userKeys };
  const requireFreshTables = readStateFileDottedKeys(
    value,
    "require_fresh_tables",
    `${field}.require_fresh_tables`,
  );
  if (requireFreshTables) {
    assertNonOverlappingDottedKeys(requireFreshTables, `${field}.require_fresh_tables`);
    for (const [userIndex, userKey] of userKeys.entries()) {
      for (const [freshIndex, freshTable] of requireFreshTables.entries()) {
        if (dottedKeysOverlap(userKey.key, freshTable)) {
          throw new Error(
            `Agent manifest field '${field}.user_keys[${String(userIndex)}].key' must not overlap '${field}.require_fresh_tables[${String(freshIndex)}]'`,
          );
        }
      }
    }
    ownership.requireFreshTables = requireFreshTables;
  }
  const requireFreshHeaders = readStateFileFreshHeaders(value, `${field}.require_fresh_headers`);
  if (requireFreshHeaders) ownership.requireFreshHeaders = requireFreshHeaders;
  return ownership;
}
