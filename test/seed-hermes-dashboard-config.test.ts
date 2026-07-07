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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

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
const GENERATED_HEX_TOKEN = Array.from({ length: 64 }, (_value, index) =>
  (index % 16).toString(16),
).join("");
const TAVILY_API_KEY_PLACEHOLDER = "openshell:resolve:env:TAVILY_API_KEY";

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

function runSeed(
  srcPath: string,
  dstPath: string,
  envSrcPath?: string,
  envDstPath?: string,
  env: Record<string, string | undefined> = {},
) {
  const envArgs = envSrcPath && envDstPath ? [envSrcPath, envDstPath] : [];
  const args = [SCRIPT_PATH, srcPath, dstPath, ...envArgs];
  return spawnSync("python3", args, {
    encoding: "utf-8",
    env: { ...process.env, ...env },
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
  const parsed = YAML.parse(fs.readFileSync(p, "utf-8"));
  expect(parsed, `${p} should contain a YAML object`).toBeTruthy();
  expect(typeof parsed, `${p} should contain a YAML object`).toBe("object");
  expect(Array.isArray(parsed), `${p} should contain a YAML object`).toBe(false);
  return parsed as Record<string, unknown>;
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

  it("mirrors only the exact native Tavily backend into dashboard config", () => {
    const src = writeYaml("gw.yaml", {
      ...GATEWAY_CONFIG,
      web: { backend: "tavily", use_gateway: true, api_key: "do-not-copy" },
    });
    const dst = writeYaml("dash.yaml", { web: { max_results: 3 } });

    const res = runSeed(src, dst);

    expect(res.status).toBe(0);
    expect(readYaml(dst).web).toEqual({ max_results: 3, backend: "tavily" });
  });

  it("removes the managed Tavily backend after the gateway disables it", () => {
    const enabledSrc = writeYaml("gw-enabled.yaml", {
      ...GATEWAY_CONFIG,
      web: { backend: "tavily" },
    });
    const disabledSrc = writeYaml("gw-disabled.yaml", GATEWAY_CONFIG);
    const dst = writeYaml("dash.yaml", { web: { max_results: 3 } });

    expect(runSeed(enabledSrc, dst).status).toBe(0);
    expect(readYaml(dst).web).toEqual({ max_results: 3, backend: "tavily" });
    expect(runSeed(disabledSrc, dst).status).toBe(0);
    expect(readYaml(dst).web).toEqual({ max_results: 3 });
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

  it("mirrors only dashboard-needed gateway .env keys for Hermes 0.16 chat setup", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(
      envSrc,
      [
        "API_SERVER_HOST=127.0.0.1",
        "API_SERVER_PORT=18642",
        `API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        `TAVILY_API_KEY=${TAVILY_API_KEY_PLACEHOLDER}`,
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
        "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
        "OPENAI_API_KEY=do-not-copy",
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
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
        `API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        `TAVILY_API_KEY=${TAVILY_API_KEY_PLACEHOLDER}`,
        "FIRECRAWL_GATEWAY_URL=http://host.openshell.internal:11436/firecrawl",
        "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1",
        "MODAL_GATEWAY_URL=http://host.openshell.internal:11436/modal",
        "",
      ].join("\n"),
    );
    expect(fs.statSync(envDst).mode & 0o777).toBe(0o600);
  });

  it("mirrors export-prefixed API_SERVER_KEY into the dashboard .env", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(
      envSrc,
      [
        `export API_SERVER_KEY=${GENERATED_HEX_TOKEN}`,
        "export OPENAI_API_KEY=do-not-copy",
        "API_SERVER_HOST=127.0.0.1",
        "",
      ].join("\n"),
    );

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(0);

    expect(fs.readFileSync(envDst, "utf-8")).toBe(
      [`export API_SERVER_KEY=${GENERATED_HEX_TOKEN}`, "API_SERVER_HOST=127.0.0.1", ""].join("\n"),
    );
  });

  it("rejects weak API_SERVER_KEY values instead of mirroring them into the dashboard .env", () => {
    const weakLines = [
      "API_SERVER_KEY=server-key",
      "API_SERVER_KEY='server-key'",
      'export API_SERVER_KEY="server-key"',
    ];

    for (const [index, weakLine] of weakLines.entries()) {
      const src = writeYaml(`gw-${index}.yaml`, GATEWAY_CONFIG);
      const dst = path.join(tmpDir, `dash-${index}.yaml`);
      const envSrc = path.join(tmpDir, `gw-${index}.env`);
      const envDst = path.join(tmpDir, `dash-${index}.env`);
      fs.writeFileSync(envSrc, `${weakLine}\nAPI_SERVER_HOST=127.0.0.1\n`);

      const res = runSeed(src, dst, envSrc, envDst);

      expect(res.status, weakLine).toBe(1);
      expect(res.stderr, weakLine).toContain("API_SERVER_KEY");
      expect(res.stderr, weakLine).not.toContain("server-key");
      expect(fs.existsSync(envDst), weakLine).toBe(false);
    }
  });

  it("rejects a literal Tavily key instead of mirroring it into the dashboard .env", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, "TAVILY_API_KEY=tvly-test-literal\nAPI_SERVER_HOST=127.0.0.1\n");

    const res = runSeed(src, dst, envSrc, envDst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("TAVILY_API_KEY");
    expect(res.stderr).not.toContain("tvly-test-literal");
    expect(fs.existsSync(envDst)).toBe(false);
  });

  it("applies requested dashboard seed owner and mode before the atomic rename", () => {
    const uid = process.getuid?.() ?? Number.NaN;
    const gid = process.getgid?.() ?? Number.NaN;
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);

    const res = runSeed(src, dst, envSrc, envDst, {
      NEMOCLAW_DASHBOARD_SEED_OWNER: `${uid}:${gid}`,
    });

    expect(res.status).toBe(0);
    expect(Number.isInteger(uid)).toBe(true);
    expect(Number.isInteger(gid)).toBe(true);
    for (const seededPath of [dst, envDst]) {
      const stat = fs.statSync(seededPath);
      expect(stat.uid).toBe(uid);
      expect(stat.gid).toBe(gid);
      expect(stat.mode & 0o777).toBe(0o600);
    }
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
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);

    const res = runSeed(path.join(tmpDir, "absent.yaml"), dst, envSrc, envDst);

    expect(res.status).toBe(0);
    expect(fs.existsSync(dst)).toBe(false);
    expect(fs.readFileSync(envDst, "utf-8")).toBe(`API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
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

  it("refuses to read a symlinked gateway config source", () => {
    const realTarget = writeYaml("real-target.yaml", {
      model: {
        default: "secret-model",
        provider: "secret-provider",
        base_url: "https://secret.invalid/v1",
      },
    });
    const src = path.join(tmpDir, "gw.yaml");
    const dst = path.join(tmpDir, "dash.yaml");
    fs.symlinkSync(realTarget, src);

    const res = runSeed(src, dst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(dst)).toBe(false);
  });

  it("refuses a pre-existing temp symlink when writing the dashboard config", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const realTarget = writeYaml("real-target.yaml", { secret: "do-not-touch" });
    fs.symlinkSync(realTarget, `${dst}.nemoclaw.tmp`);

    const res = runSeed(src, dst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(dst)).toBe(false);
    expect(readYaml(realTarget)).toEqual({ secret: "do-not-touch" });
  });

  it("refuses to follow a symlink at the dashboard env path", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const realTarget = path.join(tmpDir, "real-target.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
    fs.writeFileSync(realTarget, "SECRET=do-not-touch\n");
    fs.symlinkSync(realTarget, envDst);

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("SECRET=do-not-touch\n");
  });

  it("refuses to read a symlinked gateway env source", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const realTarget = path.join(tmpDir, "real-target.env");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    fs.writeFileSync(realTarget, "API_SERVER_KEY=do-not-copy\n");
    fs.symlinkSync(realTarget, envSrc);

    const res = runSeed(src, dst, envSrc, envDst);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.existsSync(envDst)).toBe(false);
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("API_SERVER_KEY=do-not-copy\n");
  });

  it("refuses a pre-existing temp symlink when writing the dashboard env", () => {
    const src = writeYaml("gw.yaml", GATEWAY_CONFIG);
    const dst = path.join(tmpDir, "dash.yaml");
    const envSrc = path.join(tmpDir, "gw.env");
    const envDst = path.join(tmpDir, "dash.env");
    const realTarget = path.join(tmpDir, "real-target.env");
    fs.writeFileSync(envSrc, `API_SERVER_KEY=${GENERATED_HEX_TOKEN}\n`);
    fs.writeFileSync(realTarget, "SECRET=do-not-touch\n");
    fs.symlinkSync(realTarget, `${envDst}.nemoclaw.tmp`);

    const res = runSeed(src, dst, envSrc, envDst);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("[SECURITY]");
    expect(fs.readFileSync(realTarget, "utf-8")).toBe("SECRET=do-not-touch\n");
  });
});
