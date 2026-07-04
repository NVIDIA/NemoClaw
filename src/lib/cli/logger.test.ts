// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LogLevel } from "./logger";

// Re-import logger fresh for each test to reset singleton state
async function freshLogger() {
  vi.resetModules();
  const mod = await import("./logger");
  return mod;
}

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stderrSpy.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("defaults to info level", async () => {
    const { log } = await freshLogger();
    expect(log.level).toBe("info");
  });

  it("reads NEMOCLAW_LOG_LEVEL from env", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "debug");
    const { log } = await freshLogger();
    expect(log.level).toBe("debug");
  });

  it("suppresses debug messages at info level", async () => {
    const { log } = await freshLogger();
    log.setLevel("info");
    log.debug("should not appear");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("shows debug messages after setDebug(true)", async () => {
    const { log } = await freshLogger();
    log.setDebug(true);
    log.debug("visible debug");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("visible debug"));
  });

  it("quiet mode suppresses info", async () => {
    const { log } = await freshLogger();
    log.setQuiet(true);
    log.info("suppressed info");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("quiet mode still shows warn", async () => {
    const { log } = await freshLogger();
    log.setQuiet(true);
    log.warn("visible warning");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("visible warning"));
  });

  it("error always shown", async () => {
    const { log } = await freshLogger();
    log.setLevel("error" as LogLevel);
    log.error("critical error");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("critical error"));
  });

  it("error suppressed below error level only for warn+info+debug", async () => {
    const { log } = await freshLogger();
    log.setLevel("error" as LogLevel);
    log.warn("should be suppressed");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("debugObject emits JSON at debug level", async () => {
    const { log } = await freshLogger();
    log.setLevel("debug");
    log.debugObject("context", { key: "val" });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('"key"'));
  });

  it("debugObject suppressed at info level", async () => {
    const { log } = await freshLogger();
    log.setLevel("info");
    log.debugObject("context", { key: "val" });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
