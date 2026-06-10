// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactForLog, redactFull, redactUrl } from "./security/redact";

type TraceStatusCode = "OK" | "ERROR" | "UNSET";
type TraceAttribute = string | number | boolean | null | string[] | number[] | boolean[];
type TraceAttributes = Record<string, TraceAttribute>;

export interface TraceEvent {
  name: string;
  time_unix_nano: string;
  attributes?: TraceAttributes;
}

export interface TraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind: "INTERNAL";
  start_time_unix_nano: string;
  end_time_unix_nano?: string;
  duration_ms?: number;
  status: {
    code: TraceStatusCode;
    message?: string;
  };
  attributes: TraceAttributes;
  events: TraceEvent[];
}

export interface TraceArtifact {
  resource_spans: [
    {
      resource: {
        attributes: TraceAttributes;
      };
      scope_spans: [
        {
          scope: {
            name: string;
            version: string;
          };
          spans: TraceSpan[];
        },
      ];
    },
  ];
  summary: {
    trace_id: string;
    generated_at: string;
    total_duration_ms: number;
    slowest_spans: Array<{ name: string; duration_ms: number; status: TraceStatusCode }>;
    output_path: string;
  };
}

const TRACE_SCOPE_NAME = "nemoclaw.onboard";
const TRACE_SCOPE_VERSION = "1.0.0";
export const TRACE_ENABLED_ENV = "NEMOCLAW_TRACE";
export const TRACE_FILE_ENV = "NEMOCLAW_TRACE_FILE";
export const TRACE_DIR_ENV = "NEMOCLAW_TRACE_DIR";
const DEFAULT_TRACE_DIR = path.join(".e2e", "traces");
const MAX_ATTRIBUTE_STRING_LENGTH = 240;
const SENSITIVE_ATTRIBUTE_KEY =
  /(?:api[_-]?key|token|secret|password|authorization|bearer|cookie|set-cookie)/i;

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function durationMs(startNs: bigint, endNs: bigint): number {
  return Number(endNs - startNs) / 1_000_000;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function sanitizeAttributeValue(key: string, value: unknown): TraceAttribute | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (SENSITIVE_ATTRIBUTE_KEY.test(key)) return "<REDACTED>";
    const urlValue = redactUrl(value);
    const redacted = redactFull(urlValue ?? value);
    return redacted.slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => sanitizeAttributeValue(key, entry))
      .filter((entry): entry is string | number | boolean => {
        return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean";
      });
    if (entries.every((entry) => typeof entry === "string")) return entries as string[];
    if (entries.every((entry) => typeof entry === "number")) return entries as number[];
    if (entries.every((entry) => typeof entry === "boolean")) return entries as boolean[];
    return entries.map((entry) => String(entry));
  }
  const redacted = redactForLog(value);
  try {
    return JSON.stringify(redacted).slice(0, MAX_ATTRIBUTE_STRING_LENGTH);
  } catch {
    return "[unserializable]";
  }
}

export function sanitizeTraceAttributes(attributes: Record<string, unknown> = {}): TraceAttributes {
  const safe: TraceAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const sanitized = sanitizeAttributeValue(key, value);
    if (sanitized !== undefined) safe[key] = sanitized;
  }
  return safe;
}

function isTraceFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

function traceFileName(): string {
  const stamp = new Date().toISOString().replace("T", "-").replace(/[:.]/g, "-");
  return `nemoclaw-trace-${stamp}-pid-${process.pid}.json`;
}

function resolveTracePath(env: NodeJS.ProcessEnv): string | null {
  const traceFile = env[TRACE_FILE_ENV]?.trim();
  if (traceFile) return path.resolve(traceFile);
  const traceDir = env[TRACE_DIR_ENV]?.trim();
  if (traceDir) return path.resolve(traceDir, traceFileName());
  if (isTraceFlagEnabled(env[TRACE_ENABLED_ENV])) {
    return path.resolve(DEFAULT_TRACE_DIR, traceFileName());
  }
  return null;
}

export class TraceCollector {
  readonly traceId = randomHex(16);
  readonly outputPath: string;
  private readonly spans: TraceSpan[] = [];
  private readonly spanStack: TraceSpan[] = [];
  private readonly startNs = nowNs();
  private flushed = false;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  startSpan(name: string, attributes: Record<string, unknown> = {}): TraceSpan {
    const parent = this.spanStack.at(-1);
    const span: TraceSpan & { _startNs?: bigint } = {
      trace_id: this.traceId,
      span_id: randomHex(8),
      ...(parent ? { parent_span_id: parent.span_id } : {}),
      name,
      kind: "INTERNAL",
      start_time_unix_nano: nowNs().toString(),
      status: { code: "UNSET" },
      attributes: sanitizeTraceAttributes(attributes),
      events: [],
    };
    span._startNs = BigInt(span.start_time_unix_nano);
    this.spans.push(span);
    this.spanStack.push(span);
    return span;
  }

  endSpan(span: TraceSpan, status: TraceStatusCode = "OK", message?: string): void {
    const internal = span as TraceSpan & { _startNs?: bigint };
    if (span.end_time_unix_nano) return;
    const endNs = nowNs();
    span.end_time_unix_nano = endNs.toString();
    span.duration_ms = durationMs(internal._startNs ?? BigInt(span.start_time_unix_nano), endNs);
    span.status = message
      ? { code: status, message: redactFull(message).slice(0, 200) }
      : { code: status };
    const index = this.spanStack.lastIndexOf(span);
    if (index >= 0) this.spanStack.splice(index, 1);
    delete internal._startNs;
  }

  addEvent(span: TraceSpan, name: string, attributes: Record<string, unknown> = {}): void {
    span.events.push({
      name,
      time_unix_nano: nowNs().toString(),
      attributes: sanitizeTraceAttributes(attributes),
    });
  }

  activeSpan(): TraceSpan | null {
    return this.spanStack.at(-1) ?? null;
  }

  flush(finalStatus: TraceStatusCode = "OK", message?: string): string | null {
    if (this.flushed) return this.outputPath;
    while (this.spanStack.length > 0) {
      const span = this.spanStack.pop();
      if (span) this.endSpan(span, finalStatus, message);
    }
    const endNs = nowNs();
    const slowest = [...this.spans]
      .filter((span) => span.name !== "nemoclaw.onboard")
      .filter((span) => typeof span.duration_ms === "number")
      .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
      .slice(0, 10)
      .map((span) => ({
        name: span.name,
        duration_ms: Number((span.duration_ms ?? 0).toFixed(3)),
        status: span.status.code,
      }));
    const artifact: TraceArtifact = {
      resource_spans: [
        {
          resource: {
            attributes: sanitizeTraceAttributes({
              "service.name": "nemoclaw",
              "service.version": process.env.npm_package_version || "unknown",
              "host.type": os.type(),
              "os.platform": process.platform,
              "process.pid": process.pid,
              ci: process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
            }),
          },
          scope_spans: [
            {
              scope: {
                name: TRACE_SCOPE_NAME,
                version: TRACE_SCOPE_VERSION,
              },
              spans: this.spans,
            },
          ],
        },
      ],
      summary: {
        trace_id: this.traceId,
        generated_at: new Date().toISOString(),
        total_duration_ms: Number(durationMs(this.startNs, endNs).toFixed(3)),
        slowest_spans: slowest,
        output_path: this.outputPath,
      },
    };
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
    this.flushed = true;
    return this.outputPath;
  }
}

let collector: TraceCollector | null | undefined;
let exitHandler: ((code: number) => void) | null = null;

export function getTraceCollector(): TraceCollector | null {
  if (collector !== undefined) return collector;
  const tracePath = resolveTracePath(process.env);
  collector = tracePath ? new TraceCollector(tracePath) : null;
  if (collector) {
    exitHandler = (code) => {
      collector?.flush(code === 0 ? "OK" : "ERROR", `process exited with code ${code}`);
    };
    process.once("exit", exitHandler);
  }
  return collector;
}

export function resetTraceForTests(): void {
  if (exitHandler) {
    process.removeListener("exit", exitHandler);
  }
  exitHandler = null;
  collector = undefined;
}

export function withTraceSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: () => T,
): T {
  const trace = getTraceCollector();
  if (!trace) return fn();
  const span = trace.startSpan(name, attributes);
  try {
    const result = fn();
    const maybePromise = result as unknown;
    if (
      maybePromise !== null &&
      typeof maybePromise === "object" &&
      typeof (maybePromise as { then?: unknown }).then === "function"
    ) {
      return (maybePromise as Promise<unknown>)
        .then((value) => {
          trace.endSpan(span, "OK");
          return value;
        })
        .catch((error) => {
          trace.endSpan(span, "ERROR", error instanceof Error ? error.message : String(error));
          throw error;
        }) as T;
    }
    trace.endSpan(span, "OK");
    return result;
  } catch (error) {
    trace.endSpan(span, "ERROR", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function addTraceEvent(name: string, attributes: Record<string, unknown> = {}): void {
  const trace = getTraceCollector();
  const span = trace?.activeSpan() ?? null;
  if (trace && span) trace.addEvent(span, name, attributes);
}

export function flushTrace(status: TraceStatusCode = "OK", message?: string): string | null {
  return getTraceCollector()?.flush(status, message) ?? null;
}
