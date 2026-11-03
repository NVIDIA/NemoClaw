// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  sendOperationTelemetry,
  shouldSuppressTelemetry,
  telemetryRuntime,
} from "../actions/telemetry/send";
import { allowedTelemetryEndpoint } from "../adapters/telemetry/http";
import { CollectionDiagnostics } from "../actions/telemetry/diagnostics";

// Internal exit-path delivery only; private context is stdin, never argv or logs.
async function main(): Promise<void> {
  if (shouldSuppressTelemetry(process.env)) return;
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 1_048_576) return;
  }
  const request = JSON.parse(input);
  if (
    typeof request.config?.endpoint !== "string" ||
    typeof request.config.localReceiver !== "boolean"
  )
    return;
  const config = {
    endpoint: new URL(request.config.endpoint),
    localReceiver: request.config.localReceiver,
  };
  if (!allowedTelemetryEndpoint(config)) return;
  telemetryRuntime.config = config;
  if (!Number.isFinite(request.deadlineAt) || !Number.isFinite(request.remainingMs)) return;
  const diagnostics = request.debugCollection === true ? new CollectionDiagnostics() : undefined;
  try {
    await sendOperationTelemetry(
      request.context,
      Math.min(request.remainingMs, request.deadlineAt - Date.now()),
      diagnostics,
    );
  } finally {
    if (diagnostics && !shouldSuppressTelemetry(process.env))
      await new Promise<void>((resolve) =>
        process.stdout.write(diagnostics.serialize(), () => resolve()),
      );
  }
}
if (require.main === module)
  void main()
    .catch(() => {})
    .finally(() => process.exit(0));
