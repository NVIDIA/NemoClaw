// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { parseDashboardOrigins } from "../../src/lib/dashboard/url";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/openclaw-env-fixture";

const BASE_ENV = baseOpenClawGenerationEnv();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-origins-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildConfigDirect(envOverrides: Record<string, string> = {}): any {
  const env = buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides);
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return buildConfig();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

function expectBuildConfigError(envOverrides: Record<string, string>, message: RegExp): void {
  expect(() => buildConfigDirect(envOverrides)).toThrow(message);
}

describe("generate-openclaw-config.mts: NEMOCLAW_DASHBOARD_ORIGINS (#13177)", () => {
  it("adds browser origins that keep their own port", () => {
    const config = buildConfigDirect({
      CHAT_UI_URL: "https://launchpad.example.test:18789",
      NEMOCLAW_DASHBOARD_ORIGINS: "https://launchpad.example.test:8443,http://localhost:9000",
    });
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "https://launchpad.example.test:18789",
      "https://launchpad.example.test",
      "https://launchpad.example.test:8443",
      "http://localhost:9000",
    ]);
  });

  it("leaves allowedOrigins unchanged when the list is empty", () => {
    const config = buildConfigDirect({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DASHBOARD_ORIGINS: "",
    });
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("does not change the dashboard bind for an extra remote origin", () => {
    const withOrigin = buildConfigDirect({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DASHBOARD_ORIGINS: "https://launchpad.example.test:8443",
    });
    const without = buildConfigDirect({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(withOrigin.gateway.bind).toEqual(without.gateway.bind);
    expect(withOrigin.gateway.controlUi.allowedOrigins).toContain(
      "https://launchpad.example.test:8443",
    );
  });

  it("takes each origin from the validated startup profile without re-deciding its policy", () => {
    const config = buildConfigDirect({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DASHBOARD_ORIGINS: "https://launchpad.example.test:8443, http://localhost:9000",
    });
    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "https://launchpad.example.test:8443",
      "http://localhost:9000",
    ]);
  });

  it("normalizes an origin the way parseDashboardOrigins does", () => {
    const value = " HTTPS://Launchpad.Example.Test:8443/,https://launchpad.example.test:443 ";
    const config = buildConfigDirect({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DASHBOARD_ORIGINS: value,
    });
    expect(config.gateway.controlUi.allowedOrigins.slice(1)).toEqual(
      parseDashboardOrigins([value]),
    );
  });

  it.each([
    ["a path", "https://launchpad.example.test:8443/dashboard"],
    ["a value that is not a URL", "launchpad.example.test"],
    ["plain http for a remote host", "http://launchpad.example.test:8443"],
    ["a non-http scheme", "ftp://launchpad.example.test"],
    ["user information", "https://user@launchpad.example.test"],
  ])("refuses an entry with %s instead of widening allowedOrigins", (_case, origin) => {
    expectBuildConfigError(
      { CHAT_UI_URL: "http://127.0.0.1:18789", NEMOCLAW_DASHBOARD_ORIGINS: origin },
      /NEMOCLAW_DASHBOARD_ORIGINS/,
    );
  });

  it("does not echo a rejected entry's user information", () => {
    let message = "";
    try {
      buildConfigDirect({
        CHAT_UI_URL: "http://127.0.0.1:18789",
        NEMOCLAW_DASHBOARD_ORIGINS:
          "https://launchpad.example.test,https://admin:s3cret@launchpad.example.test",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/NEMOCLAW_DASHBOARD_ORIGINS entry 2/);
    expect(message).not.toMatch(/admin|s3cret/);
  });

  it.each([
    ["a control character", "https://launchpad.example.test\u0001"],
    ["an over-long value", `https://${"a".repeat(2050)}.example.test`],
  ])("refuses %s the same way parseDashboardOrigins does", (_case, origin) => {
    expect(() => parseDashboardOrigins([origin])).toThrow();
    expectBuildConfigError(
      { CHAT_UI_URL: "http://127.0.0.1:18789", NEMOCLAW_DASHBOARD_ORIGINS: origin },
      /NEMOCLAW_DASHBOARD_ORIGINS entry 1/,
    );
  });

  it("refuses more origins than one sandbox may record", () => {
    const origins = Array.from({ length: 17 }, (_, i) => `https://o${i}.example.test:8443`);
    expectBuildConfigError(
      { CHAT_UI_URL: "http://127.0.0.1:18789", NEMOCLAW_DASHBOARD_ORIGINS: origins.join(",") },
      /NEMOCLAW_DASHBOARD_ORIGINS/,
    );
  });
});
