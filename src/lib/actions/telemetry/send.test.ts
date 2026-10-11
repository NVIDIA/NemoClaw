// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TelemetryOperationContext, TelemetrySnapshot } from "../../domain/telemetry/event";
import {
  resolveTelemetryDeliveryConfig,
  telemetryRuntime,
  TEST_TELEMETRY_ENDPOINT,
} from "../../adapters/telemetry/http";
import {
  beginInstallerTelemetry,
  isTelemetryOperationActive,
  withTelemetryOperation,
} from "./operation";
import { isOperationEvent } from "../../domain/telemetry/schema";

const collectOperationSnapshot = vi.hoisted(() => vi.fn());
vi.mock("./snapshot", () => ({ collectOperationSnapshot }));

import { collectOperationEvent, sendOperationTelemetry } from "./send";

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
  collectOperationSnapshot.mockClear();
  collectOperationSnapshot.mockResolvedValue(snapshot);
  telemetryRuntime.config = null;
});

afterEach(() => {
  telemetryRuntime.config = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function allowLocalTelemetry(): void {
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "VITEST",
    "NODE_ENV",
    "NEMOCLAW_DISABLE_TELEMETRY",
    "NEMOCLAW_TELEMETRY_TEST_LABEL",
  ])
    vi.stubEnv(key, undefined);
}

function localReceiver(): void {
  telemetryRuntime.config = { endpoint: new URL("http://127.0.0.1:31337/"), localReceiver: true };
}

it("selects the fixed TEST receiver only for an approved QA label (#12859)", () => {
  expect(resolveTelemetryDeliveryConfig({})).toBeNull();
  expect(resolveTelemetryDeliveryConfig({ NEMOCLAW_TELEMETRY_TEST_LABEL: "invalid" })).toBeNull();
  expect(
    resolveTelemetryDeliveryConfig({
      NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:client:attempt-1",
      NEMOCLAW_DISABLE_TELEMETRY: "1",
    }),
  ).toBeNull();
  expect(telemetryRuntime.config).toBeNull();

  const config = resolveTelemetryDeliveryConfig({
    NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-telemetry:client:attempt-1",
  });
  expect(config?.endpoint.href).toBe(TEST_TELEMETRY_ENDPOINT);
  expect(config?.localReceiver).not.toBe(true);
});

it("starts CLI and installer contexts for approved QA runs (#12859)", async () => {
  allowLocalTelemetry();
  vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-telemetry:client:attempt-1");
  await withTelemetryOperation("update", async () => {
    expect(isTelemetryOperationActive()).toBe(true);
    expect(telemetryRuntime.config?.endpoint.href).toBe(TEST_TELEMETRY_ENDPOINT);
    telemetryRuntime.config = null; // Keep this context test offline at finalization.
  });

  const directory = beginInstallerTelemetry("install");
  expect(directory).not.toBeNull();
  expect(telemetryRuntime.config?.endpoint.href).toBe(TEST_TELEMETRY_ENDPOINT);
  fs.rmSync(directory!, { recursive: true, force: true });
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

it("sends one schema-valid envelope without private position keys (#12859)", async () => {
  allowLocalTelemetry();
  localReceiver();
  const privateValue = "secret-key_https://private.example/home_10.0.0.7_sandbox-name";
  collectOperationSnapshot.mockResolvedValue({
    ...snapshot,
    targetPositions: new Map([[privateValue, 0]]),
  });
  const fetchMock = vi.fn(
    async (_url: URL, _request: RequestInit) => new Response(null, { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect(await sendOperationTelemetry(context, 1_000)).toBe("accepted");
  expect(fetchMock).toHaveBeenCalledOnce();
  const [, request] = fetchMock.mock.calls[0];
  const body = JSON.parse(String(request.body));
  expect(body.events).toHaveLength(1);
  expect(isOperationEvent(body.events[0])).toBe(true);
  expect(JSON.stringify(body)).not.toContain(privateValue);
});

it("does not collect or send when opted out or given a disallowed receiver (#12859)", async () => {
  allowLocalTelemetry();
  localReceiver();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", "1");
  expect(await sendOperationTelemetry(context, 1_000)).toBe("disabled");
  expect(collectOperationSnapshot).not.toHaveBeenCalled();
  vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", undefined);

  telemetryRuntime.config = { endpoint: new URL("https://private.example/") };
  expect(await sendOperationTelemetry(context, 1_000)).toBe("disabled");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("rejects malformed records and a failed receiver without retry (#12859)", async () => {
  allowLocalTelemetry();
  localReceiver();
  const fetchMock = vi.fn(async () => {
    throw new Error("receiver unavailable");
  });
  vi.stubGlobal("fetch", fetchMock);
  collectOperationSnapshot.mockResolvedValue({ ...snapshot, privateCredential: "secret-key" });
  expect(await sendOperationTelemetry(context, 1_000)).toBe("failed");
  expect(fetchMock).not.toHaveBeenCalled();

  collectOperationSnapshot.mockResolvedValue(snapshot);
  expect(await sendOperationTelemetry(context, 1_000)).toBe("failed");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(await sendOperationTelemetry(context, 0)).toBe("failed");
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("stops collection at the delivery deadline when a reader ignores cancellation (#12859)", async () => {
  allowLocalTelemetry();
  localReceiver();
  collectOperationSnapshot.mockImplementation(() => new Promise(() => undefined));
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const startedAt = performance.now();
  expect(await sendOperationTelemetry(context, 25)).toBe("failed");
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  expect(fetchMock).not.toHaveBeenCalled();
});
