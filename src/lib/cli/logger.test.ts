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

  it("does not treat the framework DEBUG variable as a NemoClaw logging control", async () => {
    vi.stubEnv("DEBUG", "*");
    const { log } = await freshLogger();
    expect(log.level).toBe("info");
  });

  it("gives a valid NEMOCLAW_LOG_LEVEL precedence over NEMOCLAW_DEBUG", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "error");
    vi.stubEnv("NEMOCLAW_DEBUG", "true");
    const { log } = await freshLogger();
    expect(log.level).toBe("error");
  });

  it("falls through an invalid NEMOCLAW_LOG_LEVEL to NEMOCLAW_DEBUG", async () => {
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

  it("keeps diagnostic arguments after prose that mentions credentials", async () => {
    const { log } = await freshLogger();
    log.setDebug(true);
    log.debug("Failed to refresh token, retrying", { attempt: 3 });
    log.debugObject("Token refresh failed", { attempt: 4 });
    expect(output()).toContain('"attempt": 3');
    expect(output()).toContain('"attempt": 4');
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
    log.debug("Authorization: Basic opaque-basic-header");
    log.debug("Proxy-Authorization: Digest username=opaque-user, response=opaque-response");
    log.debug("Cookie: session=opaque-cookie-header");
    log.debug("Set-Cookie: session=opaque-set-cookie-header; HttpOnly");
    log.debug("OPENAI_API_KEY", "opaque-split-env-value");
    log.debug("NEMOCLAW_PROVIDER_KEY", "-opaque-leading-dash-value");
    log.debug("author", "safe author argument");
    log.debugObject(`context ${secret}`, {
      apiKey: secret,
      auth: "opaque-auth-secret",
      API_SERVER_KEY: "opaque-server-key",
      NEMOCLAW_PROVIDER_KEY: "opaque-provider-key",
      privateKey: "opaque-private-key",
      sessionKey: "opaque-session-key",
      "API Key": "opaque-api-secret",
      headers: {
        "Proxy-Authorization": "Basic opaque-basic-secret",
        Cookie: "session=opaque-cookie-secret",
      },
      publicKey: "safe public key",
      author: "safe author",
      argv: [
        "--password",
        "opaque-cli-password",
        "--api-key",
        "opaque-cli-api-key",
        "--public-key",
        "safe CLI public key",
        "--author",
        "safe CLI author",
      ],
      nested: { message: `Bearer ${secret}` },
      url: "https://user:password@example.test/path?access_token=raw-token",
    });
    expect(output()).not.toContain(secret);
    expect(output()).not.toContain("user:password");
    expect(output()).not.toContain("raw-token");
    expect(output()).not.toContain("opaque-auth-secret");
    expect(output()).not.toContain("opaque-server-key");
    expect(output()).not.toContain("opaque-provider-key");
    expect(output()).not.toContain("opaque-private-key");
    expect(output()).not.toContain("opaque-session-key");
    expect(output()).not.toContain("opaque-basic-secret");
    expect(output()).not.toContain("opaque-basic-header");
    expect(output()).not.toContain("opaque-user");
    expect(output()).not.toContain("opaque-response");
    expect(output()).not.toContain("opaque-cookie-secret");
    expect(output()).not.toContain("opaque-cookie-header");
    expect(output()).not.toContain("opaque-set-cookie-header");
    expect(output()).not.toContain("opaque-api-secret");
    expect(output()).not.toContain("opaque-split-env-value");
    expect(output()).not.toContain("opaque-leading-dash-value");
    expect(output()).not.toContain("opaque-cli-password");
    expect(output()).not.toContain("opaque-cli-api-key");
    expect(output()).toContain("safe public key");
    expect(output()).toContain("safe author");
    expect(output()).toContain("safe author argument");
    expect(output()).toContain("safe CLI public key");
    expect(output()).toContain("safe CLI author");
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
