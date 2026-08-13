// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../../core/url-utils";
import { appendLocalAdapterJsonLine } from "../local-adapter-lifecycle";

export type AdapterLogFields = Record<string, string | number | boolean | null | undefined>;
export type AdapterLogger = (event: string, fields?: AdapterLogFields) => void;

/** Normalize one log field for compact, bounded JSONL output. */
function normalizeLogField(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string") return compactText(value).slice(0, 180);
  return value;
}

/** Convert an unknown failure into a compact diagnostic message. */
function errorMessage(error: unknown): string {
  try {
    return compactText(error instanceof Error ? error.message : String(error));
  } catch {
    return "adapter logger diagnostic unavailable";
  }
}

/** Invoke an optional diagnostic callback without exposing its failures. */
function reportDiagnosticFailure(
  callback: ((message: string) => void) | undefined,
  error: unknown,
): void {
  if (!callback) return;
  try {
    callback(errorMessage(error));
  } catch {
    // Diagnostics must never replace the adapter result or error path.
  }
}

/** Build the shared best-effort JSONL logger used by host-side inference adapters. */
export function createLocalAdapterLogger(options: {
  logPath: string;
  onWriteError?: (message: string) => void;
  onLoggerError?: (message: string) => void;
}) {
  const defaultLogger: AdapterLogger = (event, fields = {}) => {
    try {
      const payload: Record<string, string | number | boolean | null> = {
        ts: new Date().toISOString(),
        event: normalizeLogField(event) as string,
      };
      for (const [key, value] of Object.entries(fields)) {
        payload[key] = normalizeLogField(value);
      }
      appendLocalAdapterJsonLine(options.logPath, payload);
    } catch (error) {
      reportDiagnosticFailure(options.onWriteError, error);
    }
  };

  return {
    defaultLogger,
    logEvent: (logger: AdapterLogger, event: string, fields: AdapterLogFields = {}) => {
      try {
        // Callers may inject a scenario-specific logger; this wrapper keeps
        // diagnostics from affecting request handling.
        logger(event, fields);
      } catch (error) {
        reportDiagnosticFailure(options.onLoggerError, error);
      }
    },
  };
}
