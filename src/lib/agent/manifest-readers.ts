// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isSafeModelId } from "../validation";
import type {
  AgentDashboard,
  AgentDashboardKind,
  AgentHealthProbe,
  AgentInference,
  AgentMcpCapability,
  AgentStateFile,
  AgentStateFileStrategy,
  AgentVersionScheme,
  ManifestRecord,
  ManifestValue,
  StateFileFreshHeader,
  StateFileRestoreOwnership,
  StateFileUserKey,
  StateFileUserKeyType,
  StringMap,
} from "./definition-types";

const yaml: { load(input: string): unknown } = require("js-yaml");

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

export function readString(record: ManifestRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readBoolean(record: ManifestRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readVersionScheme(record: ManifestRecord): AgentVersionScheme | undefined {
  const value = record.version_scheme;
  if (value === "semver" || value === "calendar") return value;
  return undefined;
}

export function readObject(record: ManifestRecord, key: string): ManifestRecord | undefined {
  const value = record[key];
  return isManifestRecord(value) ? value : undefined;
}

export function readStringArray(record: ManifestRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function readUserManagedFiles(record: ManifestRecord): string[] | undefined {
  const value = record.user_managed_files;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'user_managed_files' must be an array");
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must be a string`,
      );
    }
    if (entry.length === 0) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not be empty`,
      );
    }
    if (CONTROL_CHAR_RE.test(entry)) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not contain control characters`,
      );
    }
    if (entry.startsWith("/")) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must be a relative path, not absolute`,
      );
    }
    const segments = entry.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error(
        `Agent manifest field 'user_managed_files[${String(index)}]' must not contain '..' path components`,
      );
    }
    return entry;
  });
}

const STATE_FILE_MERGE_STRATEGIES = ["key-allowlist", "openclaw-config"] as const;
const STATE_FILE_USER_KEY_TYPES: readonly StateFileUserKeyType[] = [
  "boolean",
  "string",
  "integer",
  "number",
  "enum",
];

function readNumber(record: ManifestRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertDottedKey(key: string, field: string): void {
  if (CONTROL_CHAR_RE.test(key)) {
    throw new Error(`Agent manifest field '${field}' must not contain control characters`);
  }
  if (key.split(".").some((segment) => segment.length === 0)) {
    throw new Error(`Agent manifest field '${field}' must not contain empty path segments`);
  }
}

function readStateFileUserKey(raw: ManifestValue, field: string): StateFileUserKey {
  if (!isManifestRecord(raw)) {
    throw new Error(`Agent manifest field '${field}' must be an object`);
  }
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
    const headerValue = readString(raw, "value");
    if (!headerValue) {
      throw new Error(`Agent manifest field '${itemField}.value' is required`);
    }
    const match = readString(raw, "match") ?? "exact";
    if (match !== "exact" && match !== "prefix") {
      throw new Error(`Agent manifest field '${itemField}.match' must be exact or prefix`);
    }
    return { match, value: headerValue };
  });
}

function readStateFileRestore(
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
  const ownership: StateFileRestoreOwnership = { merge: "key-allowlist", userKeys };
  const requireFreshTables = readStateFileDottedKeys(
    value,
    "require_fresh_tables",
    `${field}.require_fresh_tables`,
  );
  if (requireFreshTables) ownership.requireFreshTables = requireFreshTables;
  const requireFreshHeaders = readStateFileFreshHeaders(value, `${field}.require_fresh_headers`);
  if (requireFreshHeaders) ownership.requireFreshHeaders = requireFreshHeaders;
  return ownership;
}

export function readStateFiles(record: ManifestRecord): AgentStateFile[] | undefined {
  const value = record.state_files;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'state_files' must be an array");
  }

  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: entry, strategy: "copy" };
    }
    if (!isManifestRecord(entry)) {
      throw new Error(
        `Agent manifest field 'state_files[${String(index)}]' must be a string or object`,
      );
    }
    const statePath = readString(entry, "path");
    if (!statePath) {
      throw new Error(`Agent manifest field 'state_files[${String(index)}].path' is required`);
    }
    const rawStrategy = readString(entry, "strategy") ?? "copy";
    if (rawStrategy !== "copy" && rawStrategy !== "sqlite_backup") {
      throw new Error(
        `Agent manifest field 'state_files[${String(index)}].strategy' must be copy or sqlite_backup`,
      );
    }
    const restore = readStateFileRestore(entry, index, rawStrategy);
    return restore
      ? { path: statePath, strategy: rawStrategy, restore }
      : { path: statePath, strategy: rawStrategy };
  });
}

function isValidPort(value: unknown, min = 1): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= 65535;
}

export function readPortArray(record: ManifestRecord, key: string): number[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Agent manifest field '${key}' must be an array of TCP ports`);
  }

  const ports = value.map((entry, index) => {
    if (!isValidPort(entry, 1024)) {
      throw new Error(
        `Agent manifest field '${key}[${String(index)}]' must be an integer TCP port between 1024 and 65535`,
      );
    }
    return entry;
  });

  return ports.length > 0 ? ports : undefined;
}

export function readStringMap(record: ManifestRecord, key: string): StringMap | undefined {
  const value = readObject(record, key);
  if (!value) return undefined;

  const result: StringMap = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[entryKey] = entryValue;
    }
  }
  return result;
}

export function readHealthProbe(record: ManifestRecord): AgentHealthProbe | undefined {
  const healthProbe = readObject(record, "health_probe");
  if (!healthProbe) return undefined;

  const url = readString(healthProbe, "url");
  const port = healthProbe.port;
  const timeoutSeconds = healthProbe.timeout_seconds;

  if (port !== undefined && !isValidPort(port)) {
    throw new Error(
      "Agent manifest field 'health_probe.port' must be an integer TCP port between 1 and 65535",
    );
  }

  if (
    typeof url === "string" &&
    isValidPort(port) &&
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds)
  ) {
    return { url, port, timeout_seconds: timeoutSeconds };
  }

  return undefined;
}

export function readDashboard(record: ManifestRecord): AgentDashboard {
  const dashboard = readObject(record, "dashboard") ?? {};
  const rawKind = dashboard.kind;
  if (rawKind !== undefined && rawKind !== "ui" && rawKind !== "api") {
    throw new Error("Agent manifest field 'dashboard.kind' must be ui or api");
  }
  const kind: AgentDashboardKind = rawKind === "api" ? "api" : "ui";
  const defaultLabel = kind === "api" ? "API" : "UI";
  const normalizedLabel = typeof dashboard.label === "string" ? dashboard.label.trim() : "";

  const normalizePath = (key: "path" | "health_path", fallback: string): string => {
    const value = dashboard[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error(`Agent manifest field 'dashboard.${key}' must be an absolute path`);
    }
    return value.trim() || fallback;
  };

  const rawAuth = dashboard.auth;
  if (
    rawAuth !== undefined &&
    rawAuth !== "url_token" &&
    rawAuth !== "session" &&
    rawAuth !== "none"
  ) {
    throw new Error("Agent manifest field 'dashboard.auth' must be url_token, session, or none");
  }

  return {
    kind,
    label: normalizedLabel || defaultLabel,
    path: normalizePath("path", "/"),
    healthPath: normalizePath("health_path", "/health"),
    auth: rawAuth ?? (kind === "api" ? "none" : "url_token"),
  };
}

export function readInference(record: ManifestRecord): AgentInference | undefined {
  const inference = readObject(record, "inference");
  if (!inference) return undefined;

  const providerType = inference.provider_type;
  if (providerType !== undefined && typeof providerType !== "string") {
    throw new Error("Agent manifest field 'inference.provider_type' must be a string");
  }

  const providerOptions = inference.provider_options;
  let providerOptionList: string[] | undefined;
  if (providerOptions !== undefined) {
    if (
      !Array.isArray(providerOptions) ||
      providerOptions.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(
        "Agent manifest field 'inference.provider_options' must be an array of strings",
      );
    }
    providerOptionList = providerOptions as string[];
  }

  const defaultModel = inference.default_model;
  if (
    defaultModel !== undefined &&
    (typeof defaultModel !== "string" || !isSafeModelId(defaultModel.trim()))
  ) {
    throw new Error("Agent manifest field 'inference.default_model' must be a safe model ID");
  }

  return {
    provider_type: providerType,
    provider_options: providerOptionList,
    default_model: typeof defaultModel === "string" ? defaultModel.trim() : undefined,
  };
}

export function readMcpCapability(record: ManifestRecord): AgentMcpCapability {
  const mcp = readObject(record, "mcp");
  if (!mcp) {
    return { support: "disabled", reason: "MCP support is not declared for this agent." };
  }

  const support = readString(mcp, "support");
  if (support !== "bridge" && support !== "disabled") {
    throw new Error("Agent manifest field 'mcp.support' must be bridge or disabled");
  }

  const adapter = readString(mcp, "adapter");
  if (
    adapter !== undefined &&
    adapter !== "mcporter" &&
    adapter !== "hermes-config" &&
    adapter !== "deepagents-config"
  ) {
    throw new Error(
      "Agent manifest field 'mcp.adapter' must be mcporter, hermes-config, or deepagents-config",
    );
  }
  if (support === "bridge" && !adapter) {
    throw new Error("Agent manifest field 'mcp.adapter' is required when mcp.support is bridge");
  }
  if (support === "disabled" && adapter) {
    throw new Error("Agent manifest field 'mcp.adapter' is only valid when mcp.support is bridge");
  }

  const reason = readString(mcp, "reason")?.trim();
  return {
    support,
    ...(adapter ? { adapter } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function loadManifestRecord(manifestPath: string): ManifestRecord {
  const parsed = yaml.load(fs.readFileSync(manifestPath, "utf8"));
  if (!isManifestRecord(parsed)) {
    throw new Error(`Agent manifest must be a YAML object: ${manifestPath}`);
  }
  return parsed;
}
