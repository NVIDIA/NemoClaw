// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isPlainObject } from "../core/json-types";
import { isLoopbackHostname } from "../private-networks";
import { isSafeModelId } from "../validation";
import type {
  AgentDashboard,
  AgentDashboardKind,
  AgentHealthProbe,
  AgentInference,
  AgentMcpCapability,
  AgentSelfReport,
  AgentStateFile,
  AgentVersionScheme,
  ManifestRecord,
  ManifestValue,
  StringMap,
} from "./definition-types";
import { readStateFileRestore } from "./state-file-restore-reader";

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
  if (!isPlainObject(value)) return false;
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
const STATE_FILE_FIELDS = new Set(["path", "strategy", "restore"]);
const SELF_REPORT_FIELDS = new Set(["url", "timeout_seconds"]);
const SELF_REPORT_DEFAULT_TIMEOUT_SECONDS = 10;
const SELF_REPORT_MAX_TIMEOUT_SECONDS = 10;
const SELF_REPORT_MAX_URL_LENGTH = 2048;

function assertStateFilePath(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`Agent manifest field '${field}' must not be empty`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Agent manifest field '${field}' must not contain control characters`);
  }
  if (value.startsWith("/")) {
    throw new Error(`Agent manifest field '${field}' must be a relative path, not absolute`);
  }
  if (value.includes("\\")) {
    throw new Error(`Agent manifest field '${field}' must use canonical forward slashes`);
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(
      `Agent manifest field '${field}' must be a canonical relative path without empty, '.', or '..' components`,
    );
  }
}

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

export function readStateFiles(record: ManifestRecord): AgentStateFile[] | undefined {
  const value = record.state_files;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Agent manifest field 'state_files' must be an array");
  }

  return value.map((entry, index) => {
    const field = `state_files[${String(index)}]`;
    if (typeof entry === "string") {
      assertStateFilePath(entry, field);
      return { path: entry, strategy: "copy" };
    }
    if (!isManifestRecord(entry)) {
      throw new Error(`Agent manifest field '${field}' must be a string or object`);
    }
    for (const key of Object.keys(entry)) {
      if (!STATE_FILE_FIELDS.has(key)) {
        throw new Error(`Agent manifest field '${field}.${key}' is not allowed`);
      }
    }
    const statePath = readString(entry, "path");
    if (!statePath) {
      throw new Error(`Agent manifest field '${field}.path' is required`);
    }
    assertStateFilePath(statePath, `${field}.path`);
    if (entry.strategy !== undefined && typeof entry.strategy !== "string") {
      throw new Error(`Agent manifest field '${field}.strategy' must be copy or sqlite_backup`);
    }
    const rawStrategy = readString(entry, "strategy") ?? "copy";
    if (rawStrategy !== "copy" && rawStrategy !== "sqlite_backup") {
      throw new Error(`Agent manifest field '${field}.strategy' must be copy or sqlite_backup`);
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

function selfReportAllowedPorts(record: ManifestRecord): Set<number> {
  const ports = new Set(readPortArray(record, "forward_ports") ?? []);
  const healthProbePort = readObject(record, "health_probe")?.port;
  if (isValidPort(healthProbePort)) ports.add(healthProbePort);
  return ports;
}

function validateSelfReportUrl(value: string, allowedPorts: ReadonlySet<number>): string {
  if (
    value !== value.trim() ||
    value.length === 0 ||
    value.length > SELF_REPORT_MAX_URL_LENGTH ||
    CONTROL_CHAR_RE.test(value) ||
    /\s/u.test(value) ||
    value.includes("%") ||
    value.includes("\\")
  ) {
    throw new Error(
      "Agent manifest field 'self_report.url' must be a bounded canonical URL without whitespace, control characters, percent escapes, or backslashes",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Agent manifest field 'self_report.url' must be an absolute URL");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Agent manifest field 'self_report.url' must use http");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("Agent manifest field 'self_report.url' must target a loopback host");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Agent manifest field 'self_report.url' must not include credentials");
  }
  const port = Number(parsed.port);
  if (!parsed.port || !isValidPort(port, 1024)) {
    throw new Error(
      "Agent manifest field 'self_report.url' must include an explicit TCP port between 1024 and 65535",
    );
  }
  if (!allowedPorts.has(port)) {
    throw new Error(
      "Agent manifest field 'self_report.url' port must be declared by health_probe.port or forward_ports",
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Agent manifest field 'self_report.url' must not include a query or fragment");
  }
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const rawPath = pathStart === -1 ? "/" : value.slice(pathStart);
  const pathSegments = rawPath.slice(1).split("/");
  if (
    rawPath === "/" ||
    rawPath !== parsed.pathname ||
    pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Agent manifest field 'self_report.url' must include a canonical non-root endpoint path without empty or dot segments",
    );
  }
  return value;
}

export function readSelfReport(record: ManifestRecord): AgentSelfReport | undefined {
  if (record.self_report === undefined) return undefined;
  const selfReport = readObject(record, "self_report");
  if (!selfReport) {
    throw new Error("Agent manifest field 'self_report' must be an object");
  }
  for (const key of Object.keys(selfReport)) {
    if (!SELF_REPORT_FIELDS.has(key)) {
      throw new Error(`Agent manifest field 'self_report.${key}' is not allowed`);
    }
  }

  const url = readString(selfReport, "url");
  if (!url) {
    throw new Error("Agent manifest field 'self_report.url' is required");
  }

  const timeoutSeconds = selfReport.timeout_seconds ?? SELF_REPORT_DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > SELF_REPORT_MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `Agent manifest field 'self_report.timeout_seconds' must be an integer between 1 and ${String(SELF_REPORT_MAX_TIMEOUT_SECONDS)}`,
    );
  }

  return {
    url: validateSelfReportUrl(url, selfReportAllowedPorts(record)),
    timeout_seconds: timeoutSeconds,
  };
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
