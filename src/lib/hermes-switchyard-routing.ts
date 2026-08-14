// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

export const HERMES_SWITCHYARD_PLUGIN_MANIFEST = "/opt/switchyard-relay-plugin/relay-plugin.toml";
export const HERMES_SWITCHYARD_RELAY_TOML = "/usr/local/share/nemoclaw/hermes-relay-plugins.toml";
export const HERMES_SWITCHYARD_RUNTIME_BINDINGS =
  "/usr/local/share/nemoclaw/hermes-switchyard-runtime-bindings.json";

export const HERMES_SWITCHYARD_TARGET_ROLES = ["judge", "weak", "strong"] as const;
export type HermesSwitchyardTargetRole = (typeof HERMES_SWITCHYARD_TARGET_ROLES)[number];

export interface HermesSwitchyardHeaderEnvironment {
  readonly headerName: string;
  readonly envKey: string;
}

export interface HermesSwitchyardTarget {
  readonly role: HermesSwitchyardTargetRole;
  readonly baseUrl: string;
  readonly model: string;
  readonly protocol: "openai_chat";
  readonly headerEnv: readonly HermesSwitchyardHeaderEnvironment[];
}

export interface HermesSwitchyardRouting {
  readonly algorithm: "llm_classifier";
  readonly baseThreshold: number;
  readonly targets: readonly HermesSwitchyardTarget[];
}

export class HermesSwitchyardRoutingError extends Error {
  constructor(message: string) {
    super(`Invalid Hermes Switchyard routing: ${message}`);
    this.name = "HermesSwitchyardRoutingError";
  }
}

const ROUTING_KEYS = new Set(["algorithm", "baseThreshold", "targets"]);
const TARGET_KEYS = new Set(["role", "baseUrl", "model", "protocol", "headerEnv"]);
const HEADER_ENV_KEYS = new Set(["headerName", "envKey"]);
const ROLE_SET = new Set<string>(HERMES_SWITCHYARD_TARGET_ROLES);
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const ALLOWED_PROVIDER_HEADER_NAMES = new Set(["api-key", "authorization", "x-api-key"]);
const HEADER_ENV_KEY_RE = /^SWITCHYARD_[A-Z][A-Z0-9_]{0,111}$/u;
const MAX_MODEL_BYTES = 1024;
const MAX_URL_BYTES = 2048;
const MAX_HEADER_ENV_BINDINGS = 8;

function fail(message: string): never {
  throw new HermesSwitchyardRoutingError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${where} must be an object`);
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${where} contains unsupported fields`);
  }
}

function boundedString(value: unknown, where: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    fail(`${where} must be bounded non-empty text without control characters`);
  }
  return value;
}

function httpsBaseUrl(value: unknown, where: string): string {
  const raw = boundedString(value, where, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`${where} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail(`${where} must be a credential-free HTTPS URL without query or fragment data`);
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return pathname === "" ? parsed.origin : `${parsed.origin}${pathname}`;
}

function validateHeaderEnvironment(
  value: unknown,
  targetWhere: string,
): readonly HermesSwitchyardHeaderEnvironment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HEADER_ENV_BINDINGS) {
    fail(`${targetWhere}.headerEnv must contain 1-${String(MAX_HEADER_ENV_BINDINGS)} bindings`);
  }
  const seenHeaders = new Set<string>();
  const seenEnvironmentKeys = new Set<string>();
  const bindings = value.map((candidate, index) => {
    const where = `${targetWhere}.headerEnv[${String(index)}]`;
    const binding = record(candidate, where);
    rejectUnknownKeys(binding, HEADER_ENV_KEYS, where);
    const rawHeaderName = boundedString(binding.headerName, `${where}.headerName`, 128);
    if (!HEADER_NAME_RE.test(rawHeaderName)) fail(`${where}.headerName is not a safe HTTP header`);
    const headerName = rawHeaderName.toLowerCase();
    if (!ALLOWED_PROVIDER_HEADER_NAMES.has(headerName)) {
      fail(`${where}.headerName is not an allowed provider credential header`);
    }
    const envKey = boundedString(binding.envKey, `${where}.envKey`, 128);
    if (!HEADER_ENV_KEY_RE.test(envKey)) {
      fail(`${where}.envKey must be a SWITCHYARD_ prefixed environment key`);
    }
    if (seenHeaders.has(headerName)) fail(`${targetWhere}.headerEnv contains duplicate headers`);
    if (seenEnvironmentKeys.has(envKey)) {
      fail(`${targetWhere}.headerEnv contains duplicate environment keys`);
    }
    seenHeaders.add(headerName);
    seenEnvironmentKeys.add(envKey);
    return { headerName, envKey };
  });
  return bindings.sort((left, right) =>
    left.headerName < right.headerName ? -1 : left.headerName > right.headerName ? 1 : 0,
  );
}

function validateTarget(value: unknown, index: number): HermesSwitchyardTarget {
  const where = `targets[${String(index)}]`;
  const target = record(value, where);
  rejectUnknownKeys(target, TARGET_KEYS, where);
  const role = boundedString(target.role, `${where}.role`, 16);
  if (!ROLE_SET.has(role)) fail(`${where}.role is not supported`);
  const model = boundedString(target.model, `${where}.model`, MAX_MODEL_BYTES);
  if (target.protocol !== "openai_chat") fail(`${where}.protocol must be openai_chat`);
  return {
    role: role as HermesSwitchyardTargetRole,
    baseUrl: httpsBaseUrl(target.baseUrl, `${where}.baseUrl`),
    model,
    protocol: "openai_chat",
    headerEnv: validateHeaderEnvironment(target.headerEnv, where),
  };
}

/** Validate and canonicalize the bounded, secret-free native routing contract. */
export function validateHermesSwitchyardRouting(value: unknown): HermesSwitchyardRouting {
  const routing = record(value, "routing");
  rejectUnknownKeys(routing, ROUTING_KEYS, "routing");
  if (routing.algorithm !== "llm_classifier") {
    fail("algorithm must be llm_classifier");
  }
  if (
    typeof routing.baseThreshold !== "number" ||
    !Number.isFinite(routing.baseThreshold) ||
    routing.baseThreshold < 0 ||
    routing.baseThreshold > 1
  ) {
    fail("baseThreshold must be a finite number from 0 through 1");
  }
  if (!Array.isArray(routing.targets) || routing.targets.length !== 3) {
    fail("targets must contain exactly judge, weak, and strong");
  }
  const byRole = new Map<HermesSwitchyardTargetRole, HermesSwitchyardTarget>();
  const modelIds = new Set<string>();
  const baseUrls = new Set<string>();
  const environmentKeys = new Set<string>();
  for (let index = 0; index < routing.targets.length; index += 1) {
    const target = validateTarget(routing.targets[index], index);
    if (byRole.has(target.role)) fail(`targets contains duplicate role ${target.role}`);
    if (modelIds.has(target.model)) fail("targets must use unique model IDs");
    if (baseUrls.has(target.baseUrl)) fail("targets must use distinct dispatch base URLs");
    for (const binding of target.headerEnv) {
      if (environmentKeys.has(binding.envKey)) {
        fail("targets must not reuse header environment keys");
      }
      environmentKeys.add(binding.envKey);
    }
    byRole.set(target.role, target);
    modelIds.add(target.model);
    baseUrls.add(target.baseUrl);
  }
  const targets = HERMES_SWITCHYARD_TARGET_ROLES.map((role) => {
    const target = byRole.get(role);
    if (!target) fail(`targets is missing role ${role}`);
    return target;
  });
  return {
    algorithm: "llm_classifier",
    baseThreshold: routing.baseThreshold,
    targets,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export type HermesSwitchyardTomlScalar = string | number | boolean;

/** Serialize the exact runtime env keys that the Hermes startup guard must validate. */
export function serializeHermesSwitchyardRuntimeBindings(value: HermesSwitchyardRouting): string {
  const routing = validateHermesSwitchyardRouting(value);
  return `${JSON.stringify({
    schemaVersion: 1,
    targets: routing.targets.map(({ headerEnv, role }) => ({
      headerEnv: headerEnv.map(({ envKey, headerName }) => ({ envKey, headerName })),
      role,
    })),
  })}\n`;
}

/**
 * Parse the intentionally small TOML subset emitted below. Root promotion uses
 * this syntax check before comparing the bytes with the profile-derived form.
 */
export function parseHermesSwitchyardRelayToml(
  source: string,
): ReadonlyMap<string, ReadonlyMap<string, HermesSwitchyardTomlScalar>> {
  if (source.length === 0 || source.includes("\r") || !source.endsWith("\n")) {
    fail("Relay TOML must be non-empty canonical UTF-8 text ending in one newline");
  }
  const sections = new Map<string, Map<string, HermesSwitchyardTomlScalar>>();
  let sectionName = "<root>";
  sections.set(sectionName, new Map());
  for (const [index, line] of source.slice(0, -1).split("\n").entries()) {
    if (line === "") continue;
    const arrayTable = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/u);
    const table = line.match(/^\[([A-Za-z0-9_.-]+)\]$/u);
    if (arrayTable) {
      const base = arrayTable[1] as string;
      let instance = 0;
      while (sections.has(`${base}#${String(instance)}`)) instance += 1;
      sectionName = `${base}#${String(instance)}`;
      sections.set(sectionName, new Map());
      continue;
    }
    if (table) {
      sectionName = table[1] as string;
      if (sections.has(sectionName)) fail(`Relay TOML repeats table ${sectionName}`);
      sections.set(sectionName, new Map());
      continue;
    }
    const assignment = line.match(/^((?:[A-Za-z_][A-Za-z0-9_-]*)|(?:"(?:[^"\\]|\\.)+")) = (.+)$/u);
    if (!assignment) fail(`Relay TOML has unsupported syntax on line ${String(index + 1)}`);
    const rawKey = assignment[1] as string;
    const rawValue = assignment[2] as string;
    let key: string;
    try {
      key = rawKey.startsWith('"') ? (JSON.parse(rawKey) as string) : rawKey;
    } catch {
      fail(`Relay TOML has an invalid quoted key on line ${String(index + 1)}`);
    }
    let parsed: HermesSwitchyardTomlScalar;
    if (rawValue.startsWith('"')) {
      try {
        parsed = JSON.parse(rawValue) as string;
      } catch {
        fail(`Relay TOML has an invalid string on line ${String(index + 1)}`);
      }
      if (typeof parsed !== "string")
        fail(`Relay TOML string is malformed on line ${String(index + 1)}`);
    } else if (rawValue === "true" || rawValue === "false") {
      parsed = rawValue === "true";
    } else if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(rawValue)) {
      parsed = Number(rawValue);
      if (!Number.isFinite(parsed))
        fail(`Relay TOML number is invalid on line ${String(index + 1)}`);
    } else {
      fail(`Relay TOML has an unsupported value on line ${String(index + 1)}`);
    }
    const section = sections.get(sectionName);
    if (!section) fail("Relay TOML parser lost its current table");
    if (section.has(key)) fail(`Relay TOML repeats key ${key} in ${sectionName}`);
    section.set(key, parsed);
  }
  return sections;
}

/** Serialize the exact Switchyard-owned dynamic-plugin contract consumed by Relay. */
export function serializeHermesSwitchyardRelayToml(value: HermesSwitchyardRouting): string {
  const routing = validateHermesSwitchyardRouting(value);
  const lines = [
    "version = 1",
    "",
    "[[plugins.dynamic]]",
    `manifest = ${tomlString(HERMES_SWITCHYARD_PLUGIN_MANIFEST)}`,
    "",
    "[plugins.dynamic.config]",
    "version = 2",
    "priority = 0",
    "max_retries = 3",
    'failure_mode = "fail_closed"',
    "",
    "[plugins.dynamic.config.algorithm]",
    'kind = "llm_classifier"',
    'mode = "capability"',
    'classifier_target = "judge"',
    'weak_target = "weak"',
    'strong_target = "strong"',
    `base_threshold = ${String(routing.baseThreshold)}`,
    "",
    "[plugins.dynamic.config.default_targets]",
    'openai_chat = "weak"',
  ];
  for (const target of routing.targets) {
    const prefix = `plugins.dynamic.config.targets.${target.role}`;
    lines.push(
      "",
      `[${prefix}]`,
      `model = ${tomlString(target.model)}`,
      `protocol = ${tomlString(target.protocol)}`,
      'endpoint = "/v1/chat/completions"',
      `base_url = ${tomlString(target.baseUrl)}`,
      "weight = 1",
      "drop_caller_extra_body = true",
      "",
      `[${prefix}.header_env]`,
      ...target.headerEnv.map(
        ({ headerName, envKey }) => `${tomlString(headerName)} = ${tomlString(envKey)}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
