// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import type { AgentDefinition, AgentStateLockPlan } from "../../agent/definition-types";
import {
  RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
  type RuntimeProviderPreparedStateMutationPlan,
  type RuntimeProviderStateMutationPlan,
  type RuntimeProviderStateMutationProtectionPosture,
  type RuntimeProviderStateMutationSelector,
  type RuntimeProviderStateMutationStateLockPlan,
} from "./contract";

const MAX_PLAN_BYTES = 64 * 1024;
const MAX_STATE_ROOT_BYTES = 4096;
const MAX_SELECTORS = 256;
const MAX_RELATIVE_PATH_BYTES = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const TOP_LEVEL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROTECTION_POSTURES = new Set(["locked", "mutable"]);

export type RuntimeProviderProtectionTransitionAgent = Pick<
  AgentDefinition,
  "name" | "configPaths" | "stateLockPlan"
>;

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

function canonicalPrefix(value: unknown, label: string): string {
  const prefix = boundedString(value, label, MAX_RELATIVE_PATH_BYTES);
  if (prefix === "." || prefix === ".." || !TOP_LEVEL_NAME_PATTERN.test(prefix)) {
    fail(`${label} is not canonical`);
  }
  return prefix;
}

function canonicalTopLevelName(value: unknown, label: string): string {
  const name = boundedString(value, label, MAX_RELATIVE_PATH_BYTES);
  if (name === "." || name === ".." || !TOP_LEVEL_NAME_PATTERN.test(name)) {
    fail(`${label} must contain one top-level name using ASCII letters, digits, '.', '_', or '-'`);
  }
  return name;
}

function canonicalWritableSubpath(value: unknown, label: string): string {
  const candidate = canonicalRelativePath(value, label);
  const components = candidate.split("/");
  if (components.length < 2) {
    fail(`${label} must be beneath a declared top-level root`);
  }
  if (components.some((component) => component.includes("*") && component !== "*")) {
    fail(`${label} may use '*' only as a complete path component`);
  }
  if (components.at(-1) === "*") {
    fail(`${label} may not end with a wildcard component`);
  }
  return candidate;
}

function writablePatternsOverlap(first: string, second: string): boolean {
  const firstComponents = first.split("/");
  const secondComponents = second.split("/");
  return firstComponents.every((left, index) => {
    const right = secondComponents[index];
    return right === undefined || left === "*" || right === "*" || left === right;
  });
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
    const prefix = canonicalPrefix(selector.prefix, `selector ${String(index)} prefix`);
    return Object.freeze({ kind: "prefix", prefix });
  }
  fail(`selector ${String(index)} kind is unsupported`);
}

function selectorIdentity(selector: RuntimeProviderStateMutationSelector): string {
  return selector.kind === "path" ? `path:${selector.path}` : `prefix:${selector.prefix}`;
}

function protectionPosture(
  value: unknown,
  label: string,
): RuntimeProviderStateMutationProtectionPosture {
  if (!PROTECTION_POSTURES.has(value as string)) {
    fail(`${label} must be exactly locked or mutable`);
  }
  return value as RuntimeProviderStateMutationProtectionPosture;
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
  if (plan.intent === "protection-transition") {
    transport.target = plan.target;
    transport.rollback = plan.rollback;
    transport.stateLockPlan = stateLockPlanTransport(plan.stateLockPlan);
  }
  transport.stateRoot = plan.stateRoot;
  transport.selectors = selectors;
  transport.projectionSha256 = plan.projectionSha256;
  return JSON.stringify(transport);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function prototypeFreeStringArray(values: readonly string[]): string[] {
  const copy = [...values];
  Object.setPrototypeOf(copy, null);
  return copy;
}

function stateLockPlanTransport(
  stateLockPlan: RuntimeProviderStateMutationStateLockPlan,
): Record<string, unknown> {
  const transport: Record<string, unknown> = Object.create(null);
  transport.version = stateLockPlan.version;
  transport.readOnlyRoots = prototypeFreeStringArray(stateLockPlan.readOnlyRoots);
  transport.confidentialRoots = prototypeFreeStringArray(stateLockPlan.confidentialRoots);
  transport.readOnlyPrefixes = prototypeFreeStringArray(stateLockPlan.readOnlyPrefixes);
  transport.confidentialPrefixes = prototypeFreeStringArray(stateLockPlan.confidentialPrefixes);
  transport.writableSubpaths = prototypeFreeStringArray(stateLockPlan.writableSubpaths);
  return transport;
}

function serializeAgentDefinitionProtectionProjection(
  agentName: string,
  config: {
    readonly dir: string;
    readonly configFile: string;
    readonly envFile: string | null;
    readonly shieldsFiles: readonly string[];
  },
  stateLockPlan: RuntimeProviderStateMutationStateLockPlan,
): string {
  const configTransport: Record<string, unknown> = Object.create(null);
  configTransport.dir = config.dir;
  configTransport.configFile = config.configFile;
  configTransport.envFile = config.envFile;
  configTransport.shieldsFiles = prototypeFreeStringArray(config.shieldsFiles);

  const projectionTransport: Record<string, unknown> = Object.create(null);
  projectionTransport.agentName = agentName;
  projectionTransport.config = configTransport;
  projectionTransport.stateLockPlan = stateLockPlanTransport(stateLockPlan);
  return JSON.stringify(projectionTransport);
}

function exactProjectionStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    fail(`AgentDefinition ${label} must be a string array`);
  }
  return [...values];
}

function normalizeStateLockStringArray(
  value: unknown,
  label: string,
  normalize: (entry: unknown, label: string) => string,
): readonly string[] {
  const entries = snapshotBoundedArray(value, label, MAX_SELECTORS)
    .map((entry, index) => normalize(entry, `${label} ${String(index)}`))
    .sort(compareUtf8);
  if (new Set(entries).size !== entries.length) {
    fail(`${label} must not contain duplicates`);
  }
  return Object.freeze(entries);
}

function normalizeStateLockPlan(
  value: unknown,
  label: string,
): RuntimeProviderStateMutationStateLockPlan {
  const input = snapshotRecord(value, label);
  requireExactKeys(
    input,
    [
      "confidentialPrefixes",
      "confidentialRoots",
      "readOnlyPrefixes",
      "readOnlyRoots",
      "version",
      "writableSubpaths",
    ],
    label,
  );
  if (input.version !== 1) fail(`${label} version is unsupported`);

  const readOnlyRoots = normalizeStateLockStringArray(
    input.readOnlyRoots,
    `${label} read-only roots`,
    canonicalTopLevelName,
  );
  const confidentialRoots = normalizeStateLockStringArray(
    input.confidentialRoots,
    `${label} confidential roots`,
    canonicalTopLevelName,
  );
  const readOnlyPrefixes = normalizeStateLockStringArray(
    input.readOnlyPrefixes,
    `${label} read-only prefixes`,
    canonicalPrefix,
  );
  const confidentialPrefixes = normalizeStateLockStringArray(
    input.confidentialPrefixes,
    `${label} confidential prefixes`,
    canonicalPrefix,
  );
  const writableSubpaths = normalizeStateLockStringArray(
    input.writableSubpaths,
    `${label} writable subpaths`,
    canonicalWritableSubpath,
  );

  const roots = [...readOnlyRoots, ...confidentialRoots];
  if (new Set(roots).size !== roots.length) {
    fail(`${label} assigns one root more than once`);
  }
  const prefixes = [...readOnlyPrefixes, ...confidentialPrefixes];
  if (new Set(prefixes).size !== prefixes.length) {
    fail(`${label} assigns one prefix more than once`);
  }
  if (roots.some((root) => prefixes.some((prefix) => root.startsWith(prefix)))) {
    fail(`${label} root and prefix policies must not overlap`);
  }
  for (let index = 0; index < prefixes.length; index += 1) {
    if (
      prefixes
        .slice(index + 1)
        .some((other) => prefixes[index].startsWith(other) || other.startsWith(prefixes[index]))
    ) {
      fail(`${label} prefix policies must not overlap`);
    }
  }
  if (
    writableSubpaths.some((writable) => !readOnlyRoots.includes(writable.split("/", 1)[0] ?? ""))
  ) {
    fail(`${label} writable subpaths must be beneath a read-only root`);
  }
  for (let index = 0; index < writableSubpaths.length; index += 1) {
    if (
      writableSubpaths
        .slice(index + 1)
        .some((other) => writablePatternsOverlap(writableSubpaths[index], other))
    ) {
      fail(`${label} writable subpaths must not overlap`);
    }
  }

  return Object.freeze({
    version: 1,
    readOnlyRoots,
    confidentialRoots,
    readOnlyPrefixes,
    confidentialPrefixes,
    writableSubpaths,
  });
}

function normalizedStateLockProjection(
  plan: AgentStateLockPlan,
): RuntimeProviderStateMutationStateLockPlan {
  return normalizeStateLockPlan(plan, "AgentDefinition state lock plan");
}

function requireStateLockPlanScope(
  plan: RuntimeProviderStateMutationStateLockPlan,
  selectors: readonly RuntimeProviderStateMutationSelector[],
): void {
  const identities = new Set(
    selectors.map((selector) =>
      selector.kind === "path" ? `path:${selector.path}` : `prefix:${selector.prefix}`,
    ),
  );
  const required = [
    ...plan.readOnlyRoots.map((root) => `path:${root}`),
    ...plan.confidentialRoots.map((root) => `path:${root}`),
    ...plan.readOnlyPrefixes.map((prefix) => `prefix:${prefix}`),
    ...plan.confidentialPrefixes.map((prefix) => `prefix:${prefix}`),
  ];
  if (required.some((identity) => !identities.has(identity))) {
    fail("state lock plan policy must be represented by exact selectors");
  }
}

/**
 * Compile the selected AgentDefinition protection projection into the bounded
 * provider plan. The nested state-lock policy gives a fixed helper the exact
 * recursive semantics; the projection digest also binds the selected agent
 * name, config paths, and normalized policy.
 */
export function prepareAgentDefinitionProtectionTransitionPlan(
  agent: RuntimeProviderProtectionTransitionAgent,
  target: RuntimeProviderStateMutationProtectionPosture,
  rollback: RuntimeProviderStateMutationProtectionPosture,
): RuntimeProviderPreparedStateMutationPlan {
  const config = agent.configPaths;
  const stateLockPlan = normalizedStateLockProjection(agent.stateLockPlan);
  const projection = {
    agentName: boundedString(agent.name, "AgentDefinition name", 128),
    config: {
      dir: canonicalStateRoot(config.dir),
      configFile: canonicalRelativePath(config.configFile, "AgentDefinition config file"),
      envFile:
        config.envFile === null
          ? null
          : canonicalRelativePath(config.envFile, "AgentDefinition environment file"),
      shieldsFiles: exactProjectionStrings(config.shieldsFiles, "config shields files").map(
        (value, index) =>
          canonicalRelativePath(value, `AgentDefinition shields file ${String(index)}`),
      ),
    },
    stateLockPlan,
  } as const;
  const paths = [
    projection.config.configFile,
    ".config-hash",
    ...(projection.config.envFile === null ? [] : [projection.config.envFile]),
    ...projection.config.shieldsFiles,
  ];
  const selectors: RuntimeProviderStateMutationSelector[] = [
    ...paths.map((entry) => ({ kind: "path" as const, path: entry })),
    ...stateLockPlan.readOnlyRoots.map((entry) => ({ kind: "path" as const, path: entry })),
    ...stateLockPlan.confidentialRoots.map((entry) => ({ kind: "path" as const, path: entry })),
    ...stateLockPlan.readOnlyPrefixes.map((entry) => ({ kind: "prefix" as const, prefix: entry })),
    ...stateLockPlan.confidentialPrefixes.map((entry) => ({
      kind: "prefix" as const,
      prefix: entry,
    })),
  ];
  const uniqueSelectors = new Map<string, RuntimeProviderStateMutationSelector>();
  for (const selector of selectors) {
    const identity =
      selector.kind === "path" ? `path:${selector.path}` : `prefix:${selector.prefix}`;
    uniqueSelectors.set(identity, selector);
  }
  const orderedSelectors = [...uniqueSelectors]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, selector]) => selector);
  return prepareRuntimeProviderStateMutationPlan({
    schemaVersion: RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
    intent: "protection-transition",
    target,
    rollback,
    stateRoot: projection.config.dir,
    selectors: orderedSelectors,
    stateLockPlan,
    projectionSha256: sha256(
      serializeAgentDefinitionProtectionProjection(
        projection.agentName,
        projection.config,
        stateLockPlan,
      ),
    ),
  });
}

/** Validate, canonicalize, clone, freeze, and digest an untrusted state plan. */
export function prepareRuntimeProviderStateMutationPlan(
  value: unknown,
): RuntimeProviderPreparedStateMutationPlan {
  const input = snapshotRecord(value, "plan");
  if (input.schemaVersion !== RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION) {
    fail("plan schema version is unsupported");
  }
  if (input.intent === "protection-transition") {
    requireExactKeys(
      input,
      [
        "intent",
        "projectionSha256",
        "rollback",
        "schemaVersion",
        "selectors",
        "stateLockPlan",
        "stateRoot",
        "target",
      ],
      "plan",
    );
  } else if (input.intent === "restore") {
    requireExactKeys(
      input,
      ["intent", "projectionSha256", "schemaVersion", "selectors", "stateRoot"],
      "plan",
    );
  } else {
    fail("plan intent is unsupported");
  }
  const selectorInputs = snapshotBoundedArray(input.selectors, "selectors", MAX_SELECTORS);
  if (selectorInputs.length === 0) {
    fail("selectors must be one non-empty bounded array");
  }
  const selectors = selectorInputs
    .map(normalizeSelector)
    .sort((left, right) => compareUtf8(selectorIdentity(left), selectorIdentity(right)));
  const identities = selectors.map(selectorIdentity);
  if (new Set(identities).size !== identities.length) {
    fail("selectors must not repeat a path or prefix");
  }
  if (typeof input.projectionSha256 !== "string" || !SHA256_PATTERN.test(input.projectionSha256)) {
    fail("AgentDefinition projection digest must be lowercase SHA-256");
  }
  const common = {
    schemaVersion: RUNTIME_PROVIDER_STATE_MUTATION_PLAN_SCHEMA_VERSION,
    stateRoot: canonicalStateRoot(input.stateRoot),
    selectors: Object.freeze(selectors),
    projectionSha256: input.projectionSha256,
  } as const;
  let plan: RuntimeProviderStateMutationPlan;
  if (input.intent === "protection-transition") {
    const stateLockPlan = normalizeStateLockPlan(input.stateLockPlan, "state lock plan");
    requireStateLockPlanScope(stateLockPlan, selectors);
    const target = protectionPosture(input.target, "protection-transition target");
    const rollback = protectionPosture(input.rollback, "protection-transition rollback");
    if (target === rollback) {
      fail("protection-transition target and rollback postures must differ");
    }
    plan = Object.freeze({
      ...common,
      intent: "protection-transition",
      target,
      rollback,
      stateLockPlan,
    });
  } else {
    plan = Object.freeze({ ...common, intent: "restore" });
  }
  const serializedPlan = serializePlan(plan);
  if (Buffer.byteLength(serializedPlan, "utf8") > MAX_PLAN_BYTES) {
    fail("canonical plan exceeds its bounded transport");
  }
  return Object.freeze({
    plan,
    serializedPlan,
    planSha256: sha256(serializedPlan),
    projectionSha256: plan.projectionSha256,
  });
}
