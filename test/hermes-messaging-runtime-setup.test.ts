// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(import.meta.dirname, "..");
const HERMES_START = fs.readFileSync(path.join(ROOT, "agents", "hermes", "start.sh"), "utf-8");

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start, `expected ${name}`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start);
  const end = remainder.indexOf("\n}");
  expect(end, `expected ${name} closing brace`).toBeGreaterThan(0);
  return remainder.slice(0, end + 2);
}

function runtimeShellEnvFunction(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("\nwrite_runtime_shell_env\n", start);
  expect(start, "expected write_runtime_shell_env").toBeGreaterThanOrEqual(0);
  expect(end, "expected write_runtime_shell_env invocation").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Hermes messaging runtime setup", () => {
  it("runs the manifest runtime setup in order (#8184)", () => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        [
          "set -euo pipefail",
          'write_messaging_runtime_setup_plan() { printf "plan\\n"; }',
          'install_messaging_runtime_preloads() { printf "install\\n"; }',
          'verify_messaging_runtime_secret_scans() { printf "scan\\n"; }',
          'write_runtime_shell_env() { printf "env\\n"; }',
          shellFunction(HERMES_START, "prepare_hermes_messaging_runtime"),
          "prepare_hermes_messaging_runtime",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("plan\ninstall\nscan\nenv\n");
  });

  it("publishes manifest connect preloads through the trusted runtime environment (#8184)", () => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        [
          "set -euo pipefail",
          "emit_sandbox_sourced_file() { cat; }",
          'emit_messaging_connect_runtime_preload_exports() { printf "export NODE_OPTIONS=manifest-connect\\n"; }',
          '_PROXY_ENV_FILE="/tmp/test-runtime-env"',
          '_PROXY_URL="http://10.200.0.1:3128"',
          '_NO_PROXY_VAL="localhost,127.0.0.1"',
          'HERMES_DIR="/sandbox/.hermes"',
          runtimeShellEnvFunction(HERMES_START),
          "write_runtime_shell_env",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("export NODE_OPTIONS=manifest-connect");
  });

  it.each([
    {
      name: "prepare_hermes_nonroot_runtime",
      stubs: [
        "verify_config_integrity_if_locked",
        "validate_hermes_env_secret_boundary",
        "inspect_hermes_mcp_integrity",
        "ensure_hermes_runtime_api_server_key",
        "apply_shields_up_runtime_env",
        "validate_hermes_runtime_env_secret_boundary",
        "refresh_hermes_provider_placeholders",
        "refresh_hermes_runtime_config_hashes",
        "configure_messaging_channels",
        "write_runtime_shell_env",
        "prepare_tirith_marker_retry",
      ],
      expectedTail:
        "configure_messaging_channels\nplan\ninstall\nscan\nwrite_runtime_shell_env\nprepare_tirith_marker_retry\n",
    },
    {
      name: "prepare_hermes_root_runtime",
      stubs: [
        "verify_hermes_config_integrity",
        "ensure_hermes_config_root_mode",
        "ensure_hermes_runtime_api_server_key",
        "apply_shields_up_runtime_env",
        "validate_hermes_env_secret_boundary",
        "validate_hermes_runtime_env_secret_boundary",
        "refresh_hermes_provider_placeholders",
        "configure_messaging_channels",
        "write_runtime_shell_env",
        "prepare_tirith_marker_retry",
      ],
      expectedTail:
        "configure_messaging_channels\nplan\ninstall\nscan\nwrite_runtime_shell_env\nprepare_tirith_marker_retry\n",
    },
  ])("installs manifest runtime setup during $name (#8184)", ({ name, stubs, expectedTail }) => {
    const stubFunctions = stubs.map((stub) => `${stub}() { printf '${stub}\\n'; }`).join("\n");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        [
          "set -euo pipefail",
          'HERMES_DIR="/sandbox/.hermes"',
          stubFunctions,
          'write_messaging_runtime_setup_plan() { printf "plan\\n"; }',
          'install_messaging_runtime_preloads() { printf "install\\n"; }',
          'verify_messaging_runtime_secret_scans() { printf "scan\\n"; }',
          shellFunction(HERMES_START, "prepare_hermes_messaging_runtime"),
          shellFunction(HERMES_START, name),
          name,
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.endsWith(expectedTail)).toBe(true);
  });
});
