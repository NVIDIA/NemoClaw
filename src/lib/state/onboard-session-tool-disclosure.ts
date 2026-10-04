// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_TOOL_DISCLOSURE,
  invalidRecordedToolDisclosure,
  normalizeToolDisclosure,
  type ToolDisclosure,
} from "../tool-disclosure";

const INVALID_TOOL_DISCLOSURE_SESSIONS = new WeakSet<object>();

export type { ToolDisclosure } from "../tool-disclosure";

/** True when a normalized session carried a non-null, unsupported persisted value. */
export function hasInvalidSessionToolDisclosure(session: unknown): boolean {
  return typeof session === "object" && session !== null
    ? INVALID_TOOL_DISCLOSURE_SESSIONS.has(session)
    : false;
}

export function normalizeSessionToolDisclosure(value: unknown): ToolDisclosure {
  return normalizeToolDisclosure(value) ?? DEFAULT_TOOL_DISCLOSURE;
}

export function preserveInvalidSessionToolDisclosure(source: unknown, target: object): void {
  const recorded =
    typeof source === "object" && source !== null
      ? (source as { toolDisclosure?: unknown }).toolDisclosure
      : undefined;
  if (hasInvalidSessionToolDisclosure(source) || invalidRecordedToolDisclosure(recorded)) {
    INVALID_TOOL_DISCLOSURE_SESSIONS.add(target);
  }
}

export function assignSafeToolDisclosureUpdate(
  target: { toolDisclosure?: ToolDisclosure },
  value: unknown,
): void {
  const toolDisclosure = normalizeToolDisclosure(value);
  if (toolDisclosure) target.toolDisclosure = toolDisclosure;
}
