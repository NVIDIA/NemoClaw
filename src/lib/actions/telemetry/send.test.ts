// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import type { TelemetryOperationContext, TelemetrySnapshot } from "../../domain/telemetry/event";

const collectOperationSnapshot = vi.hoisted(() => vi.fn());
vi.mock("./snapshot", () => ({ collectOperationSnapshot }));

import { collectOperationEvent } from "./send";

const context: TelemetryOperationContext = {
  operation: "install",
  startedAt: "2026-10-08T00:00:00.000Z",
  completedAt: "2026-10-08T00:00:01.000Z",
  outcome: "completed",
  state: "applied",
  scope: "cli",
  installedVersion: "1.2.3",
  previousVersion: "1.2.2",
  targetVersion: "1.2.3",
  targets: [{ scope: "cli", outcome: "completed", state: "applied" }],
};

const snapshot: TelemetrySnapshot = {
  configurations: [],
  publishedEnvironmentCount: 0,
  configuredRuntimeCount: 0,
  configuredAgentCount: 0,
  countsStatus: "reported",
  collectionStatus: "complete",
  targetPositions: new Map(),
};

beforeEach(() => {
  collectOperationSnapshot.mockResolvedValue(snapshot);
});

it("reports complete collection when client location is intentionally unconfigured (#12859)", async () => {
  const event = await collectOperationEvent(context, {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  });

  expect(event.parameters.location.locationStatus).toBe("not_configured");
  expect(event.parameters.collectionStatus).toBe("complete");
});

it("reports partial collection when count evidence is unavailable (#12859)", async () => {
  collectOperationSnapshot.mockResolvedValue({ ...snapshot, countsStatus: "not_persisted" });

  const event = await collectOperationEvent(context, {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1_000,
  });

  expect(event.parameters.collectionStatus).toBe("partial");
});
