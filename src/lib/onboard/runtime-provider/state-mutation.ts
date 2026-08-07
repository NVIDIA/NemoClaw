// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import {
  RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
  type RuntimeProviderPreparedStateMutationPlan,
  type RuntimeProviderStateMutationPlan,
  type RuntimeProviderStateMutationSelector,
} from "./contract";

const MAX_PLAN_BYTES = 64 * 1024;
const MAX_STATE_ROOT_BYTES = 4096;
const MAX_SELECTORS = 256;
const MAX_RELATIVE_PATH_BYTES = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INTENTS = new Set(["protection-transition", "restore"]);

function fail(message: string): never {
  throw new Error(`Runtime provider state mutation plan is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownPropertyDescriptors(value: object, label: string): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(`${label} must expose fixed data properties`);
  }
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const descriptors = ownPropertyDescriptors(value, label);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail(`${label} fields are unsupported`);
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(`${label} must expose fixed data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotBoundedArray(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be one non-empty bounded array`);
  const descriptors = ownPropertyDescriptors(value, label);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maxLength
  ) {
    fail(`${label} must be one non-empty bounded array`);
  }
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== length + 1 ||
    ownKeys.some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(String(key)))
  ) {
    fail(`${label} must be one dense bounded array`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(`${label} must expose fixed data properties`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((field, index) => field !== canonical[index])
  ) {
    fail(`${label} fields are unsupported`);
  }
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail(`${label} must be one bounded exact string`);
  }
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    fail(`${label} must contain only Unicode scalar values`);
  }
  return value;
}

function canonicalRelativePath(value: unknown, label: string): string {
  const candidate = boundedString(value, label, MAX_RELATIVE_PATH_BYTES);
  if (
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    path.posix.normalize(candidate) !== candidate ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a canonical relative path`);
  }
  return candidate;
}

function canonicalStateRoot(value: unknown): string {
  const candidate = boundedString(value, "state root", MAX_STATE_ROOT_BYTES);
  if (
    !candidate.startsWith("/") ||
    candidate === "/" ||
    candidate.endsWith("/") ||
    candidate.includes("\\") ||
    path.posix.normalize(candidate) !== candidate ||
    !candidate.startsWith("/sandbox/")
  ) {
    fail("state root must be one canonical absolute path below /sandbox");
  }
  return candidate;
}

function normalizeSelector(value: unknown, index: number): RuntimeProviderStateMutationSelector {
  const selector = snapshotRecord(value, `selector ${String(index)}`);
  if (selector.kind === "path") {
    requireExactKeys(selector, ["kind", "path"], `selector ${String(index)}`);
    return Object.freeze({
      kind: "path",
      path: canonicalRelativePath(selector.path, `selector ${String(index)} path`),
    });
  }
  if (selector.kind === "prefix") {
    requireExactKeys(selector, ["kind", "prefix"], `selector ${String(index)}`);
    const prefix = boundedString(selector.prefix, `selector ${String(index)} prefix`, 128);
    if (prefix === "." || prefix === ".." || !PREFIX_PATTERN.test(prefix)) {
      fail(`selector ${String(index)} prefix is not canonical`);
    }
    return Object.freeze({ kind: "prefix", prefix });
  }
  fail(`selector ${String(index)} kind is unsupported`);
}

function serializePlan(plan: RuntimeProviderStateMutationPlan): string {
  const selectors: Array<Record<string, string>> = plan.selectors.map((selector) => {
    const transport: Record<string, string> = Object.create(null);
    transport.kind = selector.kind;
    if (selector.kind === "path") transport.path = selector.path;
    else transport.prefix = selector.prefix;
    return transport;
  });
  Object.setPrototypeOf(selectors, null);

  const transport: Record<string, unknown> = Object.create(null);
  transport.schemaVersion = plan.schemaVersion;
  transport.intent = plan.intent;
  transport.stateRoot = plan.stateRoot;
  transport.selectors = selectors;
  transport.projectionSha256 = plan.projectionSha256;
  return JSON.stringify(transport);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Validate, canonicalize, clone, freeze, and digest an untrusted state plan. */
export function prepareRuntimeProviderStateMutationPlan(
  value: unknown,
): RuntimeProviderPreparedStateMutationPlan {
  const input = snapshotRecord(value, "plan");
  requireExactKeys(
    input,
    ["intent", "projectionSha256", "schemaVersion", "selectors", "stateRoot"],
    "plan",
  );
  if (input.schemaVersion !== RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION) {
    fail("plan schema version is unsupported");
  }
  if (!INTENTS.has(input.intent as string)) fail("plan intent is unsupported");
  const selectorInputs = snapshotBoundedArray(input.selectors, "selectors", MAX_SELECTORS);
  if (selectorInputs.length === 0) {
    fail("selectors must be one non-empty bounded array");
  }
  const selectors = selectorInputs.map(normalizeSelector);
  const identities = selectors.map((selector) =>
    selector.kind === "path" ? `path:${selector.path}` : `prefix:${selector.prefix}`,
  );
  if (new Set(identities).size !== identities.length) {
    fail("selectors must not repeat a path or prefix");
  }
  if (typeof input.projectionSha256 !== "string" || !SHA256_PATTERN.test(input.projectionSha256)) {
    fail("AgentDefinition projection digest must be lowercase SHA-256");
  }
  const plan = Object.freeze({
    schemaVersion: RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
    intent: input.intent as RuntimeProviderStateMutationPlan["intent"],
    stateRoot: canonicalStateRoot(input.stateRoot),
    selectors: Object.freeze(selectors),
    projectionSha256: input.projectionSha256,
  });
  const serializedPlan = serializePlan(plan);
  if (Buffer.byteLength(serializedPlan, "utf8") > MAX_PLAN_BYTES) {
    fail("canonical plan exceeds its bounded transport");
  }
  return Object.freeze({
    plan,
    planSha256: sha256(serializedPlan),
    projectionSha256: plan.projectionSha256,
  });
}
