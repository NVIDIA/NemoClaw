// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Port parsing for the NemoClaw plugin.
 * Mirrors src/lib/ports.ts in the CLI — kept in sync intentionally.
 */

export function parsePort(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  return parsed;
}

export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", 18789);
