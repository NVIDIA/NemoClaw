// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
const RENDERER_HOOKS = ["toJSON", CUSTOM_INSPECT] as const;
const REDACTED_ERROR_MESSAGE =
  "Onboarding failed; diagnostic details were redacted because they could not be sanitized safely.";

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

/** Limit property traversal to plain records so class instances retain their behavior. */
function isPlainDiagnosticObject(value: object): value is Record<PropertyKey, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Preserve Error identity and copy diagnostic containers without constructing arbitrary classes. */
function createDiagnosticTarget(value: object): object | null {
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return [];
  if (isPlainDiagnosticObject(value)) return Object.create(Object.getPrototypeOf(value)) as object;
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

/** Keep an aggregate's mutable member array while enrolling it in the descriptor walk. */
function retainAggregateMembers(error: AggregateError, walk: DiagnosticWalk): void {
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
      value: isRendererHook(key) ? undefined : "<REDACTED>",
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
  const value =
    isRendererHook(key) && descriptor.value !== undefined
      ? undefined
      : redactNestedDiagnostic(descriptor.value, walk);
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

/** Shadow inherited rendering hooks without reading or invoking their values. */
function neutralizeInheritedRendererHooks(
  source: object,
  target: object,
  walk: DiagnosticWalk,
): void {
  for (const key of RENDERER_HOOKS) {
    if (Object.hasOwn(source, key)) continue;
    let prototype = Object.getPrototypeOf(source) as object | null;
    let inherited = false;
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor) {
        inherited = !("value" in descriptor) || typeof descriptor.value === "function";
        break;
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    if (!inherited) continue;
    if (source === target && !Object.isExtensible(target)) {
      walk.unsafe = true;
      return;
    }
    const descriptor = {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: true,
    };
    if (source === target) walk.updates.push({ target, key, descriptor });
    else Object.defineProperty(target, key, descriptor);
  }
}

/** Copy stored diagnostics without invoking accessors or changing descriptor visibility. */
function redactStoredDiagnosticProperties(
  source: object,
  target: object,
  walk: DiagnosticWalk,
): void {
  neutralizeInheritedRendererHooks(source, target, walk);
  for (const key of Reflect.ownKeys(source)) {
    if (walk.unsafe) return;
    if (isSensitiveDiagnosticKey(key)) {
      walk.unsafe = true;
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if ("value" in descriptor) redactStoredValue(source, target, key, descriptor, walk);
    else redactAccessor(source, target, key, descriptor, walk);
  }
}

/** Sanitize every stored error diagnostic without invoking arbitrary accessors. */
function redactErrorDiagnostic(error: Error, walk: DiagnosticWalk): void {
  if (error instanceof AggregateError) retainAggregateMembers(error, walk);
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
  if (task.source instanceof Error) return redactErrorDiagnostic(task.source, walk);
  if (Array.isArray(task.source) && Array.isArray(task.target)) {
    return redactArrayDiagnostic(task.source, task.target, walk);
  }
  if (isPlainDiagnosticObject(task.source) && isPlainDiagnosticObject(task.target)) {
    redactPlainDiagnostic(task.source, task.target, walk);
  }
}

/** Construct an opaque replacement when the original graph cannot be safely rewritten. */
function createFailClosedError(): Error {
  const fallback = new Error(REDACTED_ERROR_MESSAGE);
  Object.defineProperty(fallback, "stack", {
    configurable: true,
    enumerable: false,
    value: `Error: ${REDACTED_ERROR_MESSAGE}`,
    writable: true,
  });
  return fallback;
}

/** Redact an error graph, retaining mutable identities or returning an opaque fallback. */
export function redactOnboardError(error: Error): Error {
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
