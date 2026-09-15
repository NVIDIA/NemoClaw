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

function isPlainDiagnosticObject(value: object): value is Record<PropertyKey, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createDiagnosticTarget(value: object): object | null {
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return [];
  if (isPlainDiagnosticObject(value)) return Object.create(Object.getPrototypeOf(value)) as object;
  return null;
}

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

function redactErrorDiagnostic(error: Error, walk: DiagnosticWalk): void {
  error.message = redactOnboardErrorText(error.message);
  error.stack = error.stack && redactOnboardErrorText(error.stack);
  if ("cause" in error) error.cause = redactNestedDiagnostic(error.cause, walk);
  if (error instanceof AggregateError) {
    for (const [index, member] of error.errors.entries()) {
      error.errors[index] = redactNestedDiagnostic(member, walk);
    }
  }
  const rollbackCarrier = error as Error & { managedBootstrapRollbackError?: unknown };
  if ("managedBootstrapRollbackError" in rollbackCarrier) {
    rollbackCarrier.managedBootstrapRollbackError = redactNestedDiagnostic(
      rollbackCarrier.managedBootstrapRollbackError,
      walk,
    );
  }
}

function redactArrayDiagnostic(source: unknown[], target: unknown[], walk: DiagnosticWalk): void {
  for (const value of source) target.push(redactNestedDiagnostic(value, walk));
}

function redactPlainDiagnostic(
  source: Record<PropertyKey, unknown>,
  target: Record<PropertyKey, unknown>,
  walk: DiagnosticWalk,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = redactNestedDiagnostic(descriptor.value, walk);
    Object.defineProperty(target, key, descriptor);
  }
}

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
