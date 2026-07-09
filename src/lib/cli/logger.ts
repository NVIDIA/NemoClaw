// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactForLog, redactLogSequence } from "../security/redact";

/**
 * Centralized logger for NemoClaw CLI.
 *
 * Levels (lowest → highest verbosity):
 *   error < warn < info < debug
 *
 * Default level: info (errors, warnings, and info messages shown).
 * Quiet mode:    at most warn (only warnings and errors shown).
 * Debug mode:    debug (all messages shown with timestamps).
 *
 * Configure via:
 *   NEMOCLAW_LOG_LEVEL=debug nemoclaw ...
 *   NEMOCLAW_DEBUG=1 nemoclaw ...
 *   nemoclaw ... --debug
 *   nemoclaw ... --quiet
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LoggerConfig = {
  debug?: boolean;
  quiet?: boolean;
};

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const TRUE_ENV_VALUES = new Set(["1", "true", "y", "yes"]);
const UNSERIALIZABLE = "[unserializable]";

function resolveLevel(): LogLevel {
  const env = process.env.NEMOCLAW_LOG_LEVEL?.trim().toLowerCase();
  if (env === "error" || env === "warn" || env === "info" || env === "debug") return env;
  const debugEnv = process.env.NEMOCLAW_DEBUG?.trim().toLowerCase();
  if (debugEnv && TRUE_ENV_VALUES.has(debugEnv)) return "debug";
  return "info";
}

function normalizeForSerialization(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol" || typeof value === "function") return String(value);

  try {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (value instanceof Error) {
      const normalized: Record<string, unknown> = {
        name: value.name,
        message: value.message,
      };
      if (value.stack) normalized.stack = value.stack;
      if (value.cause !== undefined) {
        normalized.cause = normalizeForSerialization(value.cause, seen);
      }
      for (const [key, entry] of Object.entries(value)) {
        normalized[key] = normalizeForSerialization(entry, seen);
      }
      return normalized;
    }

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (value instanceof RegExp || value instanceof URL) return String(value);
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
    if (ArrayBuffer.isView(value)) {
      return `[${value.constructor.name} ${value.byteLength} bytes]`;
    }
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
    if (value instanceof Map) {
      const entries: Record<string, unknown> = {};
      for (const [key, entry] of value.entries()) {
        entries[String(key)] = normalizeForSerialization(entry, seen);
      }
      return entries;
    }
    if (value instanceof Set) {
      return [...value].map((entry) => normalizeForSerialization(entry, seen));
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeForSerialization(entry, seen));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeForSerialization(entry, seen)]),
    );
  } catch {
    return UNSERIALIZABLE;
  }
}

function safeSerialize(value: unknown): string {
  try {
    const normalized = normalizeForSerialization(value);
    const serialized = JSON.stringify(redactForLog(normalized), null, 2);
    return serialized ? redact(serialized) : JSON.stringify(UNSERIALIZABLE);
  } catch {
    return JSON.stringify(UNSERIALIZABLE);
  }
}

function safeText(value: unknown): string {
  try {
    if (typeof value === "string") return redact(String(redactForLog(value)));
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return "undefined";
    return safeSerialize(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

class Logger {
  private _level: LogLevel = "info";
  private _quiet = false;
  private _debug = false;

  constructor() {
    this.configure();
  }

  get level(): LogLevel {
    if (this._debug) return "debug";
    if (this._quiet && LEVEL_RANK[this._level] > LEVEL_RANK.warn) return "warn";
    return this._level;
  }

  /** Reset to environment defaults, then apply command-line overrides. */
  configure(config: LoggerConfig = {}): void {
    this._level = resolveLevel();
    this._quiet = config.quiet === true;
    this._debug = config.debug === true;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  setQuiet(quiet: boolean): void {
    this._quiet = quiet;
  }

  setDebug(debug: boolean): void {
    this._debug = debug;
  }

  isDebug(): boolean {
    return this.level === "debug";
  }

  isQuiet(): boolean {
    return this._quiet;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.level];
  }

  private prefix(level: LogLevel): string {
    if (!this.isDebug()) return "";
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] `;
  }

  private emit(line: string): void {
    try {
      process.stderr.write(line);
    } catch {
      // A diagnostic sink must not turn an otherwise successful command into a failure.
    }
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.shouldLog(level)) return;
    const [safeMessage, ...safeArgs] = redactLogSequence([message, ...args]).map(safeText);
    const parts = [this.prefix(level) + safeMessage, ...safeArgs].join(" ");
    this.emit(`${parts}\n`);
  }

  error(message: string, ...args: unknown[]): void {
    this.write("error", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write("warn", message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write("info", message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write("debug", message, args);
  }

  /** Log a redacted structured value without allowing serialization errors to escape. */
  debugObject(label: string, obj: unknown): void {
    if (!this.shouldLog("debug")) return;
    const [safeLabel, safeObject] = redactLogSequence([label, obj]);
    this.emit(`${this.prefix("debug")}${safeText(safeLabel)}: ${safeSerialize(safeObject)}\n`);
  }
}

/** Singleton logger shared across all NemoClaw modules. */
export const log = new Logger();
