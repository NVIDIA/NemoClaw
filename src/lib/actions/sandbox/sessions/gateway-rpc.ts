// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell } from "../../../adapters/openshell/runtime";

export interface GatewayCallSuccess<T = unknown> {
  result: T;
}

export interface GatewayCallFailure {
  error: { code?: string | number; message?: string };
}

export type GatewayCallEnvelope<T = unknown> = Partial<GatewayCallSuccess<T> & GatewayCallFailure>;

export interface GatewayCallOptions {
  sandboxName: string;
  method: string;
  params: unknown;
}

export interface GatewayCallResult<T = unknown> {
  envelope: GatewayCallEnvelope<T>;
  rawOutput: string;
}

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

export function callOpenclawGateway<T = unknown>(
  opts: GatewayCallOptions,
): GatewayCallResult<T> {
  const params = JSON.stringify(opts.params);
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      "openclaw",
      "gateway",
      "call",
      opts.method,
      "--params",
      params,
      "--json",
    ],
    { ignoreError: true },
  );

  if (result.status !== 0) {
    console.error(
      `  Failed to reach the OpenClaw gateway in sandbox '${opts.sandboxName}': exit ${result.status}`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    console.error(
      `  Verify the gateway is reachable: \`${CLI_NAME} ${opts.sandboxName} status\`.`,
    );
    process.exit(1);
  }

  const envelope = parseGatewayCallEnvelope<T>(result.output);
  if (!envelope || (!envelope.result && !envelope.error)) {
    console.error(`  Could not parse gateway call response for '${opts.method}'.`);
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    process.exit(1);
  }
  return { envelope, rawOutput: result.output };
}
