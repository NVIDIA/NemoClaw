// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";
import { getVersion } from "../../core/version";
import {
  classifyTelemetryHostOS,
  EMPTY_TELEMETRY_LOCATION,
  parseTelemetryLocation,
  type TelemetryLocation,
} from "../../domain/telemetry/dimensions";
import {
  parseTelemetryEvent,
  readTelemetryTestLabel,
  type TelemetryEvent,
} from "../../domain/telemetry/event";
import { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";
import { isWsl } from "../../platform/wsl";
import { buildTelemetryBatchPayload, GXT_EVENT_PROTOCOL_VERSION } from "./gxt";

export const TELEMETRY_DELIVERY_DEADLINE_MS = 5_000;
export const MAX_TELEMETRY_PAYLOAD_BYTES = 1_048_576;

export interface TelemetryHttpConfig {
  endpoint: URL;
  resolveLocation?: (signal: AbortSignal) => Promise<unknown>;
}

export type TelemetryHttpDeliveryResult = "delivered" | "failed";

function transportFor(endpoint: URL): typeof http | typeof https | null {
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  if (endpoint.protocol === "http:") {
    return ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ? http : null;
  }
  if (endpoint.protocol === "https:") return https;
  return null;
}

async function resolveLocation(
  resolver: NonNullable<TelemetryHttpConfig["resolveLocation"]>,
  signal: AbortSignal,
  budgetMs: number,
): Promise<TelemetryLocation> {
  const unavailable: TelemetryLocation = {
    ...EMPTY_TELEMETRY_LOCATION,
    locationStatus: "unavailable",
  };
  const controller = new AbortController();
  return await new Promise<TelemetryLocation>((resolve) => {
    let settled = false;
    const finish = (location: TelemetryLocation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      controller.abort();
      resolve(location);
    };
    const abort = () => finish(unavailable);
    const timer = setTimeout(abort, budgetMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    // A resolver gets only its bounded signal, never registry state or credentials.
    void Promise.resolve()
      .then(() => resolver(controller.signal))
      .then(
        (value) => {
          if (settled) return;
          let location = unavailable;
          try {
            location = parseTelemetryLocation(value) ?? unavailable;
          } catch {
            // Resolver failures must not prevent the remaining approved fields from being sent.
          }
          finish(location);
        },
        () => finish(unavailable),
      );
  });
}

export async function postTelemetryEvent(
  config: TelemetryHttpConfig,
  value: TelemetryEvent,
  deadlineMs = TELEMETRY_DELIVERY_DEADLINE_MS,
): Promise<TelemetryHttpDeliveryResult> {
  return postTelemetryBatch(config, [value], deadlineMs);
}

export async function postTelemetryBatch(
  config: TelemetryHttpConfig,
  values: readonly TelemetryEvent[],
  deadlineMs = TELEMETRY_DELIVERY_DEADLINE_MS,
): Promise<TelemetryHttpDeliveryResult> {
  const testLabel = readTelemetryTestLabel(process.env);
  if (testLabel === null) return "failed";
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return "failed";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    // Reject the whole batch before collecting host or approved location data.
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_TELEMETRY_BATCH_EVENTS
    ) {
      return "failed";
    }
    const events: TelemetryEvent[] = [];
    for (let index = 0; index < values.length; index++) {
      const event = parseTelemetryEvent(values[index]);
      if (
        !event ||
        (testLabel !== undefined && event.testLabel !== testLabel) ||
        (events.length > 0 && event.testLabel !== events[0].testLabel) ||
        (events.length > 0 && event.operation !== events[0].operation)
      ) {
        return "failed";
      }
      events.push(event);
    }
    if (events.length > 1 && events.some((event) => event.event === "nemoclaw_install_completed")) {
      return "failed";
    }
    const { endpoint: configuredEndpoint, resolveLocation: configuredResolver } = config;
    const endpoint = new URL(configuredEndpoint.href);
    const transport = transportFor(endpoint);
    if (!transport) return "failed";

    const location = configuredResolver
      ? await resolveLocation(
          configuredResolver,
          controller.signal,
          Math.min(1_000, deadlineMs / 2),
        )
      : EMPTY_TELEMETRY_LOCATION;
    if (controller.signal.aborted) return "failed";
    const payload = buildTelemetryBatchPayload(events, {
      clientVersion: getVersion(),
      cpuArchitecture: process.arch,
      hostOS: classifyTelemetryHostOS(process.platform),
      hostContext: isWsl() ? "wsl" : "native",
      location,
      sentAt: new Date(),
    });
    if (!payload) return "failed";
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_TELEMETRY_PAYLOAD_BYTES) return "failed";
    return await postPayload(endpoint, transport, body, controller.signal);
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function postPayload(
  endpoint: URL,
  transport: typeof http | typeof https,
  body: string,
  signal: AbortSignal,
): Promise<TelemetryHttpDeliveryResult> {
  return await new Promise<TelemetryHttpDeliveryResult>((resolve) => {
    let settled = false;
    const settle = (result: TelemetryHttpDeliveryResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => settle("failed");
    if (signal.aborted) {
      settle("failed");
      return;
    }
    signal.addEventListener("abort", abort, { once: true });

    let request: http.ClientRequest;
    try {
      request = transport.request(
        endpoint,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-length": Buffer.byteLength(body).toString(),
            "content-type": "application/json;charset=utf-8",
            "x-event-protocol": GXT_EVENT_PROTOCOL_VERSION,
          },
          signal,
        },
        (response) => {
          response.once("error", () => settle("failed"));
          response.once("aborted", () => settle("failed"));
          response.once("close", () => {
            if (!response.complete) settle("failed");
          });
          response.once("end", () => {
            const status = response.statusCode ?? 0;
            settle(status >= 200 && status < 300 ? "delivered" : "failed");
          });
          response.resume();
        },
      );
    } catch {
      settle("failed");
      return;
    }

    request.once("error", () => settle("failed"));
    request.end(body);
  });
}
