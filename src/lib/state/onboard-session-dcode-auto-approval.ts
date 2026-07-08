// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type DcodeAutoApprovalMode,
  invalidRecordedDcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "../onboard/dcode-auto-approval";

const INVALID_DCODE_AUTO_APPROVAL_SESSIONS = new WeakSet<object>();

/** True when a normalized session carried a non-null, unsupported persisted mode. */
export function hasInvalidSessionDcodeAutoApprovalMode(session: unknown): boolean {
  return typeof session === "object" && session !== null
    ? INVALID_DCODE_AUTO_APPROVAL_SESSIONS.has(session)
    : false;
}

export function normalizeSessionDcodeAutoApprovalMode(value: unknown): DcodeAutoApprovalMode {
  return normalizeDcodeAutoApprovalMode(value);
}

export function preserveInvalidSessionDcodeAutoApprovalMode(source: unknown, target: object): void {
  const recorded =
    typeof source === "object" && source !== null
      ? (source as { dcodeAutoApprovalMode?: unknown }).dcodeAutoApprovalMode
      : undefined;
  if (
    hasInvalidSessionDcodeAutoApprovalMode(source) ||
    invalidRecordedDcodeAutoApprovalMode(recorded)
  ) {
    INVALID_DCODE_AUTO_APPROVAL_SESSIONS.add(target);
  }
}

export function assignSafeDcodeAutoApprovalModeUpdate(
  target: { dcodeAutoApprovalMode?: DcodeAutoApprovalMode },
  value: unknown,
): void {
  if (value === "disabled" || value === "thread-opt-in") {
    target.dcodeAutoApprovalMode = value;
  }
}
