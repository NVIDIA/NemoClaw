// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isNativeError, isProxy } from "node:util/types";

import { redact, redactFull, redactFullWithUrls, redactSensitiveText } from "../../security/redact";

interface DiagnosticTask {
  source: object;
  target: object;
}

interface DiagnosticUpdate {
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor;
}

interface DiagnosticWalk {
  pending: DiagnosticTask[];
  seen: WeakMap<object, object>;
  updates: DiagnosticUpdate[];
  unsafe: boolean;
}

const CUSTOM_INSPECT = Symbol.for("nodejs.util.inspect.custom");
const UNIVERSAL_SHADOWS = [
  ["toJSON", undefined],
  [CUSTOM_INSPECT, safeDiagnosticInspect],
  ["toString", safeDiagnosticCoercion],
  ["valueOf", safeDiagnosticCoercion],
  [Symbol.toPrimitive, safeDiagnosticCoercion],
  [Symbol.toStringTag, undefined],
  ["constructor", undefined],
] as const;
const ERROR_CONTROL_SHADOWS = [
  ["bang", undefined],
  ["suggestions", undefined],
  ["skipOclifErrorHandling", undefined],
  ["showHelp", undefined],
  ["parse", undefined],
  ["oclif", undefined],
] as const;
const ERROR_RENDER_FIELDS = [
  ["name", "Error"],
  ["message", "Onboarding failed."],
  ["stack", "<REDACTED>"],
  ["code", undefined],
  ["exitCode", undefined],
  ["ref", undefined],
  ["cause", undefined],
  ["errors", undefined],
] as const;
const REDACTED_ERROR_MESSAGE =
  "Onboarding failed; diagnostic details were redacted because they could not be sanitized safely.";

/** Return a fixed primitive without consulting any diagnostic object state. */
function safeDiagnosticCoercion(): string {
  return "[REDACTED ERROR]";
}

/** Return an inert primitive when Node performs structured inspection. */
function safeDiagnosticInspect(): string {
  return "<REDACTED>";
}

/** Identify a key whose visible description contains credential material. */
function isSensitiveDiagnosticKey(key: PropertyKey): boolean {
  if (key === CUSTOM_INSPECT) return false;
  const text = typeof key === "symbol" ? (key.description ?? "") : String(key);
  return redactOnboardErrorText(text) !== text;
}

/** Renderer hooks are removed rather than treated as ordinary diagnostic values. */
function isRendererHook(key: PropertyKey): boolean {
  return key === "toJSON" || key === CUSTOM_INSPECT;
}

/** Identify coercion properties that renderers can invoke implicitly. */
function isCoercionHook(key: PropertyKey): boolean {
  return key === "toString" || key === "valueOf" || key === Symbol.toPrimitive;
}

/** Identify properties that every retained diagnostic container shadows locally. */
function isUniversalShadow(key: PropertyKey): boolean {
  return (
    isRendererHook(key) ||
    isCoercionHook(key) ||
    key === Symbol.toStringTag ||
    key === "constructor"
  );
}

/** Identify Oclif control fields that must never inherit or retain active values. */
function isErrorControlShadow(key: PropertyKey): boolean {
  return (
    key === "bang" ||
    key === "suggestions" ||
    key === "skipOclifErrorHandling" ||
    key === "showHelp" ||
    key === "parse" ||
    key === "oclif"
  );
}

/** Identify Error fields consumed by Oclif and built-in diagnostic renderers. */
function isErrorRenderField(key: PropertyKey): boolean {
  return (
    key === "name" ||
    key === "message" ||
    key === "stack" ||
    key === "code" ||
    key === "exitCode" ||
    key === "ref" ||
    key === "cause" ||
    key === "errors"
  );
}

/** Admit only native, non-Proxy Error objects to identity-preserving redaction. */
export function isTrustedOnboardError(value: unknown): value is Error {
  if (typeof value !== "object" || value === null || isProxy(value) || !isNativeError(value)) {
    return false;
  }
  let current = Object.getPrototypeOf(value) as object | null;
  while (current) {
    if (isProxy(current)) return false;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return true;
}

/** Limit property traversal to plain records so class instances retain their behavior. */
function isPlainDiagnosticObject(value: object): value is Record<PropertyKey, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Preserve Error identity and copy diagnostic containers without constructing arbitrary classes. */
function createDiagnosticTarget(value: object): object | null {
  if (isTrustedOnboardError(value)) return value;
  if (Array.isArray(value)) return [];
  if (isPlainDiagnosticObject(value)) return Object.create(null) as object;
  return null;
}

/** Reuse visited targets so shared references and cycles survive redaction without recursive calls. */
function redactNestedDiagnostic(value: unknown, walk: DiagnosticWalk): unknown {
  if (typeof value === "string") return redactOnboardErrorText(value);
  if (typeof value === "function" || typeof value === "symbol") {
    walk.unsafe = true;
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (isProxy(value)) {
    walk.unsafe = true;
    return value;
  }
  if (walk.seen.has(value)) return walk.seen.get(value);

  const target = createDiagnosticTarget(value);
  if (!target) {
    walk.unsafe = true;
    return value;
  }
  walk.seen.set(value, target);
  walk.pending.push({ source: value, target });
  return target;
}

/** Keep a native aggregate's mutable member array while enrolling it in the descriptor walk. */
function retainAggregateMembers(error: Error, walk: DiagnosticWalk): void {
  const descriptor = Object.getOwnPropertyDescriptor(error, "errors");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)) return;
  if (walk.seen.has(descriptor.value)) return;
  walk.seen.set(descriptor.value, descriptor.value);
  walk.pending.push({ source: descriptor.value, target: descriptor.value });
}

/** Replace an accessor without invoking it, or reject an immutable accessor fail closed. */
function redactAccessor(
  source: object,
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  walk: DiagnosticWalk,
): void {
  if (source !== target) return;
  if (!descriptor.configurable) {
    walk.unsafe = true;
    return;
  }
  walk.updates.push({
    target,
    key,
    descriptor: {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      value: "<REDACTED>",
      writable: true,
    },
  });
}

/** Plan one stored-value rewrite, rejecting immutable secret carriers fail closed. */
function redactStoredValue(
  source: object,
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  walk: DiagnosticWalk,
): void {
  const value = redactNestedDiagnostic(descriptor.value, walk);
  const replacement = { ...descriptor, value };
  if (source !== target) {
    Object.defineProperty(target, key, replacement);
    return;
  }
  if (Object.is(value, descriptor.value)) return;
  if (!descriptor.configurable && !descriptor.writable) {
    walk.unsafe = true;
    return;
  }
  walk.updates.push({ target, key, descriptor: replacement });
}

/** Install one safe own shadow without reading an accessor or mutating before validation. */
function installOwnShadow(
  source: object,
  target: object,
  key: PropertyKey,
  value: unknown,
  walk: DiagnosticWalk,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (source !== target) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
    return;
  }
  if (descriptor && "value" in descriptor && Object.is(descriptor.value, value)) return;
  if (
    descriptor &&
    !descriptor.configurable &&
    (!("value" in descriptor) || !descriptor.writable)
  ) {
    walk.unsafe = true;
    return;
  }
  if (!descriptor && !Object.isExtensible(target)) {
    walk.unsafe = true;
    return;
  }
  walk.updates.push({
    target,
    key,
    descriptor: {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      value,
      writable: descriptor && "value" in descriptor ? descriptor.writable : true,
    },
  });
}

/** Give every retained container inert own rendering and coercion properties. */
function installUniversalShadows(source: object, target: object, walk: DiagnosticWalk): void {
  for (const [key, value] of UNIVERSAL_SHADOWS) {
    installOwnShadow(source, target, key, value, walk);
    if (walk.unsafe) return;
  }
}

/** Shadow missing or accessor-backed formatter fields on every retained native Error. */
function installErrorRenderFields(error: Error, walk: DiagnosticWalk): void {
  for (const [key, value] of ERROR_CONTROL_SHADOWS) {
    installOwnShadow(error, error, key, value, walk);
    if (walk.unsafe) return;
  }
  for (const [key, value] of ERROR_RENDER_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor && "value" in descriptor) continue;
    installOwnShadow(error, error, key, value, walk);
    if (walk.unsafe) return;
  }
}

/** Copy stored diagnostics without invoking accessors or changing descriptor visibility. */
function redactStoredDiagnosticProperties(
  source: object,
  target: object,
  walk: DiagnosticWalk,
): void {
  installUniversalShadows(source, target, walk);
  if (walk.unsafe) return;
  const errorSource = isTrustedOnboardError(source);
  if (errorSource) {
    installErrorRenderFields(source, walk);
    if (walk.unsafe) return;
  }
  for (const key of Reflect.ownKeys(source)) {
    if (walk.unsafe) return;
    if (isUniversalShadow(key)) continue;
    if (errorSource && isErrorControlShadow(key)) continue;
    if (isSensitiveDiagnosticKey(key)) {
      walk.unsafe = true;
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (!("value" in descriptor) && errorSource && isErrorRenderField(key)) {
      continue;
    }
    if ("value" in descriptor) redactStoredValue(source, target, key, descriptor, walk);
    else redactAccessor(source, target, key, descriptor, walk);
  }
}

/*
 * Every renderer-visible property is now owned locally before the graph is
 * published, so inherited or later prototype changes cannot re-enter it.
 */

/** Sanitize every stored error diagnostic without invoking arbitrary accessors. */
function redactErrorDiagnostic(error: Error, walk: DiagnosticWalk): void {
  retainAggregateMembers(error, walk);
  redactStoredDiagnosticProperties(error, error, walk);
}

/** Retain diagnostic descriptors and member order while sharing cycle detection. */
function redactArrayDiagnostic(source: unknown[], target: unknown[], walk: DiagnosticWalk): void {
  redactStoredDiagnosticProperties(source, target, walk);
}

/** Copy own property descriptors without invoking getters while sanitizing stored diagnostic values. */
function redactPlainDiagnostic(
  source: Record<PropertyKey, unknown>,
  target: Record<PropertyKey, unknown>,
  walk: DiagnosticWalk,
): void {
  redactStoredDiagnosticProperties(source, target, walk);
}

/** Process one queued container so nested diagnostics do not consume the call stack. */
function redactDiagnosticTask(task: DiagnosticTask, walk: DiagnosticWalk): void {
  if (isTrustedOnboardError(task.source)) return redactErrorDiagnostic(task.source, walk);
  if (Array.isArray(task.source) && Array.isArray(task.target)) {
    return redactArrayDiagnostic(task.source, task.target, walk);
  }
  if (isPlainDiagnosticObject(task.source) && isPlainDiagnosticObject(task.target)) {
    redactPlainDiagnostic(task.source, task.target, walk);
  }
}

/** Construct a native Error whose formatter-visible surface is entirely own data. */
function createSafeError(message: string): Error {
  const error = new Error();
  for (const [key, value] of ERROR_RENDER_FIELDS) {
    const safeValue = key === "message" ? message : key === "stack" ? `Error: ${message}` : value;
    Object.defineProperty(error, key, {
      configurable: true,
      enumerable: false,
      value: safeValue,
      writable: true,
    });
  }
  for (const [key, value] of ERROR_CONTROL_SHADOWS) {
    Object.defineProperty(error, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  }
  for (const [key, value] of UNIVERSAL_SHADOWS) {
    Object.defineProperty(error, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  }
  return error;
}

/** Construct an opaque replacement when the original graph cannot be safely rewritten. */
function createFailClosedError(): Error {
  return createSafeError(REDACTED_ERROR_MESSAGE);
}

/** Redact a trusted error graph, retaining mutable identities or returning an opaque fallback. */
function redactTrustedOnboardError(error: Error): Error {
  const walk: DiagnosticWalk = {
    pending: [{ source: error, target: error }],
    seen: new WeakMap([[error, error]]),
    updates: [],
    unsafe: false,
  };
  try {
    // An iterative walk also supports deep cause chains without consuming the call stack.
    for (const task of walk.pending) {
      redactDiagnosticTask(task, walk);
      if (walk.unsafe) return createFailClosedError();
    }
    for (const update of walk.updates) {
      Object.defineProperty(update.target, update.key, update.descriptor);
    }
    return error;
  } catch {
    return createFailClosedError();
  }
}

/** Return a safe native Error for every possible thrown or rollback value. */
export function sanitizeOnboardFailure(value: unknown): Error {
  if (isTrustedOnboardError(value)) return redactTrustedOnboardError(value);
  if (typeof value === "string") return createSafeError(redactOnboardErrorText(value));
  return createFailClosedError();
}

/** Preserve the existing named API while applying the central trust decision. */
export function redactOnboardError(error: Error): Error {
  return sanitizeOnboardFailure(error);
}

/** Redact complete secret blocks before bounding individual diagnostic lines. */
export function redactOnboardErrorText(message: string): string {
  return redactFullWithUrls(message).split("\n").map(redactOnboardDiagnosticText).join("\n");
}

/** Bound a diagnostic after removing recognized credential values. */
export function redactOnboardDiagnosticText(message: string): string {
  return redactSensitiveText(message) ?? "";
}

/** Preserve the command diagnostic's existing redaction and length contract. */
export function redactOnboardCommandDiagnosticText(message: string): string {
  return redactSensitiveText(redact(redactFull(message))) ?? "";
}
