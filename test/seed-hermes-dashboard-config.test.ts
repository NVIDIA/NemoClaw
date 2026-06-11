// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for agents/hermes/seed-dashboard-config.py.
// Runs the actual Python script against temp config files and asserts on the
// on-disk YAML it leaves behind. Mirrors the spawn-and-read pattern from
// seed-wechat-accounts.test.ts and generate-hermes-config.test.ts.
//
// The Hermes dashboard runs under its own HERMES_HOME, so it never sees the
// model/custom_providers block NemoClaw writes to the gateway config. This
// script mirrors those routing keys into the dashboard config so the Models
// page and kanban specifier/dispatcher resolve the routed model.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "seed-dashboard-config.py",
);

// PyYAML ships in the Hermes venv at runtime; CI/dev hosts generally have it too.
// Skip gracefully (rather than fail spuriously) where python3 or PyYAML is absent.
const PY_YAML_AVAILABLE =
  spawnSync("python3", ["-c", "import yaml"], { stdio: "ignore" }).status === 0;

const GATEWAY_CONFIG = {
  _config_version: 12,
  _nemoclaw_upstream: { provider: "nvidia-router", model: "nvidia-routed" },
  model: {
    default: "nvidia-routed",
    provider: "nvidia-router",
    base_url: "https://inference.local/v1",
    api_key: "sk-OPENSHELL-PROXY-REWRITE",
  },
  providers: {
    "nvidia-router": {
      name: "nvidia-router",
      api: "https://inference.local/v1",
      api_key: "sk-OPENSHELL-PROXY-REWRITE",
      default_model: "nvidia-routed",
      discover_models: true,
    },
  },
  custom_providers: [
    {
      name: "nvidia-router",
      base_url: "https://inference.local/v1",
      api_key: "sk-OPENSHELL-PROXY-REWRITE",
      discover_models: true,
    },
  ],
  // Intentionally present to assert it is NOT mirrored (would collide with the
  // gateway's api_server bind).
  platforms: { api_server: { enabled: true, extra: { port: 18642 } } },
};

let tmpDir: string;

function runSeed(srcPath: string, dstPath: string, envSrcPath?: string, envDstPath?: string) {
  const args = [SCRIPT_PATH, srcPath, dstPath];
  if (envSrcPath && envDstPath) args.push(envSrcPath, envDstPath);
  return spawnSync("python3", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
}

function writeYaml(name: string, value: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, YAML.stringify(value));
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(p, "utf-8"));
}

describe.skipIf(!PY_YAML_AVAILABLE)("seed-dashboard-config.py", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-dash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new dashboard config with the gateway's routing keys", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);

    const dash = readYaml(dst);
    expect(dash.model).toEqual(GATEWAY_CONFIG.model);
    expect(dash.providers).toEqual(GATEWAY_CONFIG.providers);
    expect(dash.custom_providers).toEqual(GATEWAY_CONFIG.custom_providers);
    expect(dash._nemoclaw_upstream).toEqual(GATEWAY_CONFIG._nemoclaw_upstream);
  });

  it("synthesizes Hermes v16 providers from legacy gateway routing", () => {
    const legacy = {
      _config_version: 12,
      _nemoclaw_upstream: { provider: "NVIDIA Router", model: "nvidia-routed" },
      model: {
        default: "nvidia-routed",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: "sk-OPENSHELL-PROXY-REWRITE",
      },
      custom_providers: [
        {
          name: "NVIDIA Router",
          base_url: "https://inference.local/v1",
          api_key: "sk-OPENSHELL-PROXY-REWRITE",
          discover_models: true,
        },
      ],
    };
    const src = writeYaml("gw.yaml", legacy);
    const dst = path.join(tmpDir, "dash.yaml");

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);

    const dash = readYaml(dst);
    expect(dash.model).toEqual({
      default: "nvidia-routed",
      provider: "nvidia-router",
      base_url: "https://inference.local/v1",
      api_key: "sk-OPENSHELL-PROXY-REWRITE",
    });
    expect(dash.providers).toEqual({
      "nvidia-router": {
        name: "NVIDIA Router",
        api: "https://inference.local/v1",
        api_key: "sk-OPENSHELL-PROXY-REWRITE",
        default_model: "nvidia-routed",
        discover_models: true,
      },
    });
  });

  it("mirrors the gateway .env into the dashboard home for Hermes 0.16 chat setup", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(
      envSrc,
      [
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=18642",
        "API_SERVER_KEY=server-key",
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "TERMINAL_CWD=/sandbox",
        "",
      ].join("\n"),
    );

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(0);

    expect(fs.readFileSync(envDst, "utf-8")).toBe(
      [
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=18642",
        "API_SERVER_KEY=server-key",
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "",
      ].join("\n"),
    );
    expect(fs.statSync(envDst).mode & 0o777).toBe(0o600);
  });

  it("keeps custom_providers dynamic via discover_models (no static model list)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);

    const dash = readYaml(dst) as { custom_providers: Array<Record<string, unknown>> };
    expect(dash.custom_providers[0].discover_models).toBe(true);
    // No hard-coded models: list — the dashboard live-lists /v1/models.
    expect(dash.custom_providers[0]).not.toHaveProperty("models");
  });

  it("does NOT mirror platforms/plugins (avoids the gateway port conflict)", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);

    expect(readYaml(dst)).not.toHaveProperty("platforms");
  });

  it("merges into an existing config: overwrites the empty model, preserves local keys", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    // Mirrors what `hermes dashboard` writes on first launch: empty model,
    // empty providers, plus a higher config version and a dashboard-local pref.
    const dst = writeYaml("dash.yaml", {
      _config_version: 27,
      model: "",
      providers: {},
      display: { compact: true },
    });

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);

    const dash = readYaml(dst);
    // Routing overwritten...
    expect(dash.model).toEqual(GATEWAY_CONFIG.model);
    expect(dash.providers).toEqual(GATEWAY_CONFIG.providers);
    expect(dash.custom_providers).toEqual(GATEWAY_CONFIG.custom_providers);
    // ...dashboard-local keys preserved.
    expect(dash._config_version).toBe(27);
    expect(dash.display).toEqual({ compact: true });
  });

  it("is idempotent across repeated launches", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");

    runSeed(src, dst);
    const first = fs.readFileSync(dst, "utf-8");
    runSeed(src, dst);
    const second = fs.readFileSync(dst, "utf-8");

    expect(second).toBe(first);
  });

  it("is a benign no-op when the gateway config is missing", () => {
    const dst = path.join(tmpDir, "dash.yaml");
    const res = runSeed(path.join(tmpDir, "absent.yaml"), dst);

    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("still mirrors .env when the gateway config is missing", () => {
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, "API_SERVER_KEY=server-key\n");

    const res = runSeed(path.join(tmpDir, "absent.yaml"), dst, envSrc, envDst);

    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readFileSync(envDst, "utf-8")).toBe("API_SERVER_KEY=server-key\n");
  });

  it("skips seeding when the gateway config has no model routing", () => {
    const src = writeYaml("gw.yaml", { _config_version: 12, terminal: { backend: "local" } });
    const dst = path.join(tmpDir, "dash.yaml");

    const res = runSeed(src, dst);
    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("refuses to follow a symlink at the dashboard config path", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const realTarget = writeYaml("real-target.yaml", { secret: "do-not-touch" });
    const dst = path.join(tmpDir, "dash.yaml");
    fs.symlinkSync(realTarget, dst);

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    // The symlink target must be untouched.
    expect(readYaml(realTarget)).toEqual({ secret: "do-not-touch" });
  });

  it("refuses to follow a symlink at the dashboard env path", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const realTarget = path.join(tmpDir, "real-target.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, "API_SERVER_KEY=server-key\n");
    fs.writeFileSync(realTarget, "SECRET=do-not-touch\n");
    fs.symlinkSync(realTarget, envDst);

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("SECRET=do-not-touch\n");
  });
});
