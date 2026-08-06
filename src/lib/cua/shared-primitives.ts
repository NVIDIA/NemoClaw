// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const CUA_SENSITIVE_VALUE =
  /(?:auth|bearer|credential|password|secret|token)|(?:^|[/._-])(?:ghp_|sk-)/i;

export const CUA_HOST_COORDINATE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|@|[?#\\]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]|\b(?:localhost|ip6-localhost)(?:\.[a-z0-9-]+)*\b|\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|cloud|internal|local|invalid)\b)/i;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeCuaJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeCuaJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonicalizeCuaJson(child)]),
  );
}

export function canonicalJsonSha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeCuaJson(value)))
    .digest("hex");
}
