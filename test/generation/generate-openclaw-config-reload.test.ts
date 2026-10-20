// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent changes must reach the live gateway. Restart-class changes remain
// protected by the container fresh-process restart patch (#4710, #13268).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig, main } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

/** Minimal env vars required for a valid config generation run. */
const BASE_ENV = baseOpenClawGenerationEnv();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-reload-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function withConfigEnv<T>(envOverrides: Record<string, string>, fn: () => T): T {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env).filter(
    (key) => key.startsWith("NEMOCLAW_") || key === "CHAT_UI_URL",
  )) {
    delete process.env[key];
  }
  Object.assign(process.env, BASE_ENV, envOverrides, { HOME: tmpDir });
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env).filter((key) => !(key in originalEnv))) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

function buildConfigDirect(envOverrides: Record<string, string> = {}): any {
  return withConfigEnv(envOverrides, () => buildConfig());
}

describe("gateway.reload pin (#4710)", () => {
  it("enables hybrid reload in the generated config", () => {
    const config = buildConfigDirect();
    expect(config.gateway.reload).toEqual({ mode: "hybrid" });
  });

  it.each([
    { NEMOCLAW_WEB_SEARCH_ENABLED: "1" },
    { NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0" },
    { NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5m" },
    { CHAT_UI_URL: "http://127.0.0.1:18792" },
  ])("keeps the pin across unrelated env permutations [case %#]", (overrides) => {
    const config = buildConfigDirect(overrides);
    expect(config.gateway.reload, JSON.stringify(overrides)).toEqual({ mode: "hybrid" });
  });

  // Generous timeout: main() does real file I/O and the suite shares a
  // worker pool with heavier integration files.
  it(
    "enables reload when an existing config disables it",
    {
      timeout: 20000,
    },
    () => {
      // Native plugin install records stay under OpenClaw ownership, while the
      // gateway block (including reload) must come from the generator.
      const configDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { reload: { mode: "off" }, auth: { token: "stale" } },
          plugins: { installs: { "custom-plugin": { origin: "npm" } } },
        }),
      );

      withConfigEnv({}, () => main());

      const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(written.gateway.reload).toEqual({ mode: "hybrid" });
      expect(written.plugins.installs["custom-plugin"]).toEqual({ origin: "npm" });
    },
  );

  it("preserves supported OpenClaw metadata and drops rejected legacy keys (#7744)", () => {
    const configDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        meta: {
          lastTouchedVersion: "2026.9.1",
          lastTouchedAt: "2026-08-11T22:45:04.591Z",
          unownedField: "must-not-cross-the-managed-boundary",
        },
      }),
    );
    fs.writeFileSync(
      `${configPath}.bak`,
      JSON.stringify({
        meta: {
          lastTouchedVersion: "backup-must-not-win",
          lastTouchedAt: "2026-08-10T00:00:00.000Z",
        },
      }),
    );

    withConfigEnv({}, () => main());

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.meta).toEqual({
      lastTouchedVersion: "2026.9.1",
    });
  });

  it("recovers only bounded metadata from the exact OpenClaw backup (#7744)", () => {
    const configDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ staleActiveField: "must-not-survive" }));
    fs.writeFileSync(
      `${configPath}.bak`,
      JSON.stringify({
        meta: {
          lastTouchedVersion: "2026.9.1",
          lastTouchedAt: "2026-08-11T22:45:04.591Z",
          unownedField: "must-not-cross-the-managed-boundary",
        },
        agents: { defaults: { model: { primary: "stale/backup-model" } } },
        models: { providers: { stale: { apiKey: "must-not-cross" } } },
        staleBackupField: "must-not-survive",
      }),
    );

    withConfigEnv({}, () => main());

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.meta).toEqual({
      lastTouchedVersion: "2026.9.1",
    });
    expect(written.agents.defaults.model.primary).toBe(BASE_ENV.NEMOCLAW_PRIMARY_MODEL_REF);
    expect(written.models.providers.stale).toBeUndefined();
    expect(written.staleActiveField).toBeUndefined();
    expect(written.staleBackupField).toBeUndefined();
  });

  it.each([
    ["missing-version", { lastTouchedAt: "2026-08-11T22:45:04.591Z" }],
    [
      "unbounded",
      { lastTouchedVersion: "v".repeat(257), lastTouchedAt: "2026-08-11T22:45:04.591Z" },
    ],
    [
      "control-character",
      { lastTouchedVersion: "2026.7.1\n", lastTouchedAt: "2026-08-11T22:45:04.591Z" },
    ],
  ])("does not retain %s OpenClaw backup metadata", (_label, meta) => {
    const configDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}");
    fs.writeFileSync(`${configPath}.bak`, JSON.stringify({ meta }));

    withConfigEnv({}, () => main());

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(written.meta).toBeUndefined();
  });
});
