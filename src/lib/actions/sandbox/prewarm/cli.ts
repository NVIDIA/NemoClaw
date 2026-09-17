#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  applyPersistedAutomaticGatewayPort,
  SAFE_AUTOMATIC_GATEWAY_PORT_DIAGNOSTIC,
  SAFE_PORT_DIAGNOSTIC,
} from "./automatic-gateway-port";

function safeDiagnostic(error: unknown): string {
  let message = "Prewarm failed.";
  try {
    message = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ");
  } catch {
    return "Prewarm failed.";
  }
  return SAFE_PORT_DIAGNOSTIC.test(message) || message === SAFE_AUTOMATIC_GATEWAY_PORT_DIAGNOSTIC
    ? message
    : "Prewarm failed.";
}

function fail(error: unknown): void {
  process.exitCode = 1;
  try {
    process.stderr.write(`Error: ${safeDiagnostic(error)}\n`);
  } catch {
    try {
      process.stderr.write("Error: Prewarm failed.\n");
    } catch {
      // The diagnostic sink itself failed; there is nothing left to report safely.
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    fail(new Error("Usage: nemoclaw-prewarm <sandbox-name>"));
    return;
  }
  applyPersistedAutomaticGatewayPort();
  const { prewarmHermesPortableSandbox } = await import(".");
  await prewarmHermesPortableSandbox(process.argv[2]!);
}

void main().catch(fail);
