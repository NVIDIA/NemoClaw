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

function runHermesGatewayRuntimeCleanup(opts: {
  liveGateway?: boolean;
  orphanSocat?: boolean;
  staleLock?: boolean;
  stalePid?: boolean;
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
      extractShellFunctionFromSource(src, "cleanup_stale_hermes_gateway_runtime"),
      `KILL_LOG=${shellQuote(killLog)}`,
      'kill() { printf "%s\\n" "$*" >>"$KILL_LOG"; return 0; }',
      `HERMES_DIR=${shellQuote(hermesHome)}`,
      `NEMOCLAW_PROC_ROOT=${shellQuote(procRoot)}`,
      "PUBLIC_PORT=8642",
      "INTERNAL_PORT=18642",
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
    return {
      result,
      killLog: fs.existsSync(killLog) ? fs.readFileSync(killLog, "utf-8") : "",
      runtimePidExists: fs.existsSync(runtimePid),
      runtimeLockExists: fs.existsSync(runtimeLock),
      legacyPidIsSymlink: fs.lstatSync(legacyPid).isSymbolicLink(),
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

describe("agents/hermes/start.sh gateway runtime cleanup", () => {
  it("removes stale Hermes pid and lock files while preserving the compatibility pid symlink", () => {
    const run = runHermesGatewayRuntimeCleanup({});

    expect(run.result.status).toBe(0);
    expect(run.runtimePidExists).toBe(false);
    expect(run.runtimeLockExists).toBe(false);
    expect(run.legacyPidIsSymlink).toBe(true);
    expect(run.result.stderr).toContain("Removing stale Hermes PID file");
    expect(run.result.stderr).toContain("Removing stale Hermes lock file");
  });

  it("kills orphaned socat forwarders when no Hermes gateway is alive", () => {
    const run = runHermesGatewayRuntimeCleanup({ orphanSocat: true, staleLock: false, stalePid: false });

    expect(run.result.status).toBe(0);
    expect(run.killLog.trim()).toBe("456");
    expect(run.result.stderr).toContain("Removing orphaned socat forwarder");
  });

  it("preserves Hermes runtime state when a gateway process is alive", () => {
    const run = runHermesGatewayRuntimeCleanup({ liveGateway: true, orphanSocat: true });

    expect(run.result.status).toBe(0);
    expect(run.runtimePidExists).toBe(true);
    expect(run.runtimeLockExists).toBe(true);
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
