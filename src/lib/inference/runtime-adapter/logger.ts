// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compactText } from "../../core/url-utils";
import { appendLocalAdapterJsonLine } from "../local-adapter-lifecycle";

export type AdapterLogFields = Record<string, string | number | boolean | null | undefined>;
export type AdapterLogger = (event: string, fields?: AdapterLogFields) => void;

export interface LocalAdapterLoggerFactory {
  defaultLogger: AdapterLogger;
  logEvent(logger: AdapterLogger, event: string, fields?: AdapterLogFields): void;
}

function normalizeLogField(
  value: string | number | boolean | null | undefined,
): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string") return compactText(value).slice(0, 180);
  return value;
}

function errorMessage(error: unknown): string {
  return compactText(error instanceof Error ? error.message : String(error));
}

/** Build the shared best-effort JSONL logger used by host-side inference adapters. */
export function createLocalAdapterLogger(options: {
  logPath: string;
  onWriteError?: (message: string) => void;
  onLoggerError?: (message: string) => void;
}): LocalAdapterLoggerFactory {
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
      options.onWriteError?.(errorMessage(error));
    }
  };

  return {
    defaultLogger,
    logEvent: (logger, event, fields = {}) => {
      try {
        // Callers may inject a scenario-specific logger; this wrapper keeps
        // diagnostics from affecting request handling.
        logger(event, fields);
      } catch (error) {
        options.onLoggerError?.(errorMessage(error));
      }
    },
  };
}
