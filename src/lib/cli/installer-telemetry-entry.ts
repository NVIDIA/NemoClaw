// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import os from "node:os";
import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import type { TelemetryOutcome, TelemetryScope, TelemetryState } from "../domain/telemetry/event";
import {
  beginInstallerTelemetry,
  finishInstallerTelemetry,
  getTelemetryExpectedVersion,
  isTelemetryOperationActive,
  recordTelemetryTarget,
  recordTelemetryVersions,
  TELEMETRY_CONTEXT_ENV,
} from "../actions/telemetry/operation";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const OUTCOMES: readonly TelemetryOutcome[] = [
  "completed",
  "checked",
  "cancelled",
  "skipped",
  "failed",
  "no_change",
  "unverified",
];
const STATES: readonly TelemetryState[] = [
  "applied",
  "pending",
  "partial",
  "unchanged",
  "unavailable",
];

function installedVersion(): string | undefined {
  const value = process.env.NEMOCLAW_TELEMETRY_INSTALLED_VERSION;
  return value && VERSION_PATTERN.test(value) ? value : undefined;
}

function readBuildVersion(identityPath: string): string | undefined {
  try {
    const file = openRegularFileNoFollow(identityPath);
    let raw: string;
    try {
      raw = file.readBytes(16_384).toString("utf8");
    } finally {
      file.close();
    }
    const identity = JSON.parse(raw) as { nemoclawVersion?: unknown };
    return typeof identity.nemoclawVersion === "string" &&
      VERSION_PATTERN.test(identity.nemoclawVersion)
      ? identity.nemoclawVersion
      : undefined;
  } catch {
    return undefined;
  }
}

/** Internal shell bridge: private paths and version evidence travel only through environment. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "begin" && (args[1] === "install" || args[1] === "update")) {
    const inherited = process.env[TELEMETRY_CONTEXT_ENV];
    const directory = beginInstallerTelemetry(args[1]);
    if (!directory) return;
    process.env[TELEMETRY_CONTEXT_ENV] = directory;
    if (!inherited && process.env.NEMOCLAW_TELEMETRY_INSTALLER_PHASE === "before") {
      const previous = readBuildVersion(
        path.join(os.homedir(), ".nemoclaw/source/dist/build-identity.json"),
      );
      if (previous) recordTelemetryVersions({ previous });
    }
    if (process.env.NEMOCLAW_TELEMETRY_INSTALLER_PHASE === "installed") {
      const version = installedVersion();
      recordTelemetryVersions({ installed: version ?? "unknown" });
      recordTelemetryTarget({
        scope: "cli",
        outcome: version ? "completed" : "unverified",
        state: version ? "applied" : "partial",
      });
      if (!getTelemetryExpectedVersion()) {
        const target = readBuildVersion(path.resolve(__dirname, "../../build-identity.json"));
        if (target) recordTelemetryVersions({ target });
      }
    }
    process.stdout.write(directory);
    return;
  }
  if (
    args.length !== 3 ||
    args[0] !== "finish" ||
    !/^(?:0|[1-9][0-9]{0,2})$/.test(args[1]) ||
    Number(args[1]) > 255 ||
    (args[2] !== "cli" && args[2] !== "sandbox")
  )
    return;
  const directory = process.env[TELEMETRY_CONTEXT_ENV];
  if (!directory || !isTelemetryOperationActive()) return;
  const requestedOutcome = process.env.NEMOCLAW_TELEMETRY_INSTALLER_OUTCOME as TelemetryOutcome;
  const requestedState = process.env.NEMOCLAW_TELEMETRY_INSTALLER_STATE as TelemetryState;
  let outcome: TelemetryOutcome = OUTCOMES.includes(requestedOutcome)
    ? requestedOutcome
    : "unverified";
  let state: TelemetryState = STATES.includes(requestedState) ? requestedState : "unavailable";
  const expected = getTelemetryExpectedVersion();
  const actual = installedVersion();
  if (outcome === "completed" && (!actual || !expected || expected !== actual)) {
    outcome = actual && expected && expected !== actual ? "failed" : "unverified";
    state = "partial";
    recordTelemetryTarget({
      scope: "cli",
      outcome,
      state,
      verificationStatus: outcome === "failed" ? "reported" : "not_observed",
    });
  }
  await finishInstallerTelemetry(
    directory,
    outcome,
    state,
    args[2] as TelemetryScope,
    Number(args[1]),
    { installed: actual ?? "unknown" },
  );
}

void main()
  .finally(() => process.exit(0))
  .catch(() => {
    /* The shell preserves its own exit status. */
  });
