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
      `HERMES_DASHBOARD_PUBLIC_PORT=${opts.dashboardPublicPort ?? 9119}`,
      `HERMES_DASHBOARD_INTERNAL_PORT=${opts.dashboardInternalPort ?? 19119}`,
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
      "TCP-LISTEN:9119,bind=0.0.0.0,fork,reuseaddr",
      "TCP:127.0.0.1:19119",
    ]);
  }

  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
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
      opts.lockedConfigRoot || opts.rootOwnedConfigRoot
        ? [
            'stat() {',
            '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
            '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
            '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "root:root\\n"; return 0; fi',
            '  if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ] && [ "${3:-}" = "$HERMES_DIR" ]; then printf "755\\n"; return 0; fi',
            '  case "${3:-}" in "$HERMES_DIR/config.yaml"|"$HERMES_DIR/.env")',
            '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U:%G" ]; then printf "root:root\\n"; return 0; fi',
            '    if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ]; then printf "444\\n"; return 0; fi',
            '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Su:%Sg" ]; then printf "root:root\\n"; return 0; fi',
            '    if [ "${1:-}" = "-f" ] && [ "${2:-}" = "%Lp" ]; then printf "444\\n"; return 0; fi',
            '    ;;',
            '  esac',
            '  command stat "$@"',
            '}',
          ].join("\n")
        : "",
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
      "HERMES_DASHBOARD_PUBLIC_PORT=9119",
      "HERMES_DASHBOARD_INTERNAL_PORT=19119",
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
  it("rejects cross-collisions between API and dashboard ports", () => {
    const dashboardPublicOnApiInternal = runHermesPortValidation({
      dashboardPublicPort: 18642,
    });
    expect(dashboardPublicOnApiInternal.status).toBe(1);
    expect(dashboardPublicOnApiInternal.stderr).toContain(
      "HERMES_DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT",
    );

    const dashboardInternalOnApiPublic = runHermesPortValidation({
      dashboardInternalPort: 8642,
    });
    expect(dashboardInternalOnApiPublic.status).toBe(1);
    expect(dashboardInternalOnApiPublic.stderr).toContain(
      "HERMES_DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT",
    );
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

describe("agents/hermes/start.sh Tirith marker bootstrap", () => {
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
