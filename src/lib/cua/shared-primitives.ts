// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const CUA_SENSITIVE_VALUE =
  /(?:auth|bearer|credential|password|secret|token)|(?:^|[/._-])(?:ghp_|sk-)/i;

export const CUA_HOST_COORDINATE =
  /(?:[a-z][a-z0-9+.-]*:\/\/|@|[?#\\]|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]|(?:^|[^0-9a-f:])(?:(?:[0-9a-f]{1,4}:){2,7}[0-9a-f:]{0,4}|::[0-9a-f]{1,4})(?=$|[^0-9a-f:])|\b(?:localhost|ip6-localhost)(?:\.[a-z0-9-]+)*\b|\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|cloud|internal|local|invalid)\b)/i;

export const CUA_DOMAIN_COORDINATE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeCuaJson(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return `[${Array.from(value, (child) => canonicalizeCuaJson(child) ?? "null").join(",")}]`;
  }
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([key, child]) => {
      const serialized = canonicalizeCuaJson(child);
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
    });
  return `{${entries.join(",")}}`;
}

export function canonicalJsonSha256(value: unknown): string {
  const canonical = canonicalizeCuaJson(value);
  if (canonical === undefined) throw new TypeError("CUA canonical JSON value is not serializable");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
