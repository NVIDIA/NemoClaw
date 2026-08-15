// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");

type SandboxNameValidators = {
  isValidName: (value: unknown) => boolean;
  isValidProviderName: (value: unknown) => boolean;
};

const { isValidName, isValidProviderName } = require(
  path.join(__dirname, "../../../nemoclaw/dist/shared/sandbox-name.cjs"),
) as SandboxNameValidators;

// One end-to-end deadline covers refresh-token exchange, agent-key minting,
// and destination activation. The local client waits slightly longer so it
// cannot abandon a request while the broker still considers it live.
const HERMES_CLONE_CONTROL_DEADLINE_MS = 120_000;
const HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS = 5_000;
const HERMES_CLONE_CONTROL_CLIENT_TIMEOUT_MS =
  HERMES_CLONE_CONTROL_DEADLINE_MS + HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS;
const HERMES_CLONE_CONTROL_STATUS_TIMEOUT_MS = 5_000;

const CONTROL_REQUEST_ID_PATTERN = /^nc_clone_[a-f0-9]{32}$/u;
const ACTIVATION_TOKEN_PATTERN = /^nc_activate_[A-Za-z0-9_-]{32,64}$/u;

function isValidControlRequestId(value: unknown): value is string {
  return typeof value === "string" && CONTROL_REQUEST_ID_PATTERN.test(value);
}

function isValidActivationToken(value: unknown): value is string {
  return typeof value === "string" && ACTIVATION_TOKEN_PATTERN.test(value);
}

function newControlDeadline(now: number = Date.now()): number {
  return now + HERMES_CLONE_CONTROL_DEADLINE_MS;
}

function boundedControlDeadline(value: unknown, now: number = Date.now()): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= now) return null;
  const latest = now + HERMES_CLONE_CONTROL_DEADLINE_MS;
  return value <= latest + HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS ? Math.min(value, latest) : null;
}

function remainingControlTime(
  deadlineAtMs: number,
  capMs: number,
  now: number = Date.now(),
): number {
  const remaining = deadlineAtMs - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.max(1, Math.min(remaining, capMs));
}

module.exports = {
  HERMES_CLONE_CONTROL_DEADLINE_MS,
  HERMES_CLONE_CONTROL_CLIENT_MARGIN_MS,
  HERMES_CLONE_CONTROL_CLIENT_TIMEOUT_MS,
  HERMES_CLONE_CONTROL_STATUS_TIMEOUT_MS,
  boundedControlDeadline,
  isValidActivationToken,
  isValidControlRequestId,
  isValidName,
  isValidProviderName,
  newControlDeadline,
  remainingControlTime,
};
