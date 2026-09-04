#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactForLog } from "./security/redact.js";
import { sdkOpenShellGatewayHealthObserver } from "../../nemoclaw/dist/shared/openshell-gateway-health-sdk.js";
import type { OpenShellGatewayHealthObserver } from "../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";

const RUNNER_MODULE = "../nemoclaw/blueprint/runner.js";
const MAX_DIAGNOSTIC_CHARACTERS = 1_024;
const UNSAFE_DIAGNOSTIC_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/gu;

function reportFailure(error: unknown): void {
  let detail = "Blueprint Runner failed.";
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    // Keep the fixed fallback when an arbitrary thrown value cannot be rendered.
  }
  const redacted = redactForLog(detail);
  const sanitized =
    typeof redacted === "string" ? redacted.replace(UNSAFE_DIAGNOSTIC_CHARACTERS, " ").trim() : "";
  const message = (sanitized || "Blueprint Runner failed.").slice(0, MAX_DIAGNOSTIC_CHARACTERS);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

async function run(): Promise<void> {
  const runner = (await import(RUNNER_MODULE)) as Readonly<{
    main(
      argv: string[],
      options: Readonly<{ gatewayHealthObserver: OpenShellGatewayHealthObserver }>,
    ): Promise<void>;
  }>;
  await runner.main(process.argv.slice(2), {
    gatewayHealthObserver: sdkOpenShellGatewayHealthObserver,
  });
}

void run().catch(reportFailure);

export {};
