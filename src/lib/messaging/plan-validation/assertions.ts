// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingAgentId,
  MessagingCompilerWorkflow,
  MessagingSerializableValue,
} from "../manifest";

const AGENTS = new Set<MessagingAgentId>(["openclaw", "hermes"]);
const WORKFLOWS = new Set<MessagingCompilerWorkflow>([
  "onboard",
  "add-channel",
  "remove-channel",
  "start-channel",
  "stop-channel",
  "rebuild",
]);

export function isAgent(value: unknown): value is MessagingAgentId {
  return typeof value === "string" && AGENTS.has(value as MessagingAgentId);
}

export function isWorkflow(value: unknown): value is MessagingCompilerWorkflow {
  return typeof value === "string" && WORKFLOWS.has(value as MessagingCompilerWorkflow);
}

export function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected object");
  }
  return value as Record<string, unknown>;
}

export function assertArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
}

export function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path, "expected string");
}

export function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean");
}

export function assertStringArray(
  value: unknown,
  path: string,
): asserts value is readonly string[] {
  assertArray(value, path);
  value.forEach((entry, index) => assertString(entry, `${path}[${index}]`));
}

export function assertSerializableValue(
  value: unknown,
  path: string,
  visiting: Set<object> = new Set(),
): asserts value is MessagingSerializableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (Array.isArray(value)) {
    assertAcyclicObject(value, path, visiting, () => {
      value.forEach((entry, index) =>
        assertSerializableValue(entry, `${path}[${index}]`, visiting),
      );
    });
    return;
  }
  if (isPlainObject(value)) {
    assertAcyclicObject(value, path, visiting, () => {
      for (const [key, entry] of Object.entries(value)) {
        assertSerializableValue(entry, `${path}.${key}`, visiting);
      }
    });
    return;
  }
  fail(path, "expected JSON-serializable value");
}

export function optionalStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stringArraysEqual(left, right);
}

export function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function fail(path: string, reason: string): never {
  throw new Error(`Invalid SandboxMessagingPlan at ${path}: ${reason}.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAcyclicObject(
  value: object,
  path: string,
  visiting: Set<object>,
  visit: () => void,
): void {
  if (visiting.has(value)) fail(path, "contains a cycle");
  visiting.add(value);
  try {
    visit();
  } finally {
    visiting.delete(value);
  }
}
