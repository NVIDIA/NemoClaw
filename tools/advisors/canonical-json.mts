// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hasControlCharacters(value: string, allowedCodes: readonly number[] = []): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code <= 31 || code === 127) && !allowedCodes.includes(code);
  });
}

export function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => (hasControlCharacters(character) ? " " : character))
    .join("");
}
