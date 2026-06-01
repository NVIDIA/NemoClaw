// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface GatewayCallSuccess<T = unknown> {
  result: T;
}

export interface GatewayCallFailure {
  error: { code?: string | number; message?: string };
}

export type GatewayCallEnvelope<T = unknown> = Partial<GatewayCallSuccess<T> & GatewayCallFailure>;

export function parseGatewayCallEnvelope<T = unknown>(
  output: string,
): GatewayCallEnvelope<T> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      return JSON.parse(candidate) as GatewayCallEnvelope<T>;
    } catch {
      continue;
    }
  }
  try {
    return JSON.parse(trimmed) as GatewayCallEnvelope<T>;
  } catch {
    return null;
  }
}
