// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Re-import logger fresh for each test to reset singleton state.
async function freshLogger() {
  vi.resetModules();
  return import("./logger");
}

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", undefined);
    vi.stubEnv("NEMOCLAW_DEBUG", undefined);
    vi.stubEnv("DEBUG", undefined);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
  }

  it("defaults to info level", async () => {
    const { log } = await freshLogger();
    expect(log.level).toBe("info");
  });

  it("reads a trimmed case-insensitive NEMOCLAW_LOG_LEVEL", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", " DEBUG ");
    const { log } = await freshLogger();
    expect(log.level).toBe("debug");
  });

  it.each([
    "1",
    "true",
    "y",
    "yes",
    "TRUE",
  ])("enables debug for the supported NEMOCLAW_DEBUG value %s", async (value) => {
    vi.stubEnv("NEMOCLAW_DEBUG", value);
    const { log } = await freshLogger();
    expect(log.level).toBe("debug");
  });

  it.each([
    "*",
    "nemoclaw",
    "foo,*nemoclaw*",
    "foo nemoclaw*",
  ])("enables debug when DEBUG selector %s includes the NemoClaw namespace", async (value) => {
    vi.stubEnv("DEBUG", value);
    const { log } = await freshLogger();
    expect(log.level).toBe("debug");
  });

  it.each([
    "notnemoclaw",
    "foo",
    "*,-nemoclaw",
    "*nemoclaw*,-nemoclaw*",
  ])("does not enable debug when DEBUG selector %s excludes the NemoClaw namespace", async (value) => {
    vi.stubEnv("DEBUG", value);
    const { log } = await freshLogger();
    expect(log.level).toBe("info");
  });

  it("gives a valid NEMOCLAW_LOG_LEVEL precedence over debug selectors", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "error");
    vi.stubEnv("NEMOCLAW_DEBUG", "true");
    vi.stubEnv("DEBUG", "*");
    const { log } = await freshLogger();
    expect(log.level).toBe("error");
  });

  it("falls through an invalid NEMOCLAW_LOG_LEVEL to debug selectors", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "verbose");
    vi.stubEnv("NEMOCLAW_DEBUG", "true");
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
    expect(output()).toContain("visible debug");
  });

  it("quiet mode suppresses info and still shows warnings", async () => {
    const { log } = await freshLogger();
    log.setQuiet(true);
    log.info("suppressed info");
    log.warn("visible warning");
    expect(output()).toBe("visible warning\n");
  });

  it("can remove quiet and debug overrides without leaking state", async () => {
    const { log } = await freshLogger();
    log.setQuiet(true);
    expect(log.level).toBe("warn");
    log.setQuiet(false);
    expect(log.level).toBe("info");
    log.setDebug(true);
    expect(log.level).toBe("debug");
    log.setDebug(false);
    expect(log.level).toBe("info");
  });

  it("configure resets prior overrides to the current environment baseline", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "error");
    const { log } = await freshLogger();
    log.setDebug(true);
    log.setQuiet(true);
    log.configure();
    expect(log.level).toBe("error");
    expect(log.isQuiet()).toBe(false);
  });

  it("quiet overrides environment debug without retaining debug timestamps", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "debug");
    const { log } = await freshLogger();
    log.configure({ quiet: true });
    log.warn("visible warning");
    expect(log.level).toBe("warn");
    expect(output()).toBe("visible warning\n");
  });

  it("shows only errors at error level", async () => {
    const { log } = await freshLogger();
    log.setLevel("error");
    log.warn("suppressed warning");
    log.error("critical error");
    expect(output()).toBe("critical error\n");
  });

  it("redacts secrets from messages, arguments, labels, and structured values", async () => {
    const secret = `nvapi-${"a".repeat(40)}`;
    const { log } = await freshLogger();
    log.setDebug(true);
    log.debug(`token=${secret}`, { authorization: `Bearer ${secret}` });
    log.debugObject(`context ${secret}`, {
      apiKey: secret,
      auth: "opaque-auth-secret",
      cookie: "session=opaque-cookie-secret",
      "API Key": "opaque-api-secret",
      nested: { message: `Bearer ${secret}` },
      url: "https://user:password@example.test/path?access_token=raw-token",
    });
    expect(output()).not.toContain(secret);
    expect(output()).not.toContain("user:password");
    expect(output()).not.toContain("raw-token");
    expect(output()).not.toContain("opaque-auth-secret");
    expect(output()).not.toContain("opaque-cookie-secret");
    expect(output()).not.toContain("opaque-api-secret");
    expect(output()).toContain("<REDACTED>");
  });

  it("serializes circular values, BigInt, Error, Map, and Set without throwing", async () => {
    const { log } = await freshLogger();
    log.setDebug(true);
    const value: Record<string, unknown> = {
      count: 1n,
      error: new Error("failure"),
      map: new Map([["token", "secret-value"]]),
      set: new Set(["one", "two"]),
    };
    value.self = value;
    expect(() => log.debugObject("context", value)).not.toThrow();
    expect(output()).toContain('"count": "1"');
    expect(output()).toContain('"self": "[Circular]"');
    expect(output()).toContain('"name": "Error"');
  });

  it("does not let a synchronous stderr failure escape", async () => {
    const { log } = await freshLogger();
    stderrSpy.mockImplementation(() => {
      throw new Error("closed sink");
    });
    expect(() => log.error("failure")).not.toThrow();
    log.setDebug(true);
    expect(() => log.debugObject("context", { ok: true })).not.toThrow();
  });

  it("suppresses debugObject at info level", async () => {
    const { log } = await freshLogger();
    log.debugObject("context", { key: "val" });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
