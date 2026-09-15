// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactFull, redactFullWithUrls, redactSensitiveText } from "../../security/redact";

interface DiagnosticTask {
  source: object;
  target: object;
}

interface DiagnosticWalk {
  pending: DiagnosticTask[];
  seen: WeakMap<object, object>;
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
  if (typeof value !== "object" || value === null) return value;
  if (walk.seen.has(value)) return walk.seen.get(value);

  const target = createDiagnosticTarget(value);
  if (!target) return value;
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

/** Copy stored diagnostics without invoking accessors or changing descriptor visibility. */
function redactStoredDiagnosticProperties(
  source: object,
  target: object,
  walk: DiagnosticWalk,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = redactNestedDiagnostic(descriptor.value, walk);
    else if (source === target) continue;
    Object.defineProperty(target, key, descriptor);
  }
}

/** Sanitize every stored error diagnostic without invoking arbitrary accessors. */
function redactErrorDiagnostic(error: Error, walk: DiagnosticWalk): void {
  // Node exposes the standard stack slot as an own accessor; it is the only
  // accessor this boundary reads so arbitrary diagnostic getters stay inert.
  error.stack = error.stack && redactOnboardErrorText(error.stack);
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

/** Redact causes and aggregate members; Error identities and shared cyclic links remain intact. */
export function redactOnboardError(error: Error): void {
  const walk: DiagnosticWalk = {
    pending: [{ source: error, target: error }],
    seen: new WeakMap([[error, error]]),
  };
  // An iterative walk also supports deep cause chains without consuming the call stack.
  for (const task of walk.pending) redactDiagnosticTask(task, walk);
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
