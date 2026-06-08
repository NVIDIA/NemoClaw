// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bashPrintfQ(value: string): string {
  const result = spawnSync("bash", ["-c", "printf '%q' \"$1\"", "bash-printf-q", value], {
    encoding: "utf-8",
    timeout: 5000,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`bash printf %q failed: ${result.stderr}`);
  }
  return result.stdout;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = escapeRegExp(name);
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in agents/hermes/start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function extractRuntimeShellEnvBlock(src: string): string {
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("\nwrite_runtime_shell_env\n", start);
  if (start < 0 || end < 0) {
    throw new Error("Expected write_runtime_shell_env block in agents/hermes/start.sh");
  }
  return src.slice(start, end).trimEnd();
}

function extractDashboardPortBootstrap(src: string): string {
  const start = src.indexOf('NEMOCLAW_CMD=("$@")');
  const end = src.indexOf('\nHERMES="$(command -v hermes)"', start);
  if (start < 0 || end < 0) {
    throw new Error("Expected Hermes dashboard port bootstrap block in agents/hermes/start.sh");
  }
  return src.slice(start, end).trimEnd();
}

function runHermesDashboardPortBootstrap(env: Record<string, string | undefined> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-bootstrap-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "set --",
      extractDashboardPortBootstrap(src),
      'printf "CHAT_UI_URL=%s\\n" "${CHAT_UI_URL:-}"',
      'printf "DASHBOARD_PUBLIC_PORT=%s\\n" "$DASHBOARD_PUBLIC_PORT"',
      'printf "DASHBOARD_INTERNAL_PORT=%s\\n" "$DASHBOARD_INTERNAL_PORT"',
      'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const childEnv = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete childEnv[key];
      } else {
        childEnv[key] = value;
      }
    }
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: childEnv,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesDashboardArgs(tuiValue?: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-args-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "truthy_env"),
      extractShellFunctionFromSource(src, "hermes_dashboard_tui_enabled"),
      extractShellFunctionFromSource(src, "build_hermes_dashboard_args"),
      "DASHBOARD_INTERNAL_PORT=19119",
      tuiValue === undefined
        ? 'HERMES_DASHBOARD_TUI="${HERMES_DASHBOARD_TUI:-0}"'
        : `HERMES_DASHBOARD_TUI=${shellQuote(tuiValue)}`,
      "build_hermes_dashboard_args",
      'printf "%s\\n" "${HERMES_DASHBOARD_ARGS[@]}"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesPortValidation(opts: {
  publicPort?: number;
  internalPort?: number;
  dashboardPublicPort?: number;
  dashboardInternalPort?: number;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-port-validation-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "validate_tcp_port"),
      extractShellFunctionFromSource(src, "validate_port_configuration"),
      `PUBLIC_PORT=${opts.publicPort ?? 8642}`,
      `INTERNAL_PORT=${opts.internalPort ?? 18642}`,
      `DASHBOARD_PUBLIC_PORT=${opts.dashboardPublicPort ?? 18789}`,
      `DASHBOARD_INTERNAL_PORT=${opts.dashboardInternalPort ?? 19119}`,
      "validate_port_configuration",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesEnvSecretBoundary(opts: {
  envFile?: string;
  symlinkEnvFile?: boolean;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-boundary-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const envFile = path.join(hermesHome, ".env");
  const target = path.join(tmpDir, "env-target");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  if (opts.symlinkEnvFile) {
    fs.writeFileSync(target, opts.envFile ?? "DEVTEST_API_TOKEN=secret\n");
    fs.symlinkSync(target, envFile);
  } else if (opts.envFile !== undefined) {
    fs.writeFileSync(envFile, opts.envFile);
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "validate_hermes_env_secret_boundary"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      "validate_hermes_env_secret_boundary",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runHermesRuntimeEnvSecretBoundary(envOverrides: Record<string, string>) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-boundary-"));
  const scriptPath = path.join(tmpDir, "run.sh");
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "validate_hermes_runtime_env_secret_boundary"),
      "validate_hermes_runtime_env_secret_boundary",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        HOME: tmpDir,
        PATH: process.env.PATH ?? "",
        ...envOverrides,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runTirithMarkerBootstrap(opts: {
  markerReason?: string;
  symlinkMarker?: boolean;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const marker = path.join(hermesHome, ".tirith-install-failed");
  const target = path.join(tmpDir, "marker-target");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  if (opts.symlinkMarker) {
    fs.writeFileSync(target, opts.markerReason ?? "download_failed");
    fs.symlinkSync(target, marker);
  } else if (opts.markerReason !== undefined) {
    fs.writeFileSync(marker, opts.markerReason);
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "retry_tirith_marker_if_needed"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      "retry_tirith_marker_if_needed",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      markerExists: fs.existsSync(marker),
      markerIsSymlink: fs.existsSync(marker) && fs.lstatSync(marker).isSymbolicLink(),
      markerContent: fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8") : "",
      targetContent: fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractTirithDispatchBlock(src: string, mode: "non-root" | "root"): string {
  const nonRootStart = src.indexOf("# ── Non-root fallback");
  const rootStart = src.indexOf("# ── Root path");
  if (nonRootStart < 0 || rootStart < 0 || rootStart <= nonRootStart) {
    throw new Error("Expected root and non-root dispatch blocks in agents/hermes/start.sh");
  }
  return mode === "non-root" ? src.slice(nonRootStart, rootStart) : src.slice(rootStart);
}

function runTirithExplicitCommandDispatch(mode: "non-root" | "root") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tirith-dispatch-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const marker = path.join(hermesHome, ".tirith-install-failed");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(marker, "download_failed");

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "retry_tirith_marker_if_needed"),
      mode === "root"
        ? 'id() { if [ "${1:-}" = "-u" ]; then printf "0\\n"; else command id "$@"; fi; }'
        : 'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
      "verify_config_integrity_if_locked() { :; }",
      "verify_config_integrity() { :; }",
      "apply_shields_up_runtime_env() { :; }",
      "validate_hermes_env_secret_boundary() { :; }",
      "validate_hermes_runtime_env_secret_boundary() { :; }",
      "refresh_hermes_provider_placeholders() { :; }",
      "configure_messaging_channels() { :; }",
      'cleanup_stale_hermes_gateway_runtime() { echo "unexpected gateway cleanup" >&2; return 99; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `HERMES_HASH_FILE=${shellQuote(path.join(tmpDir, "hermes.config-hash"))}`,
      "STEP_DOWN_PREFIX_SANDBOX=(env)",
      "NEMOCLAW_CMD=(bash -c 'test ! -e \"$1/.tirith-install-failed\"' bash \"$HERMES_DIR\")",
      extractTirithDispatchBlock(src, mode),
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    return {
      result,
      markerExists: fs.existsSync(marker),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const LOCKED_HERMES_CONFIG_STAT_MOCK = [
  "stat() {",
  '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
  '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
  '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
  '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
  '  case "${3:-}" in "$HERMES_DIR/config.yaml"|"$HERMES_DIR/.env")',
  '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ]; then printf "root:root\\n"; return 0; fi',
  '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ]; then printf "444\\n"; return 0; fi',
  '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ]; then printf "root:root\\n"; return 0; fi',
  '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ]; then printf "444\\n"; return 0; fi',
  "    ;;",
  "  esac",
  '  command stat "$@"',
  "}",
].join("\n");

function writeFakeProcCmdline(procRoot: string, pid: number, argv: string[]) {
  const pidDir = path.join(procRoot, String(pid));
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(path.join(pidDir, "cmdline"), Buffer.from(`${argv.join("\0")}\0`));
}

function lstatIfPresent(entry: string): fs.Stats | null {
  try {
    return fs.lstatSync(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function runHermesGatewayRuntimeCleanup(opts: {
  liveGateway?: boolean;
  orphanSocat?: boolean;
  orphanDashboardSocat?: boolean;
  staleLock?: boolean;
  stalePid?: boolean;
  lockedConfigRoot?: boolean;
  rootOwnedConfigRoot?: boolean;
  preExistingHistory?: "regular" | "symlink" | "directory" | "hardlink-to-config";
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-cleanup-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const runtimeDir = path.join(hermesHome, "runtime");
  const procRoot = path.join(tmpDir, "proc");
  const killLog = path.join(tmpDir, "kill.log");
  const scriptPath = path.join(tmpDir, "run.sh");
  const legacyPid = path.join(hermesHome, "gateway.pid");
  const runtimePid = path.join(runtimeDir, "gateway.pid");
  const runtimeLock = path.join(runtimeDir, "gateway.lock");

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(procRoot, { recursive: true });
  if (opts.lockedConfigRoot || opts.rootOwnedConfigRoot) {
    fs.chmodSync(hermesHome, 0o755);
  }
  const configYamlPath = path.join(hermesHome, "config.yaml");
  const envFilePath = path.join(hermesHome, ".env");
  if (opts.lockedConfigRoot) {
    fs.writeFileSync(configYamlPath, "model: test\n", { mode: 0o600 });
    fs.writeFileSync(envFilePath, "HERMES_TEST=1\n", { mode: 0o600 });
  }
  const historyPath = path.join(hermesHome, ".hermes_history");
  const symlinkTarget = path.join(tmpDir, "history-target");
  if (opts.preExistingHistory === "regular") {
    fs.writeFileSync(historyPath, "pre-existing\n", { mode: 0o600 });
  } else if (opts.preExistingHistory === "symlink") {
    fs.writeFileSync(symlinkTarget, "attacker\n");
    fs.symlinkSync(symlinkTarget, historyPath);
  } else if (opts.preExistingHistory === "directory") {
    fs.mkdirSync(historyPath);
  } else if (opts.preExistingHistory === "hardlink-to-config") {
    if (!opts.lockedConfigRoot) {
      throw new Error("hardlink-to-config requires lockedConfigRoot to write the target file");
    }
    fs.linkSync(configYamlPath, historyPath);
  }
  fs.symlinkSync("runtime/gateway.pid", legacyPid);
  if (opts.stalePid !== false) fs.writeFileSync(runtimePid, "999999\n");
  if (opts.staleLock !== false) fs.writeFileSync(runtimeLock, "stale lock");
  if (opts.liveGateway) {
    writeFakeProcCmdline(procRoot, 123, ["/usr/local/bin/hermes", "gateway", "run"]);
  }
  if (opts.orphanSocat) {
    writeFakeProcCmdline(procRoot, 456, [
      "socat",
      "TCP-LISTEN:8642,bind=0.0.0.0,fork,reuseaddr",
      "TCP:127.0.0.1:18642",
    ]);
  }
  if (opts.orphanDashboardSocat) {
    writeFakeProcCmdline(procRoot, 789, [
      "socat",
      "TCP-LISTEN:18789,bind=0.0.0.0,fork,reuseaddr",
      "TCP:127.0.0.1:19119",
    ]);
  }
  fs.writeFileSync(
    path.join(tmpDir, "sitecustomize.py"),
    [
      "import os",
      "",
      "# Keep the Python helper aligned with the shell fixture's mocked id -u.",
      "os.geteuid = lambda: 1000",
      "",
    ].join("\n"),
  );

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `PYTHONPATH=${shellQuote(tmpDir)}`,
      "export PYTHONPATH",
      extractShellFunctionFromSource(src, "cmdline_is_hermes_gateway"),
      extractShellFunctionFromSource(src, "has_live_hermes_gateway"),
      extractShellFunctionFromSource(src, "cleanup_orphan_socat_forwarders"),
      extractShellFunctionFromSource(src, "remove_stale_gateway_file"),
      extractShellFunctionFromSource(src, "hermes_config_path_is_locked"),
      extractShellFunctionFromSource(src, "hermes_config_root_is_locked"),
      extractShellFunctionFromSource(src, "ensure_hermes_config_root_mode"),
      extractShellFunctionFromSource(src, "ensure_hermes_state_dir"),
      extractShellFunctionFromSource(src, "ensure_hermes_history_file"),
      extractShellFunctionFromSource(src, "repair_hermes_startup_layout"),
      extractShellFunctionFromSource(src, "cleanup_stale_hermes_gateway_runtime"),
      `KILL_LOG=${shellQuote(killLog)}`,
      'kill() { printf "%s\\n" "$*" >>"$KILL_LOG"; return 0; }',
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `NEMOCLAW_PROC_ROOT=${shellQuote(procRoot)}`,
      opts.lockedConfigRoot || opts.rootOwnedConfigRoot ? LOCKED_HERMES_CONFIG_STAT_MOCK : "",
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "DASHBOARD_PUBLIC_PORT=18789",
      "DASHBOARD_INTERNAL_PORT=19119",
      "cleanup_stale_hermes_gateway_runtime",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    const legacyPidStat = lstatIfPresent(legacyPid);
    const requiredDirs = Object.fromEntries(
      ["logs", "logs/curator", "hooks", "image_cache", "audio_cache"].map((entry) => {
        const entryPath = path.join(hermesHome, entry);
        return [
          entry,
          fs.existsSync(entryPath)
            ? (fs.statSync(entryPath).mode & 0o777).toString(8)
            : "missing",
        ];
      }),
    );
    const historyStat = lstatIfPresent(historyPath);
    let historyMode = "missing";
    let historyKind: "missing" | "regular" | "symlink" | "directory" | "other" = "missing";
    let historyContent = "";
    if (historyStat) {
      historyMode = (historyStat.mode & 0o777).toString(8);
      if (historyStat.isSymbolicLink()) historyKind = "symlink";
      else if (historyStat.isDirectory()) historyKind = "directory";
      else if (historyStat.isFile()) historyKind = "regular";
      else historyKind = "other";
      if (historyKind === "regular") {
        historyContent = fs.readFileSync(historyPath, "utf-8");
      }
    }
    const symlinkTargetContent = fs.existsSync(symlinkTarget)
      ? fs.readFileSync(symlinkTarget, "utf-8")
      : "";
    const configYamlMode = fs.existsSync(configYamlPath)
      ? (fs.statSync(configYamlPath).mode & 0o777).toString(8)
      : "missing";
    const configYamlContent = fs.existsSync(configYamlPath)
      ? fs.readFileSync(configYamlPath, "utf-8")
      : "";
    return {
      result,
      killLog: fs.existsSync(killLog) ? fs.readFileSync(killLog, "utf-8") : "",
      hermesDirMode: (fs.statSync(hermesHome).mode & 0o7777).toString(8),
      requiredDirs,
      runtimePidExists: fs.existsSync(runtimePid),
      runtimeLockExists: fs.existsSync(runtimeLock),
      legacyPidExists: legacyPidStat !== null,
      legacyPidIsSymlink: legacyPidStat?.isSymbolicLink() ?? false,
      historyMode,
      historyKind,
      historyContent,
      symlinkTargetContent,
      configYamlMode,
      configYamlContent,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runRuntimeShellEnvBootstrap() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-runtime-env-"));
  const envFile = path.join(tmpDir, "nemoclaw-proxy-env.sh");
  const caFile = path.join(tmpDir, "proxy ca.pem");
  const hermesHome = path.join(tmpDir, ".hermes");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(caFile, "ca");

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { cat >"$1"; chmod 444 "$1"; }',
      `_PROXY_ENV_FILE=${shellQuote(envFile)}`,
      `_PROXY_URL=${shellQuote("http://10.200.0.1:3128")}`,
      `_NO_PROXY_VAL=${shellQuote("localhost,127.0.0.1,::1,10.200.0.1")}`,
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `SSL_CERT_FILE=${shellQuote(caFile)}`,
      "CURL_CA_BUNDLE=",
      "REQUESTS_CA_BUNDLE=",
      "GIT_SSL_CAINFO=",
      extractRuntimeShellEnvBlock(src),
      "write_runtime_shell_env",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    const envFileContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
    const envFileMode = fs.existsSync(envFile)
      ? (fs.statSync(envFile).mode & 0o777).toString(8)
      : "";
    const guardResult = spawnSync("bash", ["-c", `. ${shellQuote(envFile)}; hermes setup`], {
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

    return {
      src,
      result,
      envFileContent,
      envFileMode,
      guardResult,
      hermesHome,
      caFile,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh runtime shell env", () => {
  it("puts the Hermes configure guard in the sourced proxy env file", () => {
    const run = runRuntimeShellEnvBootstrap();
    const escapedCaFile = bashPrintfQ(run.caFile);

    expect(run.result.status).toBe(0);
    expect(run.envFileMode).toBe("444");
    expect(run.envFileContent).toContain(`export HERMES_HOME="${run.hermesHome}"`);
    expect(run.envFileContent).toContain('export HERMES_TUI_DIR="/opt/hermes/ui-tui"');
    expect(run.envFileContent).not.toContain('HERMES_TUI_DIR="${HERMES_TUI_DIR:-');
    expect(run.envFileContent).toContain(`export SSL_CERT_FILE=${escapedCaFile}`);
    expect(run.envFileContent).toContain("# nemoclaw-configure-guard begin");
    expect(run.envFileContent).toContain("hermes() {");
    expect(run.envFileContent).toContain("# nemoclaw-configure-guard end");
    expect(run.envFileContent).not.toContain(".bashrc");
    expect(run.envFileContent).not.toContain(".profile");

    expect(run.guardResult.status).toBe(1);
    expect(run.guardResult.stderr).toContain(
      "Error: 'hermes setup' cannot modify config inside the sandbox.",
    );
  });

});

describe("agents/hermes/start.sh port validation", () => {
  it("derives the dashboard port from CHAT_UI_URL while preserving API port 8642", () => {
    const run = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "https://hermes.example.test:29443",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("CHAT_UI_URL=https://hermes.example.test:29443");
    expect(run.stdout).toContain("DASHBOARD_PUBLIC_PORT=29443");
    expect(run.stdout).toContain("PUBLIC_PORT=8642");
  });

  it("rejects dashboard ports that collide with the API port during bootstrap", () => {
    const fromChatUrl = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: "http://127.0.0.1:8642",
      NEMOCLAW_DASHBOARD_PORT: undefined,
    });
    expect(fromChatUrl.status).toBe(1);
    expect(fromChatUrl.stderr).toContain("reserved for the Hermes OpenAI-compatible API");

    const invalidOverride = runHermesDashboardPortBootstrap({
      CHAT_UI_URL: undefined,
      NEMOCLAW_DASHBOARD_PORT: "not-a-port",
    });
    expect(invalidOverride.status).toBe(1);
    expect(invalidOverride.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT");
  });

  it("keeps the in-browser Hermes TUI opt-in", () => {
    const defaultArgs = runHermesDashboardArgs();
    expect(defaultArgs.status).toBe(0);
    expect(defaultArgs.stdout.split("\n")).not.toContain("--tui");

    const optInArgs = runHermesDashboardArgs("1");
    expect(optInArgs.status).toBe(0);
    expect(optInArgs.stdout.split("\n")).toContain("--tui");
  });

  it("rejects cross-collisions between API and dashboard ports", () => {
    const dashboardPublicOnApiInternal = runHermesPortValidation({
      dashboardPublicPort: 18642,
    });
    expect(dashboardPublicOnApiInternal.status).toBe(1);
    expect(dashboardPublicOnApiInternal.stderr).toContain(
      "DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT",
    );

    const dashboardInternalOnApiPublic = runHermesPortValidation({
      dashboardInternalPort: 8642,
    });
    expect(dashboardInternalOnApiPublic.status).toBe(1);
    expect(dashboardInternalOnApiPublic.stderr).toContain(
      "DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT",
    );
  });
});

describe("agents/hermes/start.sh env secret boundary", () => {
  it("allows OpenShell resolver placeholders and Slack SDK aliases", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: [
        "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        "DISCORD_BOT_TOKEN='openshell:resolve:env:DISCORD_BOT_TOKEN'",
        "SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        'SLACK_APP_TOKEN="xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN"',
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
        "EMPTY_TOKEN=",
        "LEGACY_SECRET=[STRIPPED_BY_MIGRATION]",
        "",
      ].join("\n"),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects raw secret-shaped values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesEnvSecretBoundary({
      envFile: `DEVTEST_API_TOKEN=${rawToken}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("raw secret-shaped values");
    expect(result.stderr).toContain("DEVTEST_API_TOKEN (line 1)");
    expect(result.stderr).not.toContain(rawToken);
  });

  it("rejects bare API-named raw values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesEnvSecretBoundary({
      envFile: `INTERNAL_API=${rawToken}\n`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INTERNAL_API (line 1)");
    expect(result.stderr).not.toContain(rawToken);
  });

  it("rejects credential-shaped rewrite sentinels in Hermes .env", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: "OPENAI_API_KEY=sk-OPENSHELL-PROXY-REWRITE\n",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_API_KEY (line 1)");
    expect(result.stderr).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("rejects symlinked Hermes .env files", () => {
    const result = runHermesEnvSecretBoundary({
      envFile: "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n",
      symlinkEnvFile: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is a symlink");
  });

  it("allows gateway token, nonsecret config names, and resolver placeholders in process env", () => {
    const result = runHermesRuntimeEnvSecretBoundary({
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: "18642",
      EMPTY_TOKEN: "",
      GPG_KEY: "public-build-key-fingerprint",
      LEGACY_SECRET: "[STRIPPED_BY_MIGRATION]",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_PROVIDER_KEY: "custom",
      OPENCLAW_GATEWAY_TOKEN: "raw-gateway-token",
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects raw secret-shaped process env values without printing the value", () => {
    const rawToken = "SENTINEL_RAW_SECRET_VALUE";
    const result = runHermesRuntimeEnvSecretBoundary({
      DEVTEST_API_TOKEN: rawToken,
      NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "raw-refresh-token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("process environment");
    expect(result.stderr).toContain("DEVTEST_API_TOKEN");
    expect(result.stderr).toContain("NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN");
    expect(result.stderr).not.toContain(rawToken);
    expect(result.stderr).not.toContain("raw-refresh-token");
  });
});

describe("agents/hermes/start.sh gateway runtime cleanup", () => {
  it("removes stale Hermes pid and lock files plus the legacy compatibility pid symlink", () => {
    const run = runHermesGatewayRuntimeCleanup({});

    expect(run.result.status).toBe(0);
    expect(run.runtimePidExists).toBe(false);
    expect(run.runtimeLockExists).toBe(false);
    expect(run.legacyPidExists).toBe(false);
    expect(run.legacyPidIsSymlink).toBe(false);
    expect(run.result.stderr).toContain("Removing stale Hermes runtime PID file");
    expect(run.result.stderr).toContain("Removing unsafe stale Hermes legacy PID file symlink");
    expect(run.result.stderr).toContain("Removing stale Hermes lock file");
  });

  it("repairs the Hermes v0.14 writable directory layout before launch", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      rootOwnedConfigRoot: true,
    });

    expect(run.result.status).toBe(0);
    expect(run.hermesDirMode).toBe("3770");
    expect(run.requiredDirs).toEqual({
      logs: "770",
      "logs/curator": "770",
      hooks: "770",
      image_cache: "770",
      audio_cache: "770",
    });
    expect(run.historyKind).toBe("regular");
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("");
  });

  it("preserves a pre-existing Hermes history file and re-asserts its mode", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      rootOwnedConfigRoot: true,
      preExistingHistory: "regular",
    });

    expect(run.result.status).toBe(0);
    expect(run.historyKind).toBe("regular");
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("pre-existing\n");
  });

  it("refuses to repair when the Hermes history path is a symlink and does not write through", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      rootOwnedConfigRoot: true,
      preExistingHistory: "symlink",
    });

    expect(run.historyKind).toBe("symlink");
    expect(run.symlinkTargetContent).toBe("attacker\n");
    expect(run.result.stderr).toContain(
      "Refusing Hermes layout repair because",
    );
    expect(run.result.stderr).toContain(".hermes_history is a symlink");
  });

  it("refuses to repair when the Hermes history path is a directory", () => {
    const run = runHermesGatewayRuntimeCleanup({
      staleLock: false,
      stalePid: false,
      rootOwnedConfigRoot: true,
      preExistingHistory: "directory",
    });

    expect(run.historyKind).toBe("directory");
    expect(run.result.stderr).toContain(
      "Refusing Hermes layout repair because",
    );
    expect(run.result.stderr).toContain(".hermes_history is not a regular file");
  });

  it("creates the Hermes history file under a locked config root for legacy sandboxes", () => {
    const run = runHermesGatewayRuntimeCleanup({ lockedConfigRoot: true });

    expect(run.result.status).toBe(0);
    expect(run.hermesDirMode).toBe("755");
    expect(run.requiredDirs).toEqual({
      logs: "missing",
      "logs/curator": "missing",
      hooks: "missing",
      image_cache: "missing",
      audio_cache: "missing",
    });
    expect(run.historyKind).toBe("regular");
    expect(run.historyMode).toBe("660");
    expect(run.historyContent).toBe("");
    expect(run.runtimePidExists).toBe(false);
    expect(run.runtimeLockExists).toBe(false);
    expect(run.legacyPidExists).toBe(false);
    expect(run.result.stderr).toContain(
      "Hermes layout repair limited to history file because config root is locked",
    );
  });

  it("fails Hermes startup when the locked-root history path is a symlink and does not write through", () => {
    const run = runHermesGatewayRuntimeCleanup({
      lockedConfigRoot: true,
      preExistingHistory: "symlink",
    });

    expect(run.result.status).not.toBe(0);
    expect(run.historyKind).toBe("symlink");
    expect(run.symlinkTargetContent).toBe("attacker\n");
    expect(run.result.stderr).toContain(
      "Refusing Hermes layout repair because",
    );
    expect(run.result.stderr).toContain(".hermes_history is a symlink");
  });

  it("fails Hermes startup when the locked-root history path hard-links a sealed config file", () => {
    const run = runHermesGatewayRuntimeCleanup({
      lockedConfigRoot: true,
      preExistingHistory: "hardlink-to-config",
    });

    expect(run.result.status).not.toBe(0);
    expect(run.historyKind).toBe("regular");
    expect(run.result.stderr).toContain(
      "Refusing Hermes layout repair because",
    );
    expect(run.result.stderr).toContain("has hard-link count");
    expect(run.configYamlMode).toBe("600");
    expect(run.configYamlContent).toBe("model: test\n");
  });

  it("fails Hermes startup when the locked-root history path is a directory", () => {
    const run = runHermesGatewayRuntimeCleanup({
      lockedConfigRoot: true,
      preExistingHistory: "directory",
    });

    expect(run.result.status).not.toBe(0);
    expect(run.historyKind).toBe("directory");
    expect(run.result.stderr).toContain(
      "Refusing Hermes layout repair because",
    );
    expect(run.result.stderr).toContain(".hermes_history is not a regular file");
  });

  it("kills orphaned socat forwarders when no Hermes gateway is alive", () => {
    const run = runHermesGatewayRuntimeCleanup({ orphanSocat: true, staleLock: false, stalePid: false });

    expect(run.result.status).toBe(0);
    expect(run.killLog.trim()).toBe("456");
    expect(run.result.stderr).toContain("Removing orphaned socat forwarder");
  });

  it("kills orphaned dashboard socat forwarders when no Hermes gateway is alive", () => {
    const run = runHermesGatewayRuntimeCleanup({
      orphanDashboardSocat: true,
      staleLock: false,
      stalePid: false,
    });

    expect(run.result.status).toBe(0);
    expect(run.killLog.trim()).toBe("789");
    expect(run.result.stderr).toContain("Removing orphaned dashboard socat forwarder");
  });

  it("preserves Hermes runtime state when a gateway process is alive", () => {
    const run = runHermesGatewayRuntimeCleanup({ liveGateway: true, orphanSocat: true });

    expect(run.result.status).toBe(0);
    expect(run.runtimePidExists).toBe(true);
    expect(run.runtimeLockExists).toBe(true);
    expect(run.legacyPidIsSymlink).toBe(true);
    expect(run.killLog).toBe("");
    expect(run.result.stderr).toContain("Existing Hermes gateway process detected");
  });
});

function runShieldsUpRuntimeEnv(opts: {
  locked: boolean;
  presetValue?: string;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-shields-env-"));
  const hermesHome = path.join(tmpDir, ".hermes");
  const scriptPath = path.join(tmpDir, "run.sh");

  fs.mkdirSync(hermesHome, { recursive: true });
  if (opts.locked) {
    fs.chmodSync(hermesHome, 0o755);
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "model: test\n");
    fs.writeFileSync(path.join(hermesHome, ".env"), "HERMES_TEST=1\n");
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const statMock = opts.locked ? LOCKED_HERMES_CONFIG_STAT_MOCK : "";
  const presetLine =
    opts.presetValue === undefined
      ? "unset HERMES_KANBAN_DISPATCH_IN_GATEWAY"
      : `export HERMES_KANBAN_DISPATCH_IN_GATEWAY=${shellQuote(opts.presetValue)}`;

  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      extractShellFunctionFromSource(src, "hermes_config_path_is_locked"),
      extractShellFunctionFromSource(src, "hermes_config_root_is_locked"),
      extractShellFunctionFromSource(src, "apply_shields_up_runtime_env"),
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      statMock,
      presetLine,
      "apply_shields_up_runtime_env",
      'printf "KANBAN=%s\\n" "${HERMES_KANBAN_DISPATCH_IN_GATEWAY-<unset>}"',
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
    const match = result.stdout.match(/KANBAN=(.*)/);
    return {
      result,
      kanbanValue: match ? match[1] : "",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("agents/hermes/start.sh shields-up kanban dispatcher override", () => {
  it("disables the embedded Hermes kanban dispatcher when the config root is locked", () => {
    const run = runShieldsUpRuntimeEnv({ locked: true });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("0");
    expect(run.result.stderr).toContain(
      "Shields-up: HERMES_KANBAN_DISPATCH_IN_GATEWAY=0",
    );
    expect(run.result.stderr).toContain("embedded kanban dispatcher suspended");
  });

  it("leaves the Hermes kanban dispatcher untouched when shields are down", () => {
    const run = runShieldsUpRuntimeEnv({ locked: false });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("<unset>");
    expect(run.result.stderr).not.toContain("HERMES_KANBAN_DISPATCH_IN_GATEWAY");
  });

  it("preserves a caller-supplied HERMES_KANBAN_DISPATCH_IN_GATEWAY value under shields-up", () => {
    const run = runShieldsUpRuntimeEnv({ locked: true, presetValue: "1" });

    expect(run.result.status).toBe(0);
    expect(run.kanbanValue).toBe("1");
    expect(run.result.stderr).not.toContain("HERMES_KANBAN_DISPATCH_IN_GATEWAY=0");
  });
});

describe("agents/hermes/start.sh Tirith marker bootstrap", () => {
  it("removes retryable Tirith markers before explicit command dispatch", () => {
    for (const mode of ["non-root", "root"] as const) {
      const run = runTirithExplicitCommandDispatch(mode);

      expect(run.result.status, `${mode}: ${run.result.stderr}`).toBe(0);
      expect(run.markerExists, mode).toBe(false);
      expect(run.result.stderr).toContain(
        "download_failed marker present; letting Hermes runtime fallback retry Tirith",
      );
    }
  });

  it("removes a retryable download_failed marker so Hermes runtime fallback can retry", () => {
    const run = runTirithMarkerBootstrap({ markerReason: "download_failed" });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(false);
    expect(run.result.stderr).toContain(
      "download_failed marker present; letting Hermes runtime fallback retry Tirith",
    );
  });

  it("leaves unknown marker reasons untouched", () => {
    const run = runTirithMarkerBootstrap({ markerReason: "checksum_failed" });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(true);
    expect(run.markerContent).toBe("checksum_failed");
    expect(run.result.stderr).toContain("is not retryable");
  });

  it("refuses to read or remove an unsafe symlink marker", () => {
    const run = runTirithMarkerBootstrap({
      markerReason: "download_failed",
      symlinkMarker: true,
    });

    expect(run.result.status).toBe(0);
    expect(run.markerExists).toBe(true);
    expect(run.markerIsSymlink).toBe(true);
    expect(run.targetContent).toBe("download_failed");
    expect(run.result.stderr).toContain("unsafe Tirith install marker");
  });
});
