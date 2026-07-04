// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized logger for NemoClaw CLI.
 *
 * Levels (lowest → highest verbosity):
 *   error < warn < info < debug
 *
 * Default level: info (errors, warnings, and info messages shown).
 * Quiet mode:    warn (only warnings and errors shown).
 * Debug mode:    debug (all messages shown with timestamps).
 *
 * Configure via:
 *   NEMOCLAW_LOG_LEVEL=debug nemoclaw ...
 *   nemoclaw ... --debug         (shorthand for debug level)
 *   nemoclaw ... -q / --quiet    (suppresses info, shows warn+error)
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const env = process.env.NEMOCLAW_LOG_LEVEL?.toLowerCase();
  if (env === "error" || env === "warn" || env === "info" || env === "debug") return env;
  if (process.env.NEMOCLAW_DEBUG === "1" || process.env.DEBUG?.includes("nemoclaw")) return "debug";
  return "info";
}

class Logger {
  private _level: LogLevel;
  private _quiet: boolean;
  private _timestamps: boolean;

  constructor() {
    this._level = resolveLevel();
    this._quiet = false;
    this._timestamps = this._level === "debug";
  }

  get level(): LogLevel {
    return this._level;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
    this._timestamps = level === "debug";
  }

  setQuiet(quiet: boolean): void {
    this._quiet = quiet;
    if (quiet && LEVEL_RANK[this._level] > LEVEL_RANK["warn"]) {
      this._level = "warn";
    }
  }

  setDebug(debug: boolean): void {
    if (debug) this.setLevel("debug");
  }

  isDebug(): boolean {
    return this._level === "debug";
  }

  isQuiet(): boolean {
    return this._quiet;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this._level];
  }

  private prefix(level: LogLevel): string {
    if (!this._timestamps) return "";
    const ts = new Date().toISOString();
    return `[${ts}] [${level.toUpperCase()}] `;
  }

  error(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("error")) return;
    const parts = [this.prefix("error") + message, ...args.map(String)].join(" ");
    process.stderr.write(parts + "\n");
  }

  warn(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("warn")) return;
    const parts = [this.prefix("warn") + message, ...args.map(String)].join(" ");
    process.stderr.write(parts + "\n");
  }

  info(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("info")) return;
    const parts = [this.prefix("info") + message, ...args.map(String)].join(" ");
    process.stderr.write(parts + "\n");
  }

  debug(message: string, ...args: unknown[]): void {
    if (!this.shouldLog("debug")) return;
    const parts = [this.prefix("debug") + message, ...args.map(String)].join(" ");
    process.stderr.write(parts + "\n");
  }

  /** Log a structured object at debug level. Redacts nothing — call only with safe data. */
  debugObject(label: string, obj: unknown): void {
    if (!this.shouldLog("debug")) return;
    const ts = this._timestamps ? `[${new Date().toISOString()}] [DEBUG] ` : "";
    process.stderr.write(`${ts}${label}: ${JSON.stringify(obj, null, 2)}\n`);
  }
}

/** Singleton logger shared across all NemoClaw modules. */
export const log = new Logger();
