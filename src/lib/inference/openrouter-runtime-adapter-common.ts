// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

import { compactText } from "../core/url-utils";
import { OPENROUTER_DEFAULT_HEADERS, OPENROUTER_ENDPOINT_URL } from "./openrouter";
import {
  DEFAULT_LOCAL_ADAPTER_STATE_DIR,
  appendLocalAdapterJsonLine,
  type JsonObject,
} from "./local-adapter-lifecycle";

export const STATE_DIR = DEFAULT_LOCAL_ADAPTER_STATE_DIR;
export const PID_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.pid");
export const STATE_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.json");
export const LOCK_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.lock");
export const LOG_PATH = path.join(STATE_DIR, "openrouter-runtime-adapter.log");
export const ADAPTER_NAME = "openrouter-runtime";
export const OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV =
  "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH";

export type AdapterLogFields = Record<string, string | number | boolean | null | undefined>;
export type AdapterLogger = (event: string, fields?: AdapterLogFields) => void;

function normalizeLogField(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string") return compactText(value).slice(0, 180);
  return value;
}

export function defaultAdapterLogger(event: string, fields: AdapterLogFields = {}): void {
  try {
    const payload: Record<string, string | number | boolean | null> = {
      ts: new Date().toISOString(),
      event: normalizeLogField(event) as string,
    };
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = normalizeLogField(value);
    }
    appendLocalAdapterJsonLine(LOG_PATH, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OpenRouter Runtime adapter log write failed: ${compactText(message)}`);
  }
}

export function logAdapterEvent(
  logger: AdapterLogger,
  event: string,
  fields: AdapterLogFields = {},
): void {
  try {
    logger(event, fields);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`OpenRouter Runtime adapter logger failed: ${compactText(message)}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function adapterConfigHash(upstreamBaseUrl = OPENROUTER_ENDPOINT_URL): string {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        adapter: ADAPTER_NAME,
        upstreamBaseUrl,
        defaultHeaders: OPENROUTER_DEFAULT_HEADERS,
      }),
    )
    .digest("hex");
}

export function adapterAuthorizationHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function normalizeAuthorizationHash(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function normalizeHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
}

export function sendJson(res: http.ServerResponse, status: number, body: JsonObject): void {
  res.statusCode = normalizeHttpStatus(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
