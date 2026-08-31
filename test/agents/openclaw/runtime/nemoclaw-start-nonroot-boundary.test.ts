// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "nemoclaw-start.sh",
);

function nonRootFallbackBlock(src: string): string {
  const start = src.indexOf("# ── Non-root fallback");
  const end = src.indexOf("# ── Root path", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return `${extractShellFunctionFromSource(src, "_nemoclaw_capture_epoch_realtime")}\n${src.slice(start, end)}`;
}

function startScriptLine(src: string, needle: string): string {
  const start = src.indexOf(needle);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n", start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe("nemoclaw-start non-root boundary", () => {
  it("sends startup diagnostics to stderr so they do not leak into bridge output (#1064)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const token = "a".repeat(64);
    const script = [
      "set -euo pipefail",
      `_read_gateway_token() { printf "${token}\\n"; }`,
      'PUBLIC_PORT="19000"',
      `CHAT_UI_URL="https://remote.example.test/ui/#token=${token}"`,
      startScriptLine(src, "echo 'Setting up NemoClaw...'"),
      extractShellFunctionFromSource(src, "print_dashboard_urls"),
      "print_dashboard_urls",
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Setting up NemoClaw");
    expect(result.stderr).toContain("[gateway] Local UI: http://127.0.0.1:19000/");
    expect(result.stderr).toContain("[gateway] Remote UI: https://remote.example.test/ui/");
    expect(result.stderr).toContain("Dashboard auth token redacted from startup logs.");
    expect(result.stderr).not.toContain("#token=");
    expect(result.stderr).not.toContain(token);
  });

  it("runs runtime preloads and scans before explicit non-root commands", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      "recover_openclaw_config_if_empty() { :; }",
      "normalize_mutable_config_perms() { :; }",
      "apply_model_override() { :; }",
      "reconcile_agent_model_with_provider() { :; }",
      "apply_cors_override() { :; }",
      "refresh_openclaw_provider_placeholders() { :; }",
      "ensure_mutable_openclaw_config_hash() { :; }",
      extractShellFunctionFromSource(src, "needs_gateway_token_for_current_command"),
      extractShellFunctionFromSource(src, "prepare_gateway_token_for_current_command"),
      'ensure_gateway_token() { echo "SHOULD_NOT_ENSURE"; exit 75; }',
      'ensure_gateway_token_if_missing() { echo "SHOULD_NOT_ENSURE"; exit 76; }',
      "write_openclaw_config_baseline() { :; }",
      "export_gateway_token() { :; }",
      "write_messaging_runtime_setup_plan() { :; }",
      "write_runtime_shell_env() { :; }",
      "ensure_runtime_shell_env_shim() { :; }",
      "lock_rc_files() { :; }",
      "apply_messaging_runtime_env_aliases() { :; }",
      'configure_messaging_channels() { echo "SHOULD_NOT_CONFIGURE"; exit 70; }',
      'install_messaging_runtime_preloads() { echo "ORDER:install"; }',
      'verify_messaging_runtime_secret_scans() { echo "ORDER:verify"; }',
      "seed_default_workspace_templates() { :; }",
      extractShellFunctionFromSource(src, "run_oneshot_command"),
      "_SANDBOX_HOME=/sandbox",
      "NEMOCLAW_CMD=(bash -c 'echo EXPLICIT_COMMAND; exit 23')",
      nonRootFallbackBlock(src),
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(23);
    expect(result.stdout).toContain("EXPLICIT_COMMAND");
    expect(result.stdout).toMatch(/ORDER:install[\s\S]*ORDER:verify[\s\S]*EXPLICIT_COMMAND/);
    expect(result.stdout).not.toContain("SHOULD_NOT_CONFIGURE");
  });
});
