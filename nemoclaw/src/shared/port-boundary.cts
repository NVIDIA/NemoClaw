// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: This is the canonical parser for NemoClaw service-port
// overrides consumed by both the root CLI and the plugin. It is compiled to
// generated .cjs/.d.cts files before either consumer is built.
// consumers: src/lib/core/ports.ts and nemoclaw/src/lib/ports.ts.
// regressionTest: src/lib/core/ports.test.ts and nemoclaw/src/lib/ports.test.ts
// cover the shared boundary through both public consumers.

/** Parse a canonical decimal service-port override or return its fallback. */
export function parseServicePortOverride(
  envVar: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  return parsed;
}
