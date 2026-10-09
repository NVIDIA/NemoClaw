// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import type {
  TelemetryOperationContext,
  TelemetryOperationEvent,
  ValueStatus,
} from "../../domain/telemetry/event";
import { readTelemetryTestLabel } from "../../domain/telemetry/event";
import { PUBLIC_VERSION_PATTERN } from "../../domain/telemetry/schema";
import { operationEnvelope } from "../../adapters/telemetry/gxt";
import {
  allowedTelemetryCollection,
  postOperationRecord,
  shouldSuppressTelemetry,
  telemetryRuntime,
  type TelemetryDeliveryConfig,
} from "../../adapters/telemetry/http";

export type { TelemetryDeliveryConfig };
export { shouldSuppressTelemetry, telemetryRuntime };

function publicVersion(
  value: unknown,
  missing: ValueStatus,
): { value: string; status: ValueStatus } {
  return typeof value === "string" &&
    value !== "unknown" &&
    value.length <= 128 &&
    new RegExp(PUBLIC_VERSION_PATTERN).test(value)
    ? { value, status: "reported" }
    : { value: "unknown", status: value == null || value === "unknown" ? missing : "unapproved" };
}
function installedVersion(): unknown {
  try {
    const filename = path.resolve(__dirname, "../../../../dist/build-identity.json");
    const file = openRegularFileNoFollow(filename);
    try {
      return JSON.parse(file.readBytes(16_384).toString("utf8")).nemoclawVersion;
    } finally {
      file.close();
    }
  } catch {
    return undefined;
  }
}

function missingObservation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(missingObservation);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ((key === "status" || key.endsWith("Status")) &&
        ["collection_error", "not_observed", "not_persisted", "unavailable"].includes(item)) ||
      missingObservation(item),
  );
}

export async function collectOperationEvent(
  context: TelemetryOperationContext,
  options: { signal: AbortSignal; deadlineAt: number },
): Promise<TelemetryOperationEvent> {
  const { collectOperationSnapshot } = await import("./snapshot");
  const snapshot = await collectOperationSnapshot({ ...options, targets: context.targets });
  const installed =
    context.installedVersion === undefined
      ? publicVersion(installedVersion(), "collection_error")
      : publicVersion(context.installedVersion, "not_observed");
  const previous = publicVersion(
    context.previousVersion,
    context.operation === "install" || context.operation === "update"
      ? "not_observed"
      : "not_applicable",
  );
  const target = publicVersion(
    context.targetVersion,
    context.operation === "install" || context.operation === "update"
      ? "not_observed"
      : "not_applicable",
  );
  const hostOS =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "other";
  const hostArch = ["x64", "arm64", "ia32", "arm"].includes(process.arch) ? process.arch : "other";
  const { targetPositions: _privatePositions, ...publicSnapshot } = snapshot;
  const event: TelemetryOperationEvent = {
    name: "nemoclaw_operation_finished",
    ts: context.completedAt,
    parameters: {
      ...publicSnapshot,
      nvidiaSource: "nemoclaw",
      testLabel: readTelemetryTestLabel(process.env) ?? "",
      operation: context.operation,
      outcome: context.outcome,
      state: context.state,
      operationScope: context.scope,
      configurationScope: "published_configuration",
      startedAt: context.startedAt,
      completedAt: context.completedAt,
      versions: {
        installed: installed.value,
        installedStatus: installed.status,
        previous: previous.value,
        previousStatus: previous.status,
        target: target.value,
        targetStatus: target.status,
      },
      platform: {
        hostOS,
        hostOSStatus: hostOS === "other" ? "unapproved" : "reported",
        hostArch,
        hostArchStatus: hostArch === "other" ? "unapproved" : "reported",
        hostContext: hostOS === "linux" && /microsoft/i.test(os.release()) ? "wsl" : "native",
        hostContextStatus: "reported",
      },
      location: {
        countryCode: "",
        countryName: "",
        countryStatus: "not_configured",
        regionName: "",
        regionStatus: "not_configured",
        cityName: "",
        cityStatus: "not_configured",
        locationSource: "none",
        locationPrecision: "none",
        locationStatus: "not_configured",
        locationObservedAt: "",
        locationObservedAtStatus: "not_configured",
      },
      targetResultsStatus: context.targets.length ? "reported" : "not_observed",
      targetResults: context.targets.map((receipt) => {
        const position =
          receipt.sandboxName === undefined || !receipt.gatewayName
            ? undefined
            : snapshot.targetPositions.get(
                JSON.stringify([receipt.gatewayName, receipt.sandboxName]),
              );
        return {
          scope: receipt.scope,
          outcome: receipt.outcome,
          state: receipt.state,
          verificationStatus:
            receipt.verificationStatus ??
            (receipt.outcome === "unverified" ? "not_observed" : "reported"),
          configurationPosition: position ?? -1,
          configurationStatus:
            position !== undefined
              ? "reported"
              : receipt.sandboxName !== undefined && !receipt.gatewayName
                ? "unavailable"
                : receipt.scope === "cli" || context.operation === "sandbox_destroy"
                  ? "not_applicable"
                  : "unavailable",
        };
      }),
    },
  };
  if (
    event.parameters.collectionStatus !== "collection_error" &&
    missingObservation(event.parameters)
  )
    event.parameters.collectionStatus = "partial";
  return event;
}

/** A single complete record, one attempt, and one collection/delivery deadline. */
export async function sendOperationTelemetry(
  context: TelemetryOperationContext,
  budgetMs: number,
): Promise<"disabled" | "accepted" | "failed"> {
  const config = telemetryRuntime.config;
  if (
    !config ||
    shouldSuppressTelemetry(process.env) ||
    !allowedTelemetryCollection(config, readTelemetryTestLabel(process.env))
  )
    return "disabled";
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 5_000) return "failed";
  const controller = new AbortController();
  const deadlineAt = Date.now() + budgetMs;
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const deadline = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const event = await Promise.race([
      collectOperationEvent(context, { signal: controller.signal, deadlineAt }),
      deadline,
    ]);
    if (event === null || controller.signal.aborted) return "failed";
    if (
      telemetryRuntime.config !== config ||
      shouldSuppressTelemetry(process.env) ||
      !allowedTelemetryCollection(config, readTelemetryTestLabel(process.env))
    )
      return "disabled";
    const envelope = operationEnvelope(event, config.localReceiver !== true);
    if (!envelope || controller.signal.aborted) return "failed";
    const body = JSON.stringify(envelope);
    // This is a client safeguard, not a verified service limit. Never truncate or split.
    if (Buffer.byteLength(body) > 1_048_576) return "failed";
    return (await postOperationRecord(config, body, controller.signal)) ? "accepted" : "failed";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
