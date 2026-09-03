// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";
import type { TelemetryEvent } from "../../domain/telemetry/event";
import { parseTelemetryEvent } from "../../domain/telemetry/event";

export const TELEMETRY_DELIVERY_DEADLINE_MS = 5_000;

export interface TelemetryHttpConfig {
  endpoint: URL;
}

export type TelemetryHttpDeliveryResult = "delivered" | "failed";

function transportFor(endpoint: URL): typeof http | typeof https | null {
  if (endpoint.protocol === "http:") return http;
  if (endpoint.protocol === "https:") return https;
  return null;
}

export async function postTelemetryEvent(
  config: TelemetryHttpConfig,
  event: TelemetryEvent,
  deadlineMs = TELEMETRY_DELIVERY_DEADLINE_MS,
): Promise<TelemetryHttpDeliveryResult> {
  const canonicalEvent = parseTelemetryEvent(event);
  if (!canonicalEvent || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    return "failed";
  }

  const transport = transportFor(config.endpoint);
  if (!transport) return "failed";

  const body = JSON.stringify(canonicalEvent);
  const signal = AbortSignal.timeout(deadlineMs);

  return await new Promise<TelemetryHttpDeliveryResult>((resolve) => {
    let settled = false;
    const settle = (result: TelemetryHttpDeliveryResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    signal.addEventListener("abort", () => settle("failed"), { once: true });

    let request: http.ClientRequest;
    try {
      request = transport.request(
        config.endpoint,
        {
          method: "POST",
          headers: {
            "content-length": Buffer.byteLength(body).toString(),
            "content-type": "application/json",
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
