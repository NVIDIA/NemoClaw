// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  sendInstallerTelemetry,
  type InstallerTelemetryDependencies,
} from "../actions/telemetry/send";
import { isTelemetryOperation } from "../domain/telemetry/event";

export async function runInstallerTelemetryEntry(
  argv: readonly string[],
  telemetryDependencies: Partial<InstallerTelemetryDependencies> = {},
): Promise<void> {
  const operation = argv[0];
  if (argv.length !== 1 || !isTelemetryOperation(operation)) {
    throw new TypeError("Installer telemetry requires exactly one supported operation");
  }
  await sendInstallerTelemetry(operation, telemetryDependencies);
}

if (require.main === module) {
  runInstallerTelemetryEntry(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
