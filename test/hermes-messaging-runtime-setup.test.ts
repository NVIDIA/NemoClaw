// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractShellFunction } from "./support/hermes-shell-harness";

const ROOT = path.join(import.meta.dirname, "..");
const HERMES_START = fs.readFileSync(path.join(ROOT, "agents", "hermes", "start.sh"), "utf-8");
const SANDBOX_INIT = fs.readFileSync(path.join(ROOT, "scripts", "lib", "sandbox-init.sh"), "utf-8");

function runtimeShellEnvFunction(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("\nwrite_runtime_shell_env\n", start);
  expect(start, "expected write_runtime_shell_env").toBeGreaterThanOrEqual(0);
  expect(end, "expected write_runtime_shell_env invocation").toBeGreaterThan(start);
  return source.slice(start, end);
}

function messagingRuntimeSetupSection(
  source: string,
  planPath: string,
  preloadPaths: { sourcePrefix: string; targetPrefix: string } = {
    sourcePrefix: "/usr/local/lib/nemoclaw/preloads/",
    targetPrefix: "/tmp/nemoclaw-",
  },
): string {
  const start = source.indexOf("# ── Messaging runtime setup from manifest metadata");
  const end = source.indexOf("# ── End messaging runtime setup", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const section = source
    .slice(start, end)
    .replace(
      '_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"',
      `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(planPath)}`,
    )
    .replace(
      'PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/"',
      `PRELOAD_SOURCE_PREFIX = ${JSON.stringify(preloadPaths.sourcePrefix)}`,
    )
    .replace(
      'PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-"',
      `PRELOAD_TARGET_PREFIX = ${JSON.stringify(preloadPaths.targetPrefix)}`,
    );
  if (preloadPaths.sourcePrefix === "/usr/local/lib/nemoclaw/preloads/") return section;
  return section
    .replaceAll("/usr/local/lib/nemoclaw/preloads/", preloadPaths.sourcePrefix)
    .replace("source_stat.st_uid != 0", "source_stat.st_uid != os.getuid()");
}

function encodeRuntimePlan(
  nodePreloads: Array<Record<string, unknown>>,
  commandRoutes: Array<Record<string, unknown>> = [],
): string {
  return Buffer.from(
    JSON.stringify({
      channels: [
        {
          channelId: "whatsapp",
          active: true,
          disabled: false,
        },
      ],
      disabledChannels: [],
      runtimeSetup: {
        nodePreloads: nodePreloads.map((entry) => ({ channelId: "whatsapp", ...entry })),
        commandRoutes: commandRoutes.map((entry) => ({ channelId: "whatsapp", ...entry })),
        envAliases: [],
        secretScans: [],
      },
    }),
  ).toString("base64");
}

describe("Hermes messaging runtime setup", () => {
  it("runs exact Hermes command routes from the generated connect environment (#8184)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-command-route-"));
    const envFile = path.join(tmpDir, "runtime-env.sh");
    const modulePath = path.join(tmpDir, "whatsapp-pair.js");
    const markerPath = path.join(tmpDir, "paired.txt");
    const fallbackPath = path.join(tmpDir, "fallback.txt");
    const binDir = path.join(tmpDir, "bin");
    const hermesPath = path.join(binDir, "hermes");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      modulePath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "paired");\n`,
    );
    fs.writeFileSync(
      hermesPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >${JSON.stringify(fallbackPath)}\n`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "set -euo pipefail",
            'emit_sandbox_sourced_file() { cat >"$1"; chmod 444 "$1"; }',
            `emit_messaging_connect_runtime_command_router() { printf '%s\n' '_nemoclaw_messaging_runtime_command_module() {' '  if [ "$#" -eq 2 ] && [ "$1" = hermes ] && [ "$2" = whatsapp ]; then' '    printf "%s\\n" ${JSON.stringify(modulePath)}' '  fi' '}'; }`,
            "emit_messaging_connect_runtime_preload_exports() { :; }",
            `_PROXY_ENV_FILE=${JSON.stringify(envFile)}`,
            '_PROXY_URL="http://10.200.0.1:3128"',
            '_NO_PROXY_VAL="localhost,127.0.0.1"',
            `HERMES_DIR=${JSON.stringify(tmpDir)}`,
            runtimeShellEnvFunction(HERMES_START).replace(
              "/usr/local/bin/node",
              JSON.stringify(process.execPath),
            ),
            "write_runtime_shell_env",
            `source ${JSON.stringify(envFile)}`,
            "hermes whatsapp",
            "hermes whatsapp --repair",
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(markerPath, "utf8")).toBe("paired");
      expect(fs.readFileSync(fallbackPath, "utf8")).toBe("whatsapp --repair\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("installs the active WhatsApp preload and rewrites the Hermes bridge session path (#8229)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-whatsapp-plan-"));
    const sourceDir = path.join(tmpDir, "preloads");
    const sourcePrefix = `${sourceDir}${path.sep}`;
    const sourcePath = path.join(sourceDir, "whatsapp-hermes-session.js");
    const targetPrefix = path.join(tmpDir, "nemoclaw-");
    const targetPath = `${targetPrefix}whatsapp-hermes-session.js`;
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const commandRouterPath = path.join(tmpDir, "command-router.sh");
    const resolvedCommandPath = path.join(tmpDir, "resolved-command.txt");
    const runtimeSourcePath = path.join(
      ROOT,
      "src",
      "lib",
      "messaging",
      "channels",
      "whatsapp",
      "runtime",
      "whatsapp-hermes-session.ts",
    );
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      sourcePath,
      ts.transpileModule(fs.readFileSync(runtimeSourcePath, "utf-8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: runtimeSourcePath,
      }).outputText,
    );

    try {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "set -euo pipefail",
            'emit_sandbox_sourced_file() { local target="$1"; cat >"$target"; chmod 444 "$target"; }',
            messagingRuntimeSetupSection(SANDBOX_INIT, planPath, {
              sourcePrefix,
              targetPrefix,
            }),
            "write_messaging_runtime_setup_plan",
            "install_messaging_runtime_preloads",
            `emit_messaging_connect_runtime_command_router >${JSON.stringify(commandRouterPath)}`,
            `source ${JSON.stringify(commandRouterPath)}`,
            `_nemoclaw_messaging_runtime_command_module hermes whatsapp >${JSON.stringify(resolvedCommandPath)}`,
            "node -e 'process.stdout.write(JSON.stringify(process.argv))' /sandbox/.hermes/scripts/whatsapp-bridge/bridge.js --session /tmp/split-session",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            ...process.env,
            NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: path.join(tmpDir, "missing.json"),
            NEMOCLAW_MESSAGING_PLAN_B64: encodeRuntimePlan(
              [
                {
                  source: sourcePath,
                  target: targetPath,
                  injectInto: ["boot", "connect"],
                  optional: false,
                },
              ],
              [
                {
                  command: "hermes",
                  args: ["whatsapp"],
                  module: "whatsapp-hermes-session",
                  source: sourcePath,
                },
              ],
            ),
            NODE_OPTIONS: "",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        process.execPath,
        "/sandbox/.hermes/scripts/whatsapp-bridge/bridge.js",
        "--session",
        "/sandbox/.hermes/platforms/whatsapp/session",
      ]);
      expect(fs.readFileSync(targetPath, "utf-8")).toBe(fs.readFileSync(sourcePath, "utf-8"));
      expect(fs.readFileSync(resolvedCommandPath, "utf8").trim()).toBe(sourcePath);
      expect(JSON.parse(fs.readFileSync(planPath, "utf8")).commandRoutes).toEqual([
        {
          command: "hermes",
          args: ["whatsapp"],
          module: "whatsapp-hermes-session",
          source: sourcePath,
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-shaped preload targets before any destination write (#8229)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-preload-traversal-"));
    const victimPath = path.join(tmpDir, "victim.js");
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const traversalTarget = `/tmp/nemoclaw-/../..${victimPath}`;
    fs.writeFileSync(victimPath, "preserve me\n");
    expect(path.resolve(traversalTarget)).toBe(path.resolve(victimPath));

    try {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "set -euo pipefail",
            'emit_sandbox_sourced_file() { local target="$1"; cat >"$target"; }',
            messagingRuntimeSetupSection(SANDBOX_INIT, planPath),
            "write_messaging_runtime_setup_plan",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            ...process.env,
            NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: path.join(tmpDir, "missing.json"),
            NEMOCLAW_MESSAGING_PLAN_B64: encodeRuntimePlan([
              {
                source: "/usr/local/lib/nemoclaw/preloads/whatsapp-hermes-session.js",
                target: traversalTarget,
                injectInto: ["boot", "connect"],
                optional: false,
              },
            ]),
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("nodePreloads[0].target must be a direct JavaScript file");
      expect(fs.readFileSync(victimPath, "utf-8")).toBe("preserve me\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
          'apply_messaging_runtime_env_aliases() { printf "alias\\n"; }',
          'install_messaging_runtime_preloads() { printf "install\\n"; }',
          'verify_messaging_runtime_secret_scans() { printf "scan\\n"; }',
          'write_runtime_shell_env() { printf "env\\n"; }',
          extractShellFunction(HERMES_START, "prepare_hermes_messaging_runtime"),
          "prepare_hermes_messaging_runtime",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("plan\nalias\ninstall\nscan\nenv\n");
  });

  it("publishes manifest connect preloads through the trusted runtime environment (#8184)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-connect-preload-"));
    const preloadPath = path.join(tmpDir, "manifest-connect.js");
    const preloadListPath = path.join(tmpDir, "connect-preloads");
    const runtimeEnvPath = path.join(tmpDir, "runtime-env.sh");
    fs.writeFileSync(preloadPath, "module.exports = {};\n");
    fs.writeFileSync(preloadListPath, `${preloadPath}\n`);

    try {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "set -euo pipefail",
            'emit_sandbox_sourced_file() { local target="$1"; cat >"$target"; chmod 444 "$target"; }',
            extractShellFunction(SANDBOX_INIT, "emit_messaging_connect_runtime_preload_exports"),
            `_MESSAGING_CONNECT_PRELOADS_FILE=${JSON.stringify(preloadListPath)}`,
            `_PROXY_ENV_FILE=${JSON.stringify(runtimeEnvPath)}`,
            '_PROXY_URL="http://10.200.0.1:3128"',
            '_NO_PROXY_VAL="localhost,127.0.0.1"',
            'HERMES_DIR="/sandbox/.hermes"',
            runtimeShellEnvFunction(HERMES_START),
            "write_runtime_shell_env",
            `source ${JSON.stringify(runtimeEnvPath)}`,
            'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
          ].join("\n"),
        ],
        { encoding: "utf-8", timeout: 5000, env: { ...process.env, NODE_OPTIONS: "" } },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`NODE_OPTIONS=--require ${preloadPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
        "apply_messaging_runtime_env_aliases",
        "write_runtime_shell_env",
        "prepare_tirith_marker_retry",
      ],
      expectedTail:
        "configure_messaging_channels\nplan\napply_messaging_runtime_env_aliases\ninstall\nscan\nwrite_runtime_shell_env\nprepare_tirith_marker_retry\n",
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
        "apply_messaging_runtime_env_aliases",
        "write_runtime_shell_env",
        "prepare_tirith_marker_retry",
      ],
      expectedTail:
        "configure_messaging_channels\nplan\napply_messaging_runtime_env_aliases\ninstall\nscan\nwrite_runtime_shell_env\nprepare_tirith_marker_retry\n",
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
          extractShellFunction(HERMES_START, "prepare_hermes_messaging_runtime"),
          extractShellFunction(HERMES_START, name),
          name,
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.endsWith(expectedTail)).toBe(true);
  });

  it.each([
    "prepare_hermes_nonroot_runtime",
    "prepare_hermes_root_runtime",
  ])("applies active Slack runtime aliases during %s (#8184)", (name) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-alias-"));
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const runtimePlan = JSON.stringify({
      envAliases: [
        {
          envKey: "SLACK_BOT_TOKEN",
          match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
          value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        },
      ],
    });
    const prerequisites = [
      "verify_config_integrity_if_locked",
      "validate_hermes_env_secret_boundary",
      "inspect_hermes_mcp_integrity",
      "ensure_hermes_runtime_api_server_key",
      "apply_shields_up_runtime_env",
      "validate_hermes_runtime_env_secret_boundary",
      "refresh_hermes_provider_placeholders",
      "refresh_hermes_runtime_config_hashes",
      "verify_hermes_config_integrity",
      "ensure_hermes_config_root_mode",
      "configure_messaging_channels",
      "install_messaging_runtime_preloads",
      "verify_messaging_runtime_secret_scans",
      "write_runtime_shell_env",
      "prepare_tirith_marker_retry",
    ];

    try {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "set -euo pipefail",
            `HERMES_DIR=${JSON.stringify(tmpDir)}`,
            `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(planPath)}`,
            ...prerequisites.map((stub) => `${stub}() { return 0; }`),
            `write_messaging_runtime_setup_plan() { printf '%s' ${JSON.stringify(runtimePlan)} >"$_MESSAGING_RUNTIME_SETUP_PLAN"; }`,
            extractShellFunction(SANDBOX_INIT, "apply_messaging_runtime_env_aliases"),
            extractShellFunction(HERMES_START, "prepare_hermes_messaging_runtime"),
            extractShellFunction(HERMES_START, name),
            name,
            'printf "%s\\n" "$SLACK_BOT_TOKEN"',
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, SLACK_BOT_TOKEN: "openshell:resolve:env:v42_SLACK_BOT_TOKEN" },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
