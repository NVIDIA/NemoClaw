// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const JSON5_MODULE = path.resolve(import.meta.dirname, "../../../../nemoclaw/node_modules/json5");
const restoredConfig = {
  gateway: { port: 18789, auth: { token: "restored-valid-token" } },
  meta: { lastTouchedAt: "2026-09-01T00:00:00Z", lastTouchedVersion: "2026.9.1" },
  plugins: {
    allow: ["nemoclaw", "memory-core"],
    entries: {
      nemoclaw: { enabled: true, config: { sandboxName: "restored-search-off" } },
      "memory-core": { enabled: true, hooks: { allowConversationAccess: false } },
    },
  },
  tools: { web: { search: { enabled: false } } },
};

function startupFixture(
  mode: "root" | "non-root" | "one-shot",
  config: Record<string, unknown> = restoredConfig,
) {
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restored-hooks-"));
  onTestFinished(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const configPath = path.join(temporary, "openclaw.json");
  const restoredPath = path.join(temporary, "restored.json");
  const envPath = path.join(temporary, "runtime.env");
  const scriptPath = path.join(temporary, "startup.sh");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.copyFileSync(configPath, restoredPath);
  const adapt = (name: string) =>
    extractShellFunctionFromSource(source, name)
      .replaceAll("/sandbox/.openclaw/openclaw.json", configPath)
      .replaceAll("/tmp/nemoclaw-proxy-env.sh", envPath)
      .replaceAll("/usr/local/lib/node_modules/openclaw/node_modules/json5", JSON5_MODULE)
      .replaceAll("/usr/local/bin/node", process.execPath);
  const doctorStart =
    mode === "root"
      ? source.lastIndexOf("run_requested_openclaw_post_upgrade_doctor || exit 1")
      : source.indexOf("  run_requested_openclaw_post_upgrade_doctor || exit 1");
  const doctorEnd = source.indexOf(
    mode === "root"
      ? "# Apply manifest-declared runtime env aliases"
      : "  install_messaging_runtime_preloads",
    doctorStart,
  );
  const phase =
    mode === "one-shot"
      ? "prepare_gateway_token_for_current_command\nexport_gateway_token\nwrite_runtime_shell_env"
      : source.slice(doctorStart, doctorEnd);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `id() { if [ "\${1:-}" = "-u" ]; then printf "${mode === "root" ? "0" : "1000"}"; else command id "$@"; fi; }`,
      mode === "one-shot" ? "NEMOCLAW_CMD=(openclaw agent)" : "NEMOCLAW_CMD=()",
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      "_DASHBOARD_PORT=18791",
      '_PROXY_URL=""',
      '_NO_PROXY_VAL=""',
      '_SANDBOX_SAFETY_NET=""',
      '_PROXY_FIX_SCRIPT=""',
      '_NEMOTRON_FIX_SCRIPT=""',
      'NODE_USE_ENV_PROXY=""',
      "_TOOL_REDIRECTS=()",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      "emit_messaging_connect_runtime_preload_exports() { :; }",
      'run_requested_openclaw_post_upgrade_doctor() { cp "$NEMOCLAW_TEST_RESTORED_CONFIG" "$NEMOCLAW_TEST_CONFIG"; }',
      "refresh_openclaw_provider_placeholders() { :; }",
      "write_messaging_runtime_setup_plan() { :; }",
      "_nemoclaw_capture_epoch_realtime() { :; }",
      adapt("run_openclaw_config_as_owner"),
      adapt("_read_gateway_token"),
      adapt("ensure_gateway_token"),
      adapt("ensure_gateway_token_if_missing"),
      adapt("needs_gateway_token_for_current_command"),
      adapt("prepare_gateway_token_for_current_command"),
      adapt("export_gateway_token"),
      adapt("write_runtime_shell_env"),
      'if [ "${NEMOCLAW_TEST_CONFIG_ONLY:-0}" = "1" ]; then NEMOCLAW_CMD=(openclaw agent); prepare_gateway_token_for_current_command; exit $?; fi',
      phase,
      '"$NEMOCLAW_TEST_NODE" -e \'const fs = require("node:fs"); const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (config.plugins?.entries?.nemoclaw?.hooks?.allowConversationAccess !== true) process.exit(71);\' "$NEMOCLAW_TEST_CONFIG"',
      'printf "GATEWAY_CONFIG_READY\\n"',
    ].join("\n"),
  );
  return {
    configPath,
    envPath,
    readConfig: () =>
      JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        gateway: { port: number; auth: { token: string } };
        meta: unknown;
        plugins: unknown;
        tools: unknown;
      },
    run: (configOnly = false) =>
      spawnSync("bash", [scriptPath], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          NEMOCLAW_TEST_CONFIG: configPath,
          NEMOCLAW_TEST_RESTORED_CONFIG: restoredPath,
          NEMOCLAW_TEST_NODE: process.execPath,
          NEMOCLAW_TEST_CONFIG_ONLY: String(Number(configOnly)),
        },
      }),
  };
}

it.each(["root", "non-root", "one-shot"] as const)(
  "grants NemoClaw conversation access before gateway use after %s restoration",
  (mode) => {
    const fixture = startupFixture(mode);
    const result = fixture.run();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("GATEWAY_CONFIG_READY");
    const actual = fixture.readConfig();
    expect(actual.plugins).toEqual({
      ...restoredConfig.plugins,
      entries: {
        ...restoredConfig.plugins.entries,
        nemoclaw: {
          ...restoredConfig.plugins.entries.nemoclaw,
          hooks: { allowConversationAccess: true },
        },
      },
    });
    expect(actual.tools).toEqual(restoredConfig.tools);
    expect(actual.gateway.port).toBe(mode === "one-shot" ? 18789 : 18791);
    expect(actual.meta).toEqual(
      mode === "one-shot"
        ? restoredConfig.meta
        : { lastTouchedVersion: restoredConfig.meta.lastTouchedVersion },
    );
    expect(actual.gateway.auth.token).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    expect(actual.gateway.auth.token === "restored-valid-token").toBe(mode === "one-shot");
    expect(fs.readFileSync(fixture.envPath, "utf8")).toContain(
      `OPENCLAW_GATEWAY_TOKEN='${actual.gateway.auth.token}'`,
    );
    const first = fs.readFileSync(fixture.configPath, "utf8");
    fs.chmodSync(fixture.configPath, 0o444);
    const repeated = fixture.run(true);
    expect(repeated.status, repeated.stderr || repeated.stdout).toBe(0);
    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(first);
    expect(fs.statSync(fixture.configPath).mode & 0o777).toBe(0o444);
  },
);

it("restores required hook access without enabling a disabled NemoClaw plugin", () => {
  const fixture = startupFixture("one-shot", {
    ...restoredConfig,
    plugins: {
      ...restoredConfig.plugins,
      entries: {
        ...restoredConfig.plugins.entries,
        nemoclaw: { ...restoredConfig.plugins.entries.nemoclaw, enabled: false },
      },
    },
  });
  const result = fixture.run();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(fixture.readConfig().plugins).toEqual({
    ...restoredConfig.plugins,
    entries: {
      ...restoredConfig.plugins.entries,
      nemoclaw: {
        ...restoredConfig.plugins.entries.nemoclaw,
        enabled: false,
        hooks: { allowConversationAccess: true },
      },
    },
  });
});

it.each([
  { plugins: [] },
  { plugins: { entries: null } },
  { plugins: { entries: { nemoclaw: "invalid" } } },
  { plugins: { entries: { nemoclaw: { hooks: false } } } },
])("refuses malformed plugin configuration without replacing native settings: %j", (plugins) => {
  const original = { ...restoredConfig, ...plugins };
  const fixture = startupFixture("one-shot", original);
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("configuration must be an object");
  expect(fixture.readConfig()).toEqual(original);
});
